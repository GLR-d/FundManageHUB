"""图片生命周期：登记上传、同步引用、续签，以及延迟清理。"""

import asyncio
import logging
from collections import Counter
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core import database, oss
from core.config import Settings
from core.errors import BusinessError
from core.messages import Messages
from core.security import utcnow
from models.image_asset import ImageAsset
from repository.image_asset import ImageAssetRepository
from service.image_urls import ImageUrls, ensure_image_config

IMAGE_GRACE_PERIOD = timedelta(hours=24)
IMAGE_CLEANUP_INTERVAL = 10 * 60
IMAGE_CLEANUP_BATCH = 50
logger = logging.getLogger(__name__)


class ImageAssetService:
    def __init__(self, session: AsyncSession, settings: Settings, user_id: int):
        self.session = session
        self.settings = settings
        self.user_id = user_id
        self.repository = ImageAssetRepository(session)
        self.urls = ImageUrls(settings, user_id)

    async def register_upload(self, key: str) -> None:
        """先登记再上传；即使上传或请求中断，也能在缓冲期后回收。由调用方提交。"""
        if self.urls.object_key(f"oss://{self.settings.oss_bucket}/{key}") != key:
            raise ValueError("Invalid managed image key")
        self.session.add(ImageAsset(
            bucket=self.settings.oss_bucket, object_key=key, user_id=self.user_id,
            reference_count=0, cleanup_after=utcnow() + IMAGE_GRACE_PERIOD, deleting=False,
        ))
        await self.session.flush()

    def _references(self, values: list[str]) -> Counter[str]:
        counts: Counter[str] = Counter()
        for value in values:
            # 每个列表元素代表一条账单或一个头像，同一实体的重复图片只计一次。
            counts.update({key for part in value.split(",") if (key := self.urls.object_key(part))})
        return counts

    async def change_references(self, before: list[str], after: list[str]) -> None:
        """与账单/头像写入共用事务；这里不能单独 commit。"""
        previous, current = self._references(before), self._references(after)
        deltas = {key: current[key] - previous[key] for key in previous.keys() | current.keys()}
        deltas = {key: delta for key, delta in deltas.items() if delta}
        assets = await self.repository.lock_keys(self.settings.oss_bucket, sorted(deltas))
        now = utcnow()
        for key, delta in deltas.items():
            asset = assets.get(key)
            if delta > 0 and (asset is None or asset.user_id != self.user_id or asset.deleting):
                raise BusinessError(Messages.IMAGE_EXPIRED, 404)
            if asset is None or asset.user_id != self.user_id:
                # 未登记的历史地址只能从业务字段移除，绝不能据此删除云对象。
                continue
            count = asset.reference_count + delta
            if count < 0:
                raise RuntimeError("Image reference count is inconsistent")
            asset.reference_count = count
            asset.cleanup_after = None if count else now + IMAGE_GRACE_PERIOD

    async def refresh_url(self, url: str) -> str:
        try:
            ensure_image_config(self.settings)
        except ValueError:
            raise BusinessError(Messages.OSS_NOT_CONFIGURED, 503) from None
        key = self.urls.object_key(url)
        asset = await self.repository.get(self.settings.oss_bucket, key) if key is not None else None
        if asset is None or asset.user_id != self.user_id or asset.deleting:
            raise BusinessError(Messages.IMAGE_NOT_FOUND, 404)
        try:
            return await run_in_threadpool(oss.sign_image_url, self.settings, key)
        except Exception as error:
            logger.warning("OSS image refresh failed (%s)", oss.describe_error(error))
            raise BusinessError(Messages.OSS_REFRESH_FAILED, 502) from None


async def cleanup_expired_images(settings: Settings, limit: int = IMAGE_CLEANUP_BATCH) -> int:
    """每次最多处理一批；SDK 调用前持久化删除状态，任何失败都只能重试删除。"""
    try:
        ensure_image_config(settings)
    except ValueError:
        return 0
    deleted = 0
    for _ in range(max(0, min(limit, IMAGE_CLEANUP_BATCH))):
        async with database.async_session() as session:
            async with session.begin():
                asset = await ImageAssetRepository(session).lock_next_due(settings.oss_bucket, utcnow())
                if asset is None:
                    break
                key = asset.object_key
                asset.deleting = True
                # 同时作为失败重试的租约，避免本批反复选中同一对象或多进程重复清理。
                asset.cleanup_after = utcnow() + timedelta(seconds=IMAGE_CLEANUP_INTERVAL)
            try:
                await run_in_threadpool(oss.delete_image, settings, key)
                async with session.begin():
                    assets = await ImageAssetRepository(session).lock_keys(settings.oss_bucket, [key])
                    asset = assets.get(key)
                    if asset is not None and asset.deleting and asset.reference_count == 0:
                        await session.delete(asset)
                deleted += 1
            except Exception as error:
                # 删除成功但数据库提交失败时，也保留已提交的 deleting 状态，不再允许引用。
                await session.rollback()
                logger.warning("OSS image cleanup failed (%s)", oss.describe_error(error))
    return deleted


async def run_image_cleanup(settings: Settings) -> None:
    """应用退出时由 lifespan 取消；取消会退出会话上下文并归还连接。"""
    while True:
        try:
            await cleanup_expired_images(settings)
        except Exception as error:
            logger.warning("Image cleanup task failed (%s)", oss.describe_error(error))
        await asyncio.sleep(IMAGE_CLEANUP_INTERVAL)

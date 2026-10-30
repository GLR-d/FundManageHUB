"""图片登记、引用计数与清理任务的行锁查询。"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.image_asset import ImageAsset


class ImageAssetRepository:
    # 保存图片资产读写使用的数据库会话
    def __init__(self, session: AsyncSession):
        self.session = session

    # 按存储桶和对象键读取图片登记
    async def get(self, bucket: str, key: str) -> ImageAsset | None:
        return await self.session.get(ImageAsset, (bucket, key))

    # 按对象键顺序锁定并刷新图片资产
    async def lock_keys(self, bucket: str, keys: list[str]) -> dict[str, ImageAsset]:
        if not keys:
            return {}
        # 不同账单同时替换多张图片时，也按相同顺序取得资产锁。
        rows = await self.session.scalars(
            select(ImageAsset)
            .where(ImageAsset.bucket == bucket, ImageAsset.object_key.in_(keys))
            .order_by(ImageAsset.object_key)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return {row.object_key: row for row in rows}

    # 锁定一条到期无引用图片，跳过已锁记录
    async def lock_next_due(self, bucket: str, now: datetime) -> ImageAsset | None:
        return await self.session.scalar(
            select(ImageAsset)
            .where(
                ImageAsset.bucket == bucket,
                ImageAsset.reference_count == 0,
                ImageAsset.cleanup_after <= now,
            )
            .order_by(ImageAsset.cleanup_after, ImageAsset.object_key)
            .limit(1)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )

"""图片上传业务：校验内容，上传私有 OSS，并返回临时访问地址。"""

import logging
from io import BytesIO
from typing import BinaryIO
from uuid import uuid4

from PIL import Image, UnidentifiedImageError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core import oss
from core.config import Settings
from core.errors import BusinessError
from core.messages import Messages
from service.image_asset import ImageAssetService
from service.image_urls import ensure_image_config

MAX_UPLOAD_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)


class UploadService:
    """账单和头像共用的 OSS 图片上传服务。"""

    def __init__(self, session: AsyncSession, settings: Settings, user_id: int):
        self.session = session
        self.settings = settings
        self.user_id = user_id

    async def upload_image(self, file: BinaryIO) -> str:
        """先持久登记再上传，用户未保存或请求取消的图片同样可以回收。"""
        key, content, content_type = await run_in_threadpool(self._prepare_image, file)
        await ImageAssetService(self.session, self.settings, self.user_id).register_upload(key)
        await self.session.commit()
        return await run_in_threadpool(self._save_image, key, content, content_type)

    def _prepare_image(self, file: BinaryIO) -> tuple[str, bytes, str]:
        """配置和图片校验失败时，不向登记表或 OSS 写入数据。"""
        try:
            ensure_image_config(self.settings)
        except ValueError:
            raise BusinessError(Messages.OSS_NOT_CONFIGURED, 503) from None
        # 最多多读 1 字节即可判断是否超限，避免把大文件全部读入内存。
        content = file.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            raise BusinessError(Messages.UPLOAD_TOO_LARGE)

        try:
            # 根据文件内容识别并校验真实图片，不能只相信文件扩展名或请求类型。
            with Image.open(BytesIO(content)) as image:
                suffix = {"JPEG": ".jpg", "PNG": ".png"}.get(image.format)
                if suffix is None:
                    raise BusinessError(Messages.INVALID_UPLOAD_IMAGE)
                image.verify()
        except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
            raise BusinessError(Messages.INVALID_UPLOAD_IMAGE)

        # 随机文件名避免同名覆盖，也避免把用户提供的路径直接用于文件保存。
        key = f"images/{self.user_id}/{uuid4().hex}{suffix}"
        content_type = "image/jpeg" if suffix == ".jpg" else "image/png"
        return key, content, content_type

    def _save_image(self, key: str, content: bytes, content_type: str) -> str:
        try:
            # 先确认可以生成访问链接；OSS 对象继承 Bucket 权限，不设置公共读。
            url = oss.sign_image_url(self.settings, key)
            oss.put_image(self.settings, key, content, content_type)
        except Exception as error:
            # SDK 外层 OperationError 会隐藏真实错误码；摘要仍排除链接和凭据。
            logger.warning("OSS image upload failed (%s)", oss.describe_error(error))
            raise BusinessError(Messages.OSS_UPLOAD_FAILED, 502) from None
        return url

"""私有图片地址：数据库保存对象标识，响应时生成临时访问链接。"""

import logging
import re
from urllib.parse import unquote, urlsplit

from starlette.concurrency import run_in_threadpool

from core import oss
from core.config import Settings

logger = logging.getLogger(__name__)


# 校验图片存储及签名域名配置
def ensure_image_config(settings: Settings) -> None:
    oss.image_endpoint(settings)


class ImageUrls:
    # 保存配置并限定当前用户的图片对象名
    def __init__(self, settings: Settings, user_id: int):
        self.settings = settings
        self.key_pattern = re.compile(rf"images/{user_id}/[a-f0-9]{{32}}\.(?:jpg|png)")

    # 识别属于当前用户和Bucket的图片对象键
    def object_key(self, value: str) -> str | None:
        """只识别本 Bucket、本用户及后端生成的对象名，不能替别人续签。"""
        try:
            parsed = urlsplit(value)
            if parsed.scheme == "oss":
                if parsed.netloc != self.settings.oss_bucket or parsed.query or parsed.fragment:
                    return None
            elif parsed.scheme == "https":
                endpoint = self.settings.oss_endpoint
                endpoint = urlsplit(endpoint if "://" in endpoint else "https://" + endpoint)
                host = endpoint.hostname if self.settings.oss_use_cname else f"{self.settings.oss_bucket}.{endpoint.hostname}"
                allowed_hosts = {host}
                if self.settings.oss_public_base_url:
                    allowed_hosts.add(urlsplit(self.settings.oss_public_base_url).hostname)
                if (
                    parsed.hostname not in allowed_hosts or parsed.port not in (None, 443)
                    or parsed.username is not None or parsed.password is not None
                ):
                    return None
            else:
                return None
            key = unquote(parsed.path.removeprefix("/"))
            return key if self.key_pattern.fullmatch(key) else None
        except ValueError:
            return None

    # 将系统图片签名链接转换为永久对象标识
    def stored(self, value: str) -> str:
        """去掉本系统签名和有效期；旧本地地址、外链保持原样。"""
        return ",".join(
            f"oss://{self.settings.oss_bucket}/{key}" if (key := self.object_key(part)) else part
            for part in value.split(",")
        )

    # 为单条图片字段生成临时访问链接
    async def display(self, value: str) -> str:
        return (await self.display_many([value]))[0]

    # 筛选系统图片后在线程池批量生成链接
    async def display_many(self, values: list[str]) -> list[str]:
        if not any(self.object_key(part) for value in values for part in value.split(",")):
            return values
        return await run_in_threadpool(self._display_many, values)

    # 批量签名图片并缓存重复图片的处理结果
    def _display_many(self, values: list[str]) -> list[str]:
        # 同一批结果的相同图片只签名一次，签名失败也不能使登录或账单查询失败。
        try:
            ensure_image_config(self.settings)
        except ValueError:
            return values
        cache: dict[str, str | None] = {}

        # 签名单张系统图片并在失败时保留原值
        def display_part(part: str) -> str:
            key = self.object_key(part)
            if key is None:
                return part
            if key not in cache:
                try:
                    cache[key] = oss.sign_image_url(self.settings, key)
                except Exception as error:
                    logger.warning("OSS image signing failed (%s)", oss.describe_error(error))
                    cache[key] = None
            return cache[key] if cache[key] is not None else part

        return [",".join(display_part(part) for part in value.split(",")) for value in values]

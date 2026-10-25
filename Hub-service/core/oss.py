"""OSS 对象上传和私有图片临时签名，不修改访问权限。"""

import re
from datetime import timedelta
from urllib.parse import urlsplit

import alibabacloud_oss_v2 as oss

from core.config import Settings

MANAGED_IMAGE_KEY = re.compile(r"images/([1-9][0-9]*)/[a-f0-9]{32}\.(?:jpg|png)")


def describe_error(error: BaseException) -> str:
    """只记录异常类型和 OSS 诊断编号，不能格式化含链接、密钥的异常正文。"""
    chain: list[str] = []
    details: dict[str, str | int] = {}
    seen: set[int] = set()
    current: BaseException | None = error
    for _ in range(8):
        if not isinstance(current, BaseException) or id(current) in seen:
            break
        seen.add(id(current))
        name = type(current).__name__
        chain.append(name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", name) else "Exception")
        if isinstance(current, oss.exceptions.ServiceError):
            status = current.status_code
            if type(status) is int and 100 <= status <= 599:
                details["status"] = status
            for field, pattern in (
                ("code", r"[A-Za-z][A-Za-z0-9_]{0,63}"),
                ("request_id", r"[A-Za-z0-9][A-Za-z0-9-]{0,127}"),
                ("ec", r"[A-Za-z0-9][A-Za-z0-9-]{0,63}"),
            ):
                value = getattr(current, field, None)
                if isinstance(value, str) and re.fullmatch(pattern, value):
                    details[field] = value
        nested = None
        if isinstance(current, (oss.exceptions.OperationError, oss.exceptions.RequestError, oss.exceptions.ResponseError)):
            try:
                nested = current.unwrap()
            except Exception:
                pass
        current = nested if isinstance(nested, BaseException) else current.__cause__ or current.__context__
    summary = " -> ".join(chain)
    return summary + (" (" + ", ".join(f"{name}={value}" for name, value in details.items()) + ")" if details else "")


def _endpoint_url(endpoint: str) -> str:
    """允许填写 OSS 域名或 HTTPS 地址；拒绝路径和携带凭据的 URL。"""
    url = endpoint if "://" in endpoint else "https://" + endpoint
    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme == "https" and parsed.hostname
            and re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", parsed.hostname)
            and parsed.port in (None, 443)
            and parsed.username is None and parsed.password is None
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment
            and not any(character.isspace() for character in url)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("OSS_ENDPOINT 必须是有效的 HTTPS 服务地址")
    return url.rstrip("/")


def ensure_oss_config(settings: Settings) -> None:
    """延迟到上传时校验配置，未配置 OSS 不影响其他接口和应用启动。"""
    if not all((
        settings.oss_endpoint, settings.oss_region, settings.oss_bucket,
        settings.oss_access_key_id, settings.oss_access_key_secret,
    )):
        raise ValueError("请配置 OSS_ENDPOINT、OSS_REGION、OSS_BUCKET 和 OSS 访问凭据")
    _endpoint_url(settings.oss_endpoint)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", settings.oss_region):
        raise ValueError("OSS_REGION 格式不正确")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", settings.oss_bucket):
        raise ValueError("OSS_BUCKET 格式不正确")


def put_image(settings: Settings, key: str, content: bytes, content_type: str) -> None:
    """同步上传交给业务层在线程池调用，连接在成功或失败后都会关闭。"""
    ensure_oss_config(settings)
    # 同步 SDK 的 Client 没有 close；显式持有并关闭其 HTTP 连接池。
    transport = oss.transport.RequestsHttpClient(connect_timeout=5, readwrite_timeout=10)
    try:
        config = oss.config.Config(
            region=settings.oss_region,
            endpoint=_endpoint_url(settings.oss_endpoint),
            credentials_provider=oss.credentials.StaticCredentialsProvider(
                access_key_id=settings.oss_access_key_id,
                access_key_secret=settings.oss_access_key_secret,
            ),
            http_client=transport,
            connect_timeout=5,
            readwrite_timeout=10,
            retry_max_attempts=2,
            use_cname=settings.oss_use_cname,
        )
        result = oss.Client(config).put_object(oss.PutObjectRequest(
            bucket=settings.oss_bucket, key=key, body=content, content_type=content_type,
        ))
        if result.status_code != 200:
            raise RuntimeError("OSS 图片上传失败")
    finally:
        transport.close()


def sign_image_url(settings: Settings, key: str) -> str:
    """本地生成一小时有效的私有图片地址，不向 OSS 发送请求。"""
    ensure_oss_config(settings)
    # 图片自定义域名必须是 origin，不能带路径，否则会导致签名路径不一致。
    endpoint = _endpoint_url(settings.oss_public_base_url or settings.oss_endpoint)
    transport = oss.transport.RequestsHttpClient(connect_timeout=5, readwrite_timeout=10)
    try:
        config = oss.config.Config(
            region=settings.oss_region,
            endpoint=endpoint,
            credentials_provider=oss.credentials.StaticCredentialsProvider(
                access_key_id=settings.oss_access_key_id,
                access_key_secret=settings.oss_access_key_secret,
            ),
            http_client=transport,
            use_cname=bool(settings.oss_public_base_url) or settings.oss_use_cname,
        )
        return oss.Client(config).presign(
            oss.GetObjectRequest(bucket=settings.oss_bucket, key=key),
            expires=timedelta(hours=1),
        ).url
    finally:
        transport.close()


def delete_image(settings: Settings, key: str) -> None:
    """仅删除本系统固定命名的图片；不接受 URL、任意路径或更改 Bucket 权限。"""
    if not MANAGED_IMAGE_KEY.fullmatch(key):
        raise ValueError("Invalid managed image key")
    ensure_oss_config(settings)
    transport = oss.transport.RequestsHttpClient(connect_timeout=5, readwrite_timeout=10)
    try:
        config = oss.config.Config(
            region=settings.oss_region,
            endpoint=_endpoint_url(settings.oss_endpoint),
            credentials_provider=oss.credentials.StaticCredentialsProvider(
                access_key_id=settings.oss_access_key_id,
                access_key_secret=settings.oss_access_key_secret,
            ),
            http_client=transport,
            connect_timeout=5,
            readwrite_timeout=10,
            retry_max_attempts=2,
            use_cname=settings.oss_use_cname,
        )
        result = oss.Client(config).delete_object(oss.DeleteObjectRequest(bucket=settings.oss_bucket, key=key))
        if result.status_code not in (200, 204):
            raise RuntimeError("OSS 图片删除失败")
    finally:
        transport.close()


def list_image_keys(settings: Settings) -> list[str]:
    """迁移可选的只读盘点，分页读取 images/；不修改或删除任何对象。"""
    ensure_oss_config(settings)
    transport = oss.transport.RequestsHttpClient(connect_timeout=5, readwrite_timeout=10)
    try:
        config = oss.config.Config(
            region=settings.oss_region,
            endpoint=_endpoint_url(settings.oss_endpoint),
            credentials_provider=oss.credentials.StaticCredentialsProvider(
                access_key_id=settings.oss_access_key_id,
                access_key_secret=settings.oss_access_key_secret,
            ),
            http_client=transport,
            connect_timeout=5,
            readwrite_timeout=10,
            retry_max_attempts=2,
            use_cname=settings.oss_use_cname,
        )
        client = oss.Client(config)
        keys: list[str] = []
        token = None
        while True:
            result = client.list_objects_v2(oss.ListObjectsV2Request(
                bucket=settings.oss_bucket, prefix="images/", max_keys=1000, continuation_token=token,
            ))
            if result.status_code != 200:
                raise RuntimeError("OSS 图片盘点失败")
            keys.extend(item.key for item in result.contents or [] if item.key and MANAGED_IMAGE_KEY.fullmatch(item.key))
            if not result.is_truncated:
                return keys
            next_token = result.next_continuation_token
            if not next_token or next_token == token:
                raise RuntimeError("OSS 图片盘点缺少后续分页标识")
            token = next_token
    finally:
        transport.close()

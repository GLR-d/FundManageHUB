"""从项目 .env 和系统环境变量读取配置。"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SESSION_TTL = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class Settings:
    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_user: str = "root"
    mysql_password: str = field(default="", repr=False)
    mysql_database: str = "managehub"
    cookie_secure: bool = False
    captcha_ttl: int = 300
    session_ttl: int = DEFAULT_SESSION_TTL
    jwt_secret_key: str = field(default="", repr=False)
    jwt_issuer: str = "managehub"
    jwt_audience: str = "managehub-api"
    redis_url: str = field(default="redis://127.0.0.1:6379/0", repr=False)
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_use_ssl: bool = True
    smtp_username: str = field(default="", repr=False)
    smtp_password: str = field(default="", repr=False)
    mail_from: str = ""
    oss_endpoint: str = ""
    oss_region: str = ""
    oss_bucket: str = ""
    oss_access_key_id: str = field(default="", repr=False)
    oss_access_key_secret: str = field(default="", repr=False)
    oss_public_base_url: str = ""
    oss_use_cname: bool = False

    def __post_init__(self):
        if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", self.mysql_database):
            raise ValueError("数据库名只能包含字母、数字或下划线，长度不超过 64")
        if not 1 <= self.mysql_port <= 65535:
            raise ValueError("MySQL 端口必须在 1 至 65535 之间")
        if len(self.jwt_secret_key.encode("utf-8")) < 32 or self.jwt_secret_key == "CHANGE_ME":
            raise ValueError("JWT_SECRET_KEY 必须是至少 32 字节的随机密钥")
        if self.session_ttl <= 0:
            raise ValueError("SESSION_TTL 必须大于 0")


def get_settings() -> Settings:
    values = {**dotenv_values(PROJECT_ROOT / ".env"), **os.environ}
    password = values.get("MYSQL_PASSWORD")
    if password is None or password == "CHANGE_ME":
        raise RuntimeError("请在项目 .env 或环境变量中设置 MYSQL_PASSWORD")
    jwt_secret = values.get("JWT_SECRET_KEY")
    if not jwt_secret:
        raise RuntimeError("请在项目 .env 或环境变量中设置 JWT_SECRET_KEY")
    try:
        smtp_port = int(values.get("SMTP_PORT") or "465")
    except (ValueError, TypeError):
        # 邮件配置错误只影响邮件接口，由 ensure_mail_config 返回通用错误。
        smtp_port = 0
    return Settings(
        mysql_host=values.get("MYSQL_HOST", "127.0.0.1"),
        mysql_port=int(values.get("MYSQL_PORT", "3306")),
        mysql_user=values.get("MYSQL_USER", "root"),
        mysql_password=password,
        mysql_database=values.get("MYSQL_DATABASE", "managehub"),
        redis_url=values.get("REDIS_URL", "redis://127.0.0.1:6379/0"),
        cookie_secure=values.get("COOKIE_SECURE", "false").lower() == "true",
        session_ttl=int(values.get("SESSION_TTL", str(DEFAULT_SESSION_TTL))),
        jwt_secret_key=jwt_secret,
        jwt_issuer=values.get("JWT_ISSUER", "managehub"),
        jwt_audience=values.get("JWT_AUDIENCE", "managehub-api"),
        smtp_host=values.get("SMTP_HOST", ""),
        smtp_port=smtp_port,
        smtp_use_ssl=(values.get("SMTP_USE_SSL") or "true").lower() == "true",
        smtp_username=values.get("SMTP_USERNAME", ""),
        smtp_password=values.get("SMTP_PASSWORD", ""),
        mail_from=values.get("MAIL_FROM", ""),
        oss_endpoint=(values.get("OSS_ENDPOINT") or "").strip(),
        oss_region=(values.get("OSS_REGION") or "").strip(),
        oss_bucket=(values.get("OSS_BUCKET") or "").strip(),
        oss_access_key_id=(values.get("OSS_ACCESS_KEY_ID") or "").strip(),
        oss_access_key_secret=(values.get("OSS_ACCESS_KEY_SECRET") or "").strip(),
        oss_public_base_url=(values.get("OSS_PUBLIC_BASE_URL") or "").strip().rstrip("/"),
        oss_use_cname=(values.get("OSS_USE_CNAME") or "false").strip().lower() == "true",
    )

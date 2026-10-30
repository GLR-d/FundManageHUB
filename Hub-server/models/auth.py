"""可撤销的登录会话和浏览器绑定验证码。"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, text
from sqlalchemy.dialects.mysql import BIGINT, CHAR, INTEGER, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        Index("idx_sessions_user_id", "user_id"),
        Index("idx_sessions_expires_at", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    token_hash: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", name="fk_sessions_user"),
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=text("CURRENT_TIMESTAMP"))


class AuthCaptcha(Base):
    __tablename__ = "auth_captchas"
    __table_args__ = (
        Index("idx_captchas_expires_at", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    uuid: Mapped[str] = mapped_column(CHAR(36, charset="ascii", collation="ascii_bin"), primary_key=True)
    browser_token_hash: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"))
    code_hash: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"))
    attempt_count: Mapped[int] = mapped_column(INTEGER(unsigned=True), server_default=text("0"))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=text("CURRENT_TIMESTAMP"))


class AuthEmailRateLimit(Base):
    """按 IP 和目标邮箱限制邮件请求，不依赖进程内内存或 Redis。"""

    __tablename__ = "auth_email_rate_limits"
    __table_args__ = (
        Index("idx_email_rates_window", "window_start"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    hash_key: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime)
    count: Mapped[int] = mapped_column(INTEGER(unsigned=True), server_default=text("0"))


class AuthEmailCode(Base):
    """注册、换绑和找回密码共用验证码；注册尚无用户编号，允许 NULL。"""

    __tablename__ = "auth_email_codes"
    __table_args__ = (
        Index("idx_email_codes_user_purpose", "user_id", "purpose"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    hash_key: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"), primary_key=True)
    user_id: Mapped[int | None] = mapped_column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", name="fk_email_codes_user"))
    purpose: Mapped[str] = mapped_column(VARCHAR(16))
    email: Mapped[str] = mapped_column(VARCHAR(254))
    code_hash: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"))
    state_hash: Mapped[str] = mapped_column(CHAR(64, charset="ascii", collation="ascii_bin"))
    attempt_count: Mapped[int] = mapped_column(INTEGER(unsigned=True), server_default=text("0"))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime)

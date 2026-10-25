"""用户账号和资料；字段与现有 users 表保持一致。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, FetchedValue, UniqueConstraint, text
from sqlalchemy.dialects.mysql import BIGINT, INTEGER, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[int] = mapped_column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    password_hash: Mapped[str] = mapped_column(VARCHAR(255))
    name: Mapped[str] = mapped_column(VARCHAR(50))
    avatar: Mapped[str] = mapped_column(VARCHAR(1024), server_default="")
    phone: Mapped[str] = mapped_column(VARCHAR(20), server_default="")
    email: Mapped[str] = mapped_column(VARCHAR(254))
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("TRUE"))
    login_failures: Mapped[int] = mapped_column(INTEGER(unsigned=True), server_default=text("0"))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        server_onupdate=FetchedValue(),
    )

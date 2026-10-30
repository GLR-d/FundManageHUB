"""登记本系统上传的图片；引用与业务数据在同一事务内修改。"""

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, text
from sqlalchemy.dialects.mysql import BIGINT, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class ImageAsset(Base):
    __tablename__ = "image_assets"
    __table_args__ = (
        CheckConstraint("reference_count >= 0", name="chk_image_assets_reference_count"),
        Index("idx_image_assets_cleanup", "bucket", "reference_count", "cleanup_after"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_bin"},
    )

    bucket: Mapped[str] = mapped_column(VARCHAR(63), primary_key=True)
    object_key: Mapped[str] = mapped_column(VARCHAR(128), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", name="fk_image_assets_user"),
    )
    reference_count: Mapped[int] = mapped_column(BIGINT(unsigned=True), server_default=text("0"))
    cleanup_after: Mapped[datetime | None] = mapped_column(DateTime)
    deleting: Mapped[bool] = mapped_column(Boolean, server_default=text("FALSE"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=text("CURRENT_TIMESTAMP"))

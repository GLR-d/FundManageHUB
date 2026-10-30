"""账单模型；金额继续使用 MySQL DECIMAL。"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index
from sqlalchemy.dialects.mysql import BIGINT, DECIMAL, TEXT, TINYINT, VARCHAR
from sqlalchemy.orm import Mapped, mapped_column

from core.fund_types import FUND_TYPE_CHECK
from models.base import Base


class Fund(Base):
    __tablename__ = "funds"
    __table_args__ = (
        Index("idx_funds_user_time", "user_id", "time"),
        CheckConstraint(FUND_TYPE_CHECK, name="chk_funds_type"),
        CheckConstraint("amount BETWEEN 0 AND 90071992547409.91", name="chk_funds_amount"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    id: Mapped[int] = mapped_column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", name="fk_funds_user"),
    )
    time: Mapped[datetime] = mapped_column(DateTime)
    type: Mapped[int] = mapped_column(TINYINT(unsigned=True))
    amount: Mapped[Decimal] = mapped_column(DECIMAL(16, 2))
    remark: Mapped[str] = mapped_column(VARCHAR(50), server_default="")
    photo: Mapped[str] = mapped_column(TEXT)

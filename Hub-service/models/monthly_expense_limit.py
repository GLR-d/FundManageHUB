"""每个账号的每月通用支出限额；金额精确到分。"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, text
from sqlalchemy.dialects.mysql import BIGINT, DECIMAL
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class MonthlyExpenseLimit(Base):
    __tablename__ = "monthly_expense_limits"
    __table_args__ = (
        CheckConstraint("amount > 0 AND amount <= 90071992547409.91", name="chk_monthly_expense_limit_amount"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )

    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE", name="fk_monthly_expense_limit_user"),
        primary_key=True,
    )
    amount: Mapped[Decimal] = mapped_column(DECIMAL(16, 2))
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=text("CURRENT_TIMESTAMP"))

"""月支出限额请求；JSON 金额仅使用字符串以避免浮点精度损失。"""

import re
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_validator

from core.messages import Messages

MAX_MONTHLY_LIMIT = Decimal("90071992547409.91")


class MonthlyLimitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: str | None

    @field_validator("amount", mode="before")
    @classmethod
    def valid_amount(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,14}(?:\.[0-9]{1,2})?", value):
            raise ValueError(Messages.INVALID_MONTHLY_LIMIT)
        amount = Decimal(value)
        if not 0 < amount <= MAX_MONTHLY_LIMIT:
            raise ValueError(Messages.INVALID_MONTHLY_LIMIT)
        return format(amount, ".2f")

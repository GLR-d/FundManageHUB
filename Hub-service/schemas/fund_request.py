"""前端提交的账单表单和分页游标，负责字段校验。"""

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from core.fund_types import FUND_TYPES
from core.messages import Messages


# 前端用 JavaScript 数字处理编号和“分”，因此限制在安全整数范围内。
MAX_FUND_ID = 9_007_199_254_740_991
MAX_FUND_AMOUNT = Decimal("90071992547409.91")


class FundRequest(BaseModel):
    """新增账单的请求；拒绝额外字段，避免客户端自行指定所属用户。"""

    model_config = ConfigDict(extra="forbid")

    time: datetime
    type: int = Field(ge=0, le=len(FUND_TYPES) - 1)
    amount: Decimal = Field(ge=0, le=MAX_FUND_AMOUNT, decimal_places=2)
    remark: str = Field(default="", max_length=50)
    photo: str = Field(default="", max_length=8192)

    @field_validator("time")
    @classmethod
    def local_time(cls, value: datetime) -> datetime:
        # 账单保存用户选择的本地时间，不进行时区换算。
        if value.tzinfo is not None or value.year < 1000:
            raise ValueError(Messages.INVALID_FUND_TIME)
        return value.replace(microsecond=0)


class FundUpdateRequest(FundRequest):
    """修改账单时，额外提供要修改的编号。"""

    id: int = Field(gt=0, le=MAX_FUND_ID)


def parse_day_cursor(value: Any) -> date:
    """分页游标只接受完整日期，拒绝时间戳或带时间的字符串。"""
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError(Messages.INVALID_FUND_CURSOR)
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError(Messages.INVALID_FUND_CURSOR) from None


FundCursor = Annotated[date, BeforeValidator(parse_day_cursor)]

"""月支出限额响应；JSON 金额使用字符串。"""

from pydantic import BaseModel


class MonthlyLimitResponse(BaseModel):
    amount: str | None

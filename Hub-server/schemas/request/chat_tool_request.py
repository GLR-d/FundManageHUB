"""聊天查询工具的参数；用户身份由运行时注入，不接受模型指定。"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from core.fund_types import FUND_TYPE_CODES, FUND_TYPES
from schemas.request.dashboard_request import DashboardMonth
from schemas.request.fund_request import MAX_FUND_AMOUNT, parse_day_cursor

ToolAmount = Annotated[
    Decimal,
    Field(ge=0, le=MAX_FUND_AMOUNT, decimal_places=2, allow_inf_nan=False),
]


class BillSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_date: date | None = Field(None, description="开始日期 YYYY-MM-DD，包含当天；省略则不限制下界")
    end_date: date | None = Field(None, description="结束日期 YYYY-MM-DD，包含当天；省略则不限制上界")
    category: str | None = Field(None, description="账单类别名称或编号：" + "、".join(f"{index}={name}" for index, name in enumerate(FUND_TYPES)))
    keyword: str | None = Field(None, max_length=50, description="账单备注中的字面关键词，不是 SQL 通配符")
    min_amount: ToolAmount | None = Field(None, description="金额下限，包含等于，单位元")
    max_amount: ToolAmount | None = Field(None, description="金额上限，包含等于，单位元")
    limit: int = Field(20, ge=1, le=50, strict=True, description="本次最多返回的账单笔数，最多 50")
    offset: int = Field(0, ge=0, le=10000, strict=True, description="跳过的匹配账单笔数；更多结果使用 next_offset，超过 10000 时缩小查询范围")

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def valid_date(cls, value: object) -> date | None:
        if value is None:
            return None
        # 工具执行前已经解析的 date 可以再次校验，datetime 则不能当作日期。
        parsed = value if type(value) is date else parse_day_cursor(value)
        if parsed.year < 1000:
            raise ValueError("账单日期年份必须在 1000 至 9999 之间")
        return parsed

    @field_validator("category", mode="before")
    @classmethod
    def valid_category(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("类别应填写名称或编号字符串")
        value = value.strip()
        if not value:
            return None
        if value in FUND_TYPES:
            return str(FUND_TYPES.index(value))
        if value in FUND_TYPE_CODES:
            return value
        raise ValueError("未知账单类别，可选：" + "、".join(FUND_TYPES))

    @field_validator("keyword", mode="before")
    @classmethod
    def clean_keyword(cls, value: object) -> object:
        return value.strip() or None if isinstance(value, str) else value

    @model_validator(mode="after")
    def valid_ranges(self) -> Self:
        if self.start_date is not None and self.end_date is not None and self.start_date > self.end_date:
            raise ValueError("开始日期不能晚于结束日期")
        if self.min_amount is not None and self.max_amount is not None and self.min_amount > self.max_amount:
            raise ValueError("金额下限不能大于上限")
        return self


class MonthToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    month: DashboardMonth | None = Field(None, description="统计月份 YYYY-MM；省略时使用北京时间本月")


class CategoryRankingRequest(MonthToolRequest):
    top_n: int = Field(5, ge=1, le=len(FUND_TYPES), strict=True, description="最多返回的支出类别数量，按支出金额降序")

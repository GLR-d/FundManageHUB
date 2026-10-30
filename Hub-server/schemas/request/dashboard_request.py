"""首页统计的严格月份参数。"""

import re
from datetime import date
from typing import Annotated

from pydantic import BeforeValidator

from core.messages import Messages


def parse_dashboard_month(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}", value):
        raise ValueError(Messages.INVALID_DASHBOARD_MONTH_FORMAT)
    year, month = map(int, value.split("-"))
    try:
        date(year, month, 1)
    except ValueError:
        raise ValueError(Messages.INVALID_DASHBOARD_MONTH) from None
    # MySQL DATETIME 和账单表单使用 1000 至 9999 年。
    if year < 1000:
        raise ValueError(Messages.INVALID_DASHBOARD_MONTH_YEAR)
    return value


DashboardMonth = Annotated[str, BeforeValidator(parse_dashboard_month)]

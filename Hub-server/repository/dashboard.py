"""读取当前用户指定月份的账单，不读取其他用户的数据。"""

from datetime import date
from typing import Any

from sqlalchemy import Date, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.fund import Fund


class DashboardRepository:
    # 保存统计查询使用的数据库会话
    def __init__(self, session: AsyncSession):
        self.session = session

    # 读取用户指定月份的账单类别与金额
    async def get_month_funds(self, user_id: int, start: date, end: date) -> list[dict[str, Any]]:
        # 保留给聊天工具的本月汇总使用，首页统计无需读取单笔账单。
        result = await self.session.execute(
            select(Fund.type, Fund.amount)
            .where(Fund.user_id == user_id, Fund.time >= start, Fund.time < end)
            .order_by(Fund.time.desc(), Fund.id.desc())
        )
        records = result.mappings().all()
        return [dict(record) for record in records]

    # 按日期和类别汇总用户账单金额
    async def get_daily_totals(self, user_id: int, start: date, end: date | None) -> list[dict[str, Any]]:
        day = func.date(Fund.time, type_=Date)
        statement = (
            select(day.label("date"), Fund.type, func.sum(Fund.amount).label("amount"))
            .where(Fund.user_id == user_id, Fund.time >= start)
            .group_by(day, Fund.type)
            .order_by(day)
        )
        # 9999 年 12 月没有可表示的下月月初；数据库日期最大值已是该月末。
        if end is not None:
            statement = statement.where(Fund.time < end)
        result = await self.session.execute(statement)
        return [dict(record) for record in result.mappings().all()]

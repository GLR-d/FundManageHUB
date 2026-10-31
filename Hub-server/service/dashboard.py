"""按北京时间确定本月范围，并保持账单金额精确到分。"""

from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from core.fund_types import INCOME_TYPES
from utils.security import utcnow
from repository.dashboard import DashboardRepository
from schemas.response.dashboard_response import CategoryExpense, DailyExpense, DashboardStatistics, MonthlyExpense


class DashboardService:
    # 初始化首页统计使用的数据仓储
    def __init__(self, session: AsyncSession):
        self.repository = DashboardRepository(session)

    # 查询北京时间本月的账单明细
    async def get_month_funds(self, user_id: int) -> list[dict[str, str]]:
        # 聊天工具仍复用本月账单查询；首页接口使用下方的聚合统计。
        today = (utcnow() + timedelta(hours=8)).date()
        start_of_month = today.replace(day=1)
        # 从月初前进 32 天一定会进入下个月，再将日期设为 1。
        start_of_next_month = (start_of_month + timedelta(days=32)).replace(day=1)
        rows = await self.repository.get_month_funds(user_id, start_of_month, start_of_next_month)
        return [{"type": str(row["type"]), "amount": format(row["amount"], ".2f")} for row in rows]

    # 汇总月度收支及每日分类和历史趋势
    async def get_statistics(self, user_id: int, month: str | None = None) -> DashboardStatistics:
        if month is None:
            today = (utcnow() + timedelta(hours=8)).date()
            start = today.replace(day=1)
        else:
            year, number = map(int, month.split("-"))
            start = date(year, number, 1)
        month_label = f"{start.year:04d}-{start.month:02d}"
        # 对统计月份之前的完整自然月做比较，跨年和闰年使用日期运算。
        previous_start = (start - timedelta(days=1)).replace(day=1)
        # 月份序号跨年相减；数据库下界不足十二个月时从 1000 年一月开始。
        month_index = start.year * 12 + start.month - 1
        first_month_index = max(1000 * 12, month_index - 11)
        monthly = {
            date(index // 12, index % 12 + 1, 1): Decimal("0.00")
            for index in range(first_month_index, month_index + 1)
        }
        history_start = next(iter(monthly))
        end = None if start.year == 9999 and start.month == 12 else (
            date(start.year + 1, 1, 1) if start.month == 12 else date(start.year, start.month + 1, 1)
        )
        totals = await self.repository.get_daily_totals(user_id, history_start, end)
        income = Decimal("0.00")
        expense = Decimal("0.00")
        categories: dict[int, Decimal] = {}
        daily = {
            date(start.year, start.month, day): Decimal("0.00")
            for day in range(1, monthrange(start.year, start.month)[1] + 1)
        }
        for row in totals:
            day = row["date"]
            amount = row["amount"]
            is_income = str(row["type"]) in INCOME_TYPES
            if not is_income:
                monthly[day.replace(day=1)] += amount
            if day < start:
                continue
            if is_income:
                income += amount
            else:
                expense += amount
                daily[day] += amount
                categories[row["type"]] = categories.get(row["type"], Decimal("0.00")) + amount
        return DashboardStatistics(
            month=month_label,
            income=format(income, ".2f"),
            expense=format(expense, ".2f"),
            previousMonthExpense=format(monthly.get(previous_start, Decimal("0.00")), ".2f"),
            dailyExpenses=[DailyExpense(date=day.isoformat(), amount=format(amount, ".2f")) for day, amount in daily.items()],
            categoryExpenses=[
                CategoryExpense(type=str(kind), amount=format(amount, ".2f"))
                for kind, amount in sorted(categories.items()) if amount > 0
            ],
            monthlyExpenses=[
                MonthlyExpense(month=f"{day.year:04d}-{day.month:02d}", amount=format(amount, ".2f"))
                for day, amount in monthly.items()
            ],
        )

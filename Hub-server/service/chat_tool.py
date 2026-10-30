"""只读聊天工具业务：复用账单查询、首页统计及每月限额。"""

from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from core.fund_types import EXPENSE_TYPES, FUND_TYPES
from repository.fund import FundRepository
from repository.monthly_limit import MonthlyLimitRepository
from schemas.request.chat_tool_request import BillSearchRequest, CategoryRankingRequest, MonthToolRequest
from service.dashboard import DashboardService


class ChatToolService:
    # 初始化聊天查询所需的业务和仓储
    def __init__(self, session: AsyncSession):
        self.funds = FundRepository(session)
        self.dashboard = DashboardService(session)
        self.monthly_limits = MonthlyLimitRepository(session)

    # 按已验证条件查询账单并返回分页结果
    async def search_bills(self, user_id: int, data: BillSearchRequest) -> dict:
        rows, has_more = await self.funds.search_for_chat(user_id, **data.model_dump())
        next_offset = data.offset + len(rows) if has_more else None
        result = {
            "items": [{
                "id": row["id"],
                "time": row["time"].strftime("%Y-%m-%d %H:%M:%S"),
                "type": str(row["type"]),
                "category": FUND_TYPES[int(row["type"])],
                "amount": format(row["amount"], ".2f"),
                "remark": row["remark"],
            } for row in rows],
            # 只说明本次返回数量，不将截断后的结果冒充完整查询结果。
            "returned_count": len(rows),
            "has_more": has_more,
            "next_offset": next_offset if next_offset is None or next_offset <= 10000 else None,
        }
        if next_offset is not None and next_offset > 10000:
            result["notice"] = "仍有更多账单，但已达到翻页范围上限，请缩小日期、类别或金额范围。"
        return result

    # 查询指定月份的收入支出和结余
    async def get_month_statistics(self, user_id: int, data: MonthToolRequest) -> dict:
        statistics = await self.dashboard.get_statistics(user_id, data.month)
        return {
            "month": statistics.month,
            "income": statistics.income,
            "expense": statistics.expense,
            "balance": format(Decimal(statistics.income) - Decimal(statistics.expense), ".2f"),
        }

    # 计算月支出分类排行及占比
    async def get_category_ranking(self, user_id: int, data: CategoryRankingRequest) -> dict:
        statistics = await self.dashboard.get_statistics(user_id, data.month)
        expense = Decimal(statistics.expense)
        categories = sorted(
            (item for item in statistics.categoryExpenses if item.type in EXPENSE_TYPES),
            key=lambda item: (-Decimal(item.amount), int(item.type)),
        )
        return {
            "month": statistics.month,
            "total_expense": statistics.expense,
            "items": [{
                "type": item.type,
                "category": FUND_TYPES[int(item.type)],
                "amount": item.amount,
                "percentage": format(Decimal(item.amount) / expense * 100, ".2f") if expense else "0.00",
            } for item in categories[:data.top_n]],
            "has_more": len(categories) > data.top_n,
        }

    # 查询本月支出限额及使用情况
    async def get_budget_status(self, user_id: int) -> dict:
        statistics = await self.dashboard.get_statistics(user_id)
        limit = await self.monthly_limits.get(user_id)
        expense = Decimal(statistics.expense)
        return {
            "month": statistics.month,
            "limit": format(limit, ".2f") if limit is not None else None,
            "expense": statistics.expense,
            "remaining": format(limit - expense, ".2f") if limit is not None else None,
            "over_budget": expense > limit if limit is not None else None,
            "usage_percent": format(expense / limit * 100, ".2f") if limit is not None else None,
            "is_set": limit is not None,
        }

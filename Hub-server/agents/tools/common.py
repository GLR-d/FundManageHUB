import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated

from langchain.tools import ToolRuntime, tool
from langgraph.types import interrupt
from pydantic import Field
from sqlalchemy.exc import SQLAlchemyError

from config import database
from core.fund_types import EXPENSE_TYPES, INCOME_TYPES
from service.dashboard import DashboardService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AgentContext:
    # 由后端传入当前登录用户的身份
    user_id: int


@tool
async def get_month_summary(runtime: ToolRuntime[AgentContext]) -> dict:
    """查询当前登录用户按北京时间计算的本月收入、支出和收支结余，金额单位为元。

    用户询问本月花费、收入或结余时使用；不用于查询其他月份。
    """
    try:
        # 每次调用独立创建、关闭数据库会话
        async with database.async_session() as session:
            rows = await DashboardService(session).get_month_funds(
                runtime.context.user_id
            )
    except SQLAlchemyError:
        logger.exception("查询本月收支失败")
        return {"error": "本月收支查询失败，请稍后重试。"}

    income = Decimal("0.00")
    expense = Decimal("0.00")

    for row in rows:
        amount = Decimal(row["amount"])

        if row["type"] in INCOME_TYPES:
            income += amount
        elif row["type"] in EXPENSE_TYPES:
            expense += amount
        else:
            return {"error": "账单中存在未知类别，暂时无法汇总。"}

    return {
        "income": format(income, ".2f"),
        "expense": format(expense, ".2f"),
        "balance": format(income - expense, ".2f"),
        "count": len(rows),
    }

# 请求用户选择选项或补充信息
@tool
def ask_user(
    runtime: ToolRuntime[AgentContext],
    question: Annotated[str, Field(min_length=1, max_length=1000)],
    options: Annotated[list[Annotated[str, Field(min_length=1, max_length=200)]] | None, Field(max_length=10)] = None,
) -> str:
    """信息不足且影响下一步时询问用户；可提供少量候选选项，用户也可自行输入。"""

    answer = interrupt({
        "question": question,
        "options": options or [],
        "allowCustomAnswer": True,
        # 工具调用编号用于区分同一节点内的不同问题，不向页面直接展示。
        "toolCallId": runtime.tool_call_id,
    })

    return answer

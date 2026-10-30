"""供聊天助手调用的只读工具；身份由后端注入，不接受模型指定用户。"""

import json
import logging
from decimal import Decimal
from typing import Annotated

from langchain.tools import ToolRuntime, tool
from pydantic import Field, ValidationError
from sqlalchemy.exc import SQLAlchemyError

from agents.tools.common import AgentContext
from core import database
from core.fund_types import FUND_TYPES
from schemas.request.chat_tool_request import BillSearchRequest, CategoryRankingRequest, MonthToolRequest
from schemas.request.dashboard_request import DashboardMonth
from service.chat_tool import ChatToolService

logger = logging.getLogger(__name__)


def _invalid_parameters(error: ValidationError) -> dict:
    # 只提供校验说明，不将原始参数或异常详情放入工具结果。
    return {"error": "查询参数不正确：" + error.errors(include_url=False)[0]["msg"]}


def _database_unavailable(error: SQLAlchemyError) -> dict:
    # 工具结果会进入模型上下文，不能包含 SQL、连接信息或凭据。
    logger.error("聊天查询失败（%s）", type(error).__name__)
    return {"error": "账单数据暂时无法查询，请稍后重试。"}


@tool
async def search_bills(
    runtime: ToolRuntime[AgentContext],
    start_date: Annotated[str | None, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")] = None,
    end_date: Annotated[str | None, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")] = None,
    category: str | None = None,
    keyword: str | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    limit: Annotated[int, Field(strict=True, ge=1, le=50)] = 20,
    offset: Annotated[int, Field(strict=True, ge=0, le=10000)] = 0,
) -> dict:
    """按条件查询当前登录用户的账单明细，金额单位为元。

    日期使用 YYYY-MM-DD，起止日期都包含当天；省略日期时不限制日期。
    category 可填消费、餐饮、购物、住房、娱乐、其他、薪资、理财、交通、收转账、收红包，或对应的 0 至 10 编号。
    keyword 只搜索备注，金额范围含上下限。默认返回最近 20 条，最多 50 条。
    next_offset 非空时可继续查询，其他筛选条件保持相同；仍有更多结果但 next_offset 为空时，按 notice 缩小查询范围。
    returned_count 仅表示本批数量，不能将部分账单当作完整收支统计。
    """
    try:
        data = BillSearchRequest(
            start_date=start_date, end_date=end_date, category=category, keyword=keyword,
            min_amount=min_amount, max_amount=max_amount, limit=limit, offset=offset,
        )
        async with database.async_session() as session:
            return await ChatToolService(session).search_bills(runtime.context.user_id, data)
    except ValidationError as error:
        return _invalid_parameters(error)
    except SQLAlchemyError as error:
        return _database_unavailable(error)


@tool
async def get_month_statistics(runtime: ToolRuntime[AgentContext], month: DashboardMonth | None = None) -> dict:
    """查询当前登录用户指定月份的收入、支出和收支结余，金额单位为元。

    month 使用 YYYY-MM，例如 2026-09；省略时使用北京时间本月。
    查询整月收支总额时使用此工具，不能用明细工具返回的部分记录推算总额。
    """
    try:
        data = MonthToolRequest(month=month)
        async with database.async_session() as session:
            return await ChatToolService(session).get_month_statistics(runtime.context.user_id, data)
    except ValidationError as error:
        return _invalid_parameters(error)
    except SQLAlchemyError as error:
        return _database_unavailable(error)


@tool
async def get_category_ranking(
    runtime: ToolRuntime[AgentContext],
    month: DashboardMonth | None = None,
    top_n: Annotated[int, Field(strict=True, ge=1, le=len(FUND_TYPES))] = 5,
) -> dict:
    """查询当前登录用户某月的支出分类排行，以及各分类占整月支出的百分比。

    month 使用 YYYY-MM，省略时使用北京时间本月；top_n 默认 5。
    仅统计支出，不包含薪资、理财、收转账、收红包等收入类型。
    """
    try:
        data = CategoryRankingRequest(month=month, top_n=top_n)
        async with database.async_session() as session:
            return await ChatToolService(session).get_category_ranking(runtime.context.user_id, data)
    except ValidationError as error:
        return _invalid_parameters(error)
    except SQLAlchemyError as error:
        return _database_unavailable(error)


@tool
async def get_budget_status(runtime: ToolRuntime[AgentContext]) -> dict:
    """查询当前登录用户北京时间本月的支出限额、已用金额、剩余额度和是否超支。

    仅查询本月，使用当前设置的每月支出限额；未设置限额时相关字段为 null。
    remaining 为负数表示已超支；该工具不会设置限额，也不会限制记账操作。
    """
    try:
        async with database.async_session() as session:
            return await ChatToolService(session).get_budget_status(runtime.context.user_id)
    except SQLAlchemyError as error:
        return _database_unavailable(error)


# 推断的参数模型会在函数执行前校验；保留自动注入的 runtime，并隐藏于公开参数。
for _query_tool in (search_bills, get_month_statistics, get_category_ranking, get_budget_status):
    _query_tool.args_schema.model_config["extra"] = "forbid"
    _query_tool.args_schema.model_rebuild(force=True)
    _query_tool.handle_validation_error = lambda error: json.dumps(_invalid_parameters(error), ensure_ascii=False)

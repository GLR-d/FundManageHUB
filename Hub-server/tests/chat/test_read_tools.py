"""离线验证账单工具；unittest discover -s tests/chat，不连接数据库或模型。"""

import importlib
import json
import os
import sys
import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from decimal import Decimal
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from langchain.messages import AIMessage
from langchain.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import ValidationError
from sqlalchemy.dialects import mysql
from sqlalchemy.exc import SQLAlchemyError

from config import settings as config

@tool
def search_knowledge(query: str) -> str:
    """测试替身：不初始化知识库或调用模型。"""
    return query


knowledge_stub = ModuleType("agents.tools.knowledge")
knowledge_stub.search_knowledge = search_knowledge
# 创建引擎对象但不连接；导入时也不读取本机 .env 或初始化知识库。
previous_knowledge = sys.modules.get("agents.tools.knowledge")
sys.modules["agents.tools.knowledge"] = knowledge_stub
try:
    with patch.object(config, "dotenv_values", return_value={}), patch.dict(os.environ, {
        "MYSQL_HOST": "127.0.0.1", "MYSQL_USER": "offline_test", "MYSQL_PASSWORD": "offline_test",
        "MYSQL_DATABASE": "offline_tools", "JWT_SECRET_KEY": "offline-tool-test-secret-32-bytes-minimum",
    }):
        import agents.tools as tool_package
        from agents.tools import fund as fund_tools
        from agents.tools.common import AgentContext
        from repository.fund import FundRepository
        from schemas.request.chat_tool_request import BillSearchRequest, CategoryRankingRequest, MonthToolRequest
        from service.chat_tool import ChatToolService
finally:
    # 只还原知识库模块，不能删除此次导入的其他模块或原生扩展。
    if previous_knowledge is None:
        sys.modules.pop("agents.tools.knowledge", None)
    else:
        sys.modules["agents.tools.knowledge"] = previous_knowledge


QUERY_TOOLS = [
    fund_tools.search_bills, fund_tools.get_month_statistics,
    fund_tools.get_category_ranking, fund_tools.get_budget_status,
]


def statistics(*, income="0.00", expense="0.00", categories=()):
    return SimpleNamespace(
        month="2026-10", income=income, expense=expense,
        categoryExpenses=[SimpleNamespace(type=kind, amount=amount) for kind, amount in categories],
    )


class ToolParameterTests(unittest.TestCase):
    def test_normalized_filters_can_be_validated_again(self):
        data = BillSearchRequest(
            start_date="2024-02-29", end_date="9999-12-31", category=" 餐饮 ",
            keyword=" 咖啡%_ ", min_amount="0.10", max_amount="90071992547409.91", limit=50,
        )
        self.assertEqual(data.start_date, date(2024, 2, 29))
        self.assertEqual(data.end_date, date(9999, 12, 31))
        self.assertEqual(data.category, "1")
        self.assertEqual(data.keyword, "咖啡%_")
        self.assertEqual(data.min_amount, Decimal("0.10"))
        self.assertEqual(BillSearchRequest(**data.model_dump()), data)
        self.assertIsNone(BillSearchRequest(keyword="  ").keyword)

    def test_invalid_filters_are_rejected(self):
        invalid = [
            {"start_date": "2026-02-29"}, {"start_date": "2026-1-01"},
            {"start_date": "0999-12-31"}, {"end_date": "2026-10-01T12:00:00"},
            {"start_date": datetime(2026, 10, 1)},
            {"start_date": "2026-10-02", "end_date": "2026-10-01"},
            {"category": "不存在的类别"}, {"category": "11"}, {"category": 1},
            {"keyword": "a" * 51}, {"min_amount": "-0.01"}, {"min_amount": "NaN"},
            {"max_amount": "Infinity"}, {"min_amount": "0.001"},
            {"max_amount": "90071992547409.92"}, {"min_amount": "10", "max_amount": "9"},
            {"limit": 0}, {"limit": 51}, {"limit": True}, {"limit": "20"},
            {"offset": -1}, {"offset": 10001}, {"offset": True}, {"user_id": 99},
        ]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                BillSearchRequest(**values)

    def test_month_and_ranking_boundaries(self):
        self.assertIsNone(MonthToolRequest().month)
        for month in ("1000-01", "2024-02", "9999-12"):
            self.assertEqual(MonthToolRequest(month=month).month, month)
        for month in ("2026-13", "2026-00", "2026-1", "0999-12", "2026-10-01", 202610):
            with self.subTest(month=month), self.assertRaises(ValidationError):
                MonthToolRequest(month=month)
        for values in ({"top_n": 0}, {"top_n": 12}, {"top_n": True}, {"user_id": 99}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                CategoryRankingRequest(**values)


class ToolRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_query_is_scoped_bounded_and_filters_use_bound_values(self):
        session = MagicMock()
        result = MagicMock()
        result.mappings.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=result)
        filters = BillSearchRequest(
            start_date="2026-10-01", end_date="9999-12-31", category="餐饮",
            keyword="coffee%_' OR 1=1", min_amount="0.10", max_amount="50.20", limit=2, offset=4,
        )
        self.assertEqual(await FundRepository(session).search_for_chat(11, **filters.model_dump()), ([], False))
        statement = session.execute.await_args.args[0]
        compiled = statement.compile(dialect=mysql.dialect())
        sql, values = str(compiled), list(compiled.params.values())
        self.assertIn("funds.user_id =", sql)
        self.assertIn(11, values)
        self.assertIn(datetime(2026, 10, 1), values)
        self.assertIn(datetime(9999, 12, 31, 23, 59, 59, 999999), values)
        self.assertIn("funds.time >=", sql)
        self.assertIn("funds.time <=", sql)
        self.assertIn("funds.type =", sql)
        self.assertIn("funds.amount >=", sql)
        self.assertIn("funds.amount <=", sql)
        self.assertIn("locate(", sql.lower())
        self.assertIn(filters.keyword, values)
        self.assertNotIn(filters.keyword, sql)
        self.assertEqual([column.key for column in statement.selected_columns], ["id", "time", "type", "amount", "remark"])
        self.assertIn("ORDER BY funds.time DESC, funds.id DESC", sql)
        self.assertEqual(statement._limit_clause.value, 3)
        self.assertEqual(statement._offset_clause.value, 4)

    async def test_extra_row_only_signals_more_results(self):
        for count, has_more in ((0, False), (2, False), (3, True)):
            with self.subTest(count=count):
                session, result = MagicMock(), MagicMock()
                records = [{"id": number} for number in range(count)]
                result.mappings.return_value.all.return_value = records
                session.execute = AsyncMock(return_value=result)
                actual, more = await FundRepository(session).search_for_chat(
                    22, **BillSearchRequest(limit=2).model_dump(),
                )
                self.assertEqual(actual, records[:2])
                self.assertEqual(more, has_more)


class ToolBusinessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.service = ChatToolService(MagicMock())
        self.service.dashboard.get_statistics = AsyncMock(return_value=statistics())
        self.service.monthly_limits.get = AsyncMock(return_value=None)

    async def test_search_formats_only_requested_user_bill_fields(self):
        self.service.funds.search_for_chat = AsyncMock(return_value=([{
            "id": 8, "time": datetime(2026, 10, 20, 12, 30), "type": 1,
            "amount": Decimal("0.10"), "remark": "咖啡", "photo": "private-image", "user_id": 11,
        }], True))
        data = BillSearchRequest(keyword="咖啡", limit=1, offset=2)
        result = await self.service.search_bills(11, data)
        self.service.funds.search_for_chat.assert_awaited_once_with(11, **data.model_dump())
        self.assertEqual(result, {
            "items": [{"id": 8, "time": "2026-10-20 12:30:00", "type": "1", "category": "餐饮", "amount": "0.10", "remark": "咖啡"}],
            "returned_count": 1, "has_more": True, "next_offset": 3,
        })

    async def test_search_empty_and_offset_boundary(self):
        self.service.funds.search_for_chat = AsyncMock(return_value=([], False))
        empty = await self.service.search_bills(11, BillSearchRequest())
        self.assertEqual(empty, {"items": [], "returned_count": 0, "has_more": False, "next_offset": None})
        self.service.funds.search_for_chat.return_value = ([{
            "id": 1, "time": datetime(2026, 10, 1), "type": 0,
            "amount": Decimal("1"), "remark": "",
        }], True)
        boundary = await self.service.search_bills(11, BillSearchRequest(offset=10000))
        self.assertTrue(boundary["has_more"])
        self.assertIsNone(boundary["next_offset"])
        self.assertIn("notice", boundary)

    async def test_month_summary_uses_exact_decimal_and_forwards_month(self):
        self.service.dashboard.get_statistics.return_value = statistics(income="0.30", expense="0.20")
        actual = await self.service.get_month_statistics(22, MonthToolRequest(month="2026-10"))
        self.assertEqual(actual, {"month": "2026-10", "income": "0.30", "expense": "0.20", "balance": "0.10"})
        self.service.dashboard.get_statistics.assert_awaited_once_with(22, "2026-10")

    async def test_ranking_sorts_money_numerically_and_uses_entire_month_denominator(self):
        self.service.dashboard.get_statistics.return_value = statistics(expense="118.00", categories=(
            ("2", "9.00"), ("8", "9.00"), ("1", "100.00"), ("6", "1000.00"),
        ))
        actual = await self.service.get_category_ranking(11, CategoryRankingRequest(month="2026-10", top_n=2))
        self.assertEqual([item["type"] for item in actual["items"]], ["1", "2"])
        self.assertEqual(actual["items"][0]["percentage"], "84.75")
        self.assertEqual(actual["items"][1]["percentage"], "7.63")
        self.assertEqual(actual["items"][0]["category"], "餐饮")
        self.assertEqual(actual["total_expense"], "118.00")
        self.assertTrue(actual["has_more"])
        self.service.dashboard.get_statistics.assert_awaited_once_with(11, "2026-10")

    async def test_empty_ranking_does_not_divide_by_zero(self):
        actual = await self.service.get_category_ranking(11, CategoryRankingRequest())
        self.assertEqual(actual, {"month": "2026-10", "total_expense": "0.00", "items": [], "has_more": False})

    async def test_unset_budget_is_distinct_from_zero_remaining(self):
        self.service.dashboard.get_statistics.return_value = statistics(expense="12.30")
        actual = await self.service.get_budget_status(22)
        self.assertEqual(actual, {
            "month": "2026-10", "limit": None, "expense": "12.30", "remaining": None,
            "over_budget": None, "usage_percent": None, "is_set": False,
        })
        self.service.dashboard.get_statistics.assert_awaited_once_with(22)
        self.service.monthly_limits.get.assert_awaited_once_with(22)

    async def test_budget_remaining_and_percentage_preserve_precision(self):
        for expense, remaining, over, percentage in (
            ("0.00", "0.30", False, "0.00"), ("0.10", "0.20", False, "33.33"),
            ("0.30", "0.00", False, "100.00"), ("0.40", "-0.10", True, "133.33"),
        ):
            with self.subTest(expense=expense):
                self.service.dashboard.get_statistics.return_value = statistics(expense=expense)
                self.service.monthly_limits.get.return_value = Decimal("0.30")
                actual = await self.service.get_budget_status(11)
                self.assertEqual(actual["limit"], "0.30")
                self.assertEqual(actual["remaining"], remaining)
                self.assertEqual(actual["over_budget"], over)
                self.assertEqual(actual["usage_percent"], percentage)
                self.assertTrue(actual["is_set"])


class ToolRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def graph(self):
        builder = StateGraph(MessagesState, context_schema=AgentContext)
        builder.add_node("tools", ToolNode(QUERY_TOOLS))
        builder.add_edge(START, "tools")
        builder.add_edge("tools", END)
        return builder.compile()

    async def test_real_tool_node_injects_identity_and_uses_independent_sessions(self):
        sessions, service_instances = [], []

        @asynccontextmanager
        async def session_factory():
            session = object()
            sessions.append(session)
            yield session

        def service_factory(session):
            service = MagicMock()
            for name in ("search_bills", "get_month_statistics", "get_category_ranking", "get_budget_status"):
                setattr(service, name, AsyncMock(return_value={"called": name}))
            service_instances.append(service)
            return service

        calls = [
            {"name": query.name, "args": {}, "id": str(index), "type": "tool_call"}
            for index, query in enumerate(QUERY_TOOLS)
        ]
        calls[0]["args"] = {
            "start_date": "2024-02-29", "end_date": "9999-12-31", "category": "餐饮",
            "keyword": "咖啡", "min_amount": "0.10", "max_amount": "50.20", "limit": 2,
        }
        with patch.object(fund_tools.database, "async_session", session_factory), patch.object(fund_tools, "ChatToolService", service_factory):
            result = await self.graph().ainvoke(
                {"messages": [AIMessage(content="", tool_calls=calls)]},
                context=AgentContext(user_id=77),
            )
        self.assertEqual(len(sessions), 4)
        self.assertEqual(len({id(session) for session in sessions}), 4)
        self.assertEqual(len(result["messages"]), 5)
        for service in service_instances:
            invoked = [getattr(service, query.name) for query in QUERY_TOOLS if getattr(service, query.name).await_count]
            self.assertEqual(len(invoked), 1)
            self.assertEqual(invoked[0].await_args.args[0], 77)
            if service.search_bills.await_count:
                filters = service.search_bills.await_args.args[1]
                self.assertEqual(filters.start_date, date(2024, 2, 29))
                self.assertEqual(filters.end_date, date(9999, 12, 31))
                self.assertEqual(filters.category, "1")
                self.assertEqual(filters.min_amount, Decimal("0.10"))
                self.assertEqual(filters.max_amount, Decimal("50.20"))

    async def test_model_cannot_supply_user_id(self):
        session_factory = MagicMock()
        with patch.object(fund_tools.database, "async_session", session_factory):
            for query in QUERY_TOOLS:
                with self.subTest(tool=query.name):
                    result = await self.graph().ainvoke({"messages": [AIMessage(content="", tool_calls=[{
                        "name": query.name, "args": {"user_id": 999}, "id": "bad", "type": "tool_call",
                    }])]}, context=AgentContext(user_id=11))
                    self.assertIn("error", json.loads(result["messages"][-1].content))
        session_factory.assert_not_called()

    async def test_model_supplied_runtime_cannot_override_server_identity(self):
        service = MagicMock()
        service.get_budget_status = AsyncMock(return_value={"is_set": False})

        @asynccontextmanager
        async def session_factory():
            yield object()

        with patch.object(fund_tools.database, "async_session", session_factory), patch.object(fund_tools, "ChatToolService", return_value=service):
            result = await self.graph().ainvoke({"messages": [AIMessage(content="", tool_calls=[{
                "name": "get_budget_status", "args": {"runtime": {"context": {"user_id": 999}}},
                "id": "spoofed", "type": "tool_call",
            }])]}, context=AgentContext(user_id=11))
        content = json.loads(result["messages"][-1].content)
        if "error" not in content:
            service.get_budget_status.assert_awaited_once_with(11)
        else:
            service.get_budget_status.assert_not_awaited()

    async def test_database_errors_are_safe_for_model_and_logs(self):
        error = SQLAlchemyError("SELECT secret FROM credentials password=private-password")
        runtime = SimpleNamespace(context=AgentContext(user_id=11))
        with patch.object(fund_tools.database, "async_session", side_effect=error):
            for query in QUERY_TOOLS:
                with self.subTest(tool=query.name), self.assertLogs(fund_tools.logger, level="ERROR") as logs:
                    actual = await query.coroutine(runtime)
                    self.assertEqual(actual, {"error": "账单数据暂时无法查询，请稍后重试。"})
                    self.assertNotIn("private-password", " ".join(logs.output))
                    self.assertNotIn("SELECT secret", " ".join(logs.output))

    async def test_direct_calls_also_validate_before_acquiring_database_session(self):
        runtime = SimpleNamespace(context=AgentContext(user_id=11))
        with patch.object(fund_tools.database, "async_session") as session_factory:
            for query, values in (
                (fund_tools.search_bills, {"limit": 0}),
                (fund_tools.get_month_statistics, {"month": "2026-13"}),
                (fund_tools.get_category_ranking, {"top_n": 0}),
            ):
                with self.subTest(tool=query.name):
                    actual = await query.coroutine(runtime, **values)
                    self.assertIn("error", actual)
            session_factory.assert_not_called()

    def test_all_registered_tool_schemas_are_bindable_and_hide_identity(self):
        # test_stream 先加载时其知识库替身是 object；本地补成真实工具验证注册列表。
        registered = [item if hasattr(item, "name") else search_knowledge for item in tool_package.tools]
        schemas = [convert_to_openai_tool(item) for item in registered]
        self.assertEqual({item["function"]["name"] for item in schemas}, {
            "get_month_summary", "search_knowledge", "search_bills", "get_month_statistics",
            "get_category_ranking", "get_budget_status", "ask_user",
        })
        self.assertEqual(len(schemas), 7)
        for query in QUERY_TOOLS:
            schema = convert_to_openai_tool(query)["function"]["parameters"]
            self.assertNotIn("runtime", schema.get("properties", {}))
            self.assertNotIn("user_id", schema.get("properties", {}))
            # 额外参数的拒绝行为由真实 ToolNode 调用测试覆盖。
        ToolNode(registered)

    async def test_chat_node_supplies_current_beijing_date_without_real_model(self):
        llm_stub = ModuleType("agents.llm")
        bound_model = MagicMock()
        bound_model.ainvoke = AsyncMock(return_value=AIMessage(content="测试回复"))
        llm_stub.model = MagicMock()
        llm_stub.model.bind_tools.return_value = bound_model
        registered = [item if hasattr(item, "name") else search_knowledge for item in tool_package.tools]
        with patch.dict(sys.modules, {
            "agents.llm": llm_stub,
            "agents.tools": tool_package,
            "agents.tools.knowledge": knowledge_stub,
        }), patch.object(tool_package, "tools", registered):
            previous = sys.modules.pop("agents.graph", None)
            try:
                graph_module = importlib.import_module("agents.graph")
                with patch.object(graph_module, "utcnow", return_value=datetime(2026, 10, 31, 17)):
                    actual = await graph_module.chat_node({"messages": []})
                self.assertEqual(actual["messages"][0].content, "测试回复")
                prompt = bound_model.ainvoke.await_args.args[0][0].content
                self.assertIn("当前北京时间：2026-11-01 01:00:00", prompt)
            finally:
                sys.modules.pop("agents.graph", None)
                if previous is not None:
                    sys.modules["agents.graph"] = previous


if __name__ == "__main__":
    unittest.main()

"""使用真实检查点和 ToolNode 验证提问、刷新、作答与取消，不访问外部服务。"""

import asyncio
import unittest
from unittest.mock import patch

import jwt
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.runtime import get_runtime
from langgraph.types import Command, interrupt

from helpers import EXCEPTION_HANDLERS, FakeRedis
from test_stream import AgentContext, parse_events
from agents.tools.common import ask_user
from core.auth_middleware import JWTAuthMiddleware
from utils.jwt_tokens import SessionIdentity
from router.chat import router


class ChatQuestionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.checkpointer = InMemorySaver()
        self.answering = asyncio.Event()
        self.release_answer = asyncio.Event()
        self.hold_answer = False
        self.graph = self.build_graph()
        self.app = FastAPI(exception_handlers=EXCEPTION_HANDLERS)
        self.app.state.settings = object()
        self.app.state.redis_client = self.redis
        self.app.state.chat_checkpointer = self.checkpointer
        self.app.state.chat_graph = self.graph
        self.app.include_router(router)
        self.app.add_middleware(JWTAuthMiddleware)

        async def identity(token, settings):
            if token not in {"one", "two"}:
                raise jwt.InvalidTokenError()
            return SessionIdentity(user_id=11 if token == "one" else 22, token_hash="test")

        auth = patch("core.auth_middleware.load_identity", identity)
        auth.start()
        self.addCleanup(auth.stop)

    def build_graph(self, *, sequential=False, parallel=False, same_question=False, question_tool=ask_user):
        def question(call_id, text, options):
            return {"id": call_id, "name": "ask_user", "args": {"question": text, "options": options}, "type": "tool_call"}

        async def chat(state):
            last = state["messages"][-1]
            if isinstance(last, HumanMessage):
                calls = [question("period", "你想查询哪个月份？", ["本月", "上月"])]
                if parallel:
                    calls.append(question("scope", "你想查询哪个月份？" if same_question else "想查看哪种统计？",
                                          ["本月", "上月"] if same_question else ["收入", "支出"]))
                return {"messages": [AIMessage(content="先确认统计条件。", tool_calls=calls)]}
            answers = [message.content for message in state["messages"] if isinstance(message, ToolMessage)]
            if sequential and len(answers) == 1:
                return {"messages": [AIMessage(content="", tool_calls=[
                    question("scope", "想查看哪种统计？", ["收入", "支出"]),
                ])]}
            if self.hold_answer:
                self.answering.set()
                await self.release_answer.wait()
            user_id = get_runtime(AgentContext).context.user_id
            return {"messages": [AIMessage(content=f"用户{user_id}，已收到：" + "、".join(answers))]}

        builder = StateGraph(MessagesState, context_schema=AgentContext)
        builder.add_node("chat", chat)
        builder.add_node("tools", ToolNode([question_tool]))
        builder.add_edge(START, "chat")
        builder.add_conditional_edges("chat", tools_condition)
        builder.add_edge("tools", "chat")
        return builder.compile(checkpointer=self.checkpointer)

    async def asyncSetUp(self):
        for token in ("one", "two"):
            response = await self.request("POST", "/chat/conversations", token=token, data={
                "id": "same-chat", "title": "提问测试",
            })
            self.assertEqual(response.status_code, 200, response.text)

    async def request(self, method, path, *, token="one", data=None):
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://testserver") as client:
            return await client.request(method, path, headers={"token": token}, json=data)

    async def start(self, *, token="one"):
        response = await self.request("POST", "/chat/stream", token=token, data={
            "conversationId": "same-chat", "message": "帮我统计账单", "messageId": "user-1", "replyId": "ai-1",
        })
        self.assertEqual(response.status_code, 200, response.text)
        events = parse_events(response.text)
        self.assertEqual(events[-1]["event"], "question", response.text)
        self.assertNotIn("done", [event["event"] for event in events])
        self.assertNotIn("error", [event["event"] for event in events])
        return events[-1]["data"]

    async def resume(self, question_id, answer="上月", *, token="one", **extra):
        return await self.request("POST", "/chat/stream", token=token, data={
            "conversationId": "same-chat", "interruptId": question_id, "answer": answer, **extra,
        })

    async def detail(self, *, token="one"):
        response = await self.request("GET", "/chat/conversations/same-chat", token=token)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["data"]

    async def assert_unlocked(self, user_id=11):
        self.assertIsNone(await self.redis.get(f"managehub:chat:{user_id}:lock:same-chat"))

    async def test_pause_persists_question_without_failure_and_releases_lock(self):
        event = await self.start()
        self.assertEqual(event["conversationId"], "same-chat")
        self.assertEqual(event["messageId"], "ai-1")
        questions = event["questions"]
        self.assertEqual(len(questions), 1)
        self.assertTrue(questions[0]["interruptId"])
        self.assertEqual(questions[0]["question"], "你想查询哪个月份？")
        self.assertEqual(questions[0]["options"], ["本月", "上月"])
        self.assertTrue(questions[0]["allowCustomAnswer"])
        record = await self.detail()
        self.assertEqual(record["pendingQuestions"], questions)
        reply = record["messages"][-1]
        self.assertEqual(reply["questions"], questions)
        self.assertEqual(reply["content"], "先确认统计条件。")
        self.assertFalse(reply["pending"])
        self.assertFalse(reply["failed"])
        self.assertFalse(reply["interrupted"])
        self.assertIsNone(reply["expiresAt"])
        await self.assert_unlocked()

    async def test_custom_answer_resumes_the_tool_and_keeps_one_model_user_message(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        response = await self.resume(question_id, "2026年8月", messageId="answer-1", replyId="ai-2")
        self.assertEqual(response.status_code, 200, response.text)
        events = parse_events(response.text)
        self.assertEqual(events[-1], {"event": "done", "data": {"conversationId": "same-chat"}})
        self.assertIn("用户11，已收到：2026年8月", "".join(item["data"]["content"] for item in events if item["event"] == "token"))
        record = await self.detail()
        self.assertEqual(record["pendingQuestions"], [])
        self.assertEqual([message["role"] for message in record["messages"]], ["user", "ai", "user", "ai"])
        self.assertEqual(record["messages"][2]["content"], "2026年8月")
        self.assertEqual(record["messages"][1]["questions"], event["questions"])
        self.assertFalse(record["messages"][-1]["failed"])
        snapshot = await self.graph.aget_state({"configurable": {"thread_id": "11:same-chat"}})
        self.assertEqual(sum(isinstance(message, HumanMessage) for message in snapshot.values["messages"]), 1)
        tool_results = [message for message in snapshot.values["messages"] if isinstance(message, ToolMessage)]
        self.assertEqual([message.content for message in tool_results], ["2026年8月"])
        await self.assert_unlocked()

    async def test_unknown_duplicate_and_other_account_answers_do_not_write_messages(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        for token, value in (("one", "not-the-question"), ("two", question_id)):
            response = await self.resume(value, token=token)
            self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(len((await self.detail())["messages"]), 2)
        self.assertEqual((await self.detail(token="two"))["messages"], [])
        self.assertEqual((await self.resume(question_id)).status_code, 200)
        repeated = await self.resume(question_id)
        self.assertEqual(repeated.status_code, 409, repeated.text)
        self.assertEqual(len((await self.detail())["messages"]), 4)
        await self.assert_unlocked()

    async def test_waiting_blocks_new_messages_and_still_allows_other_users_and_delete(self):
        first = await self.start()
        blocked = await self.request("POST", "/chat/stream", data={"conversationId": "same-chat", "message": "另一条问题"})
        self.assertEqual(blocked.status_code, 409, blocked.text)
        second = await self.start(token="two")
        first_id = first["questions"][0]["interruptId"]
        self.assertNotEqual(first_id, second["questions"][0]["interruptId"])
        self.assertEqual((await self.resume(first_id, token="two")).status_code, 409)
        deleted = await self.request("DELETE", "/chat/conversations/same-chat")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual((await self.detail(token="two"))["pendingQuestions"], second["questions"])
        await self.assert_unlocked()
        await self.assert_unlocked(22)

    async def test_multiple_sequential_questions_resume_across_separate_requests(self):
        self.graph = self.build_graph(sequential=True)
        self.app.state.chat_graph = self.graph
        first = await self.start()
        first_id = first["questions"][0]["interruptId"]
        response = await self.resume(first_id, "上月")
        events = parse_events(response.text)
        self.assertEqual(events[-1]["event"], "question", response.text)
        second = events[-1]["data"]
        second_id = second["questions"][0]["interruptId"]
        self.assertNotEqual(first_id, second_id)
        self.assertEqual((await self.detail())["pendingQuestions"], second["questions"])
        self.assertEqual((await self.resume(first_id)).status_code, 409)
        completed = await self.resume(second_id, "支出")
        self.assertEqual(parse_events(completed.text)[-1]["event"], "done", completed.text)
        self.assertEqual((await self.detail())["pendingQuestions"], [])
        completed_text = "".join(item["data"]["content"] for item in parse_events(completed.text) if item["event"] == "token")
        self.assertIn("上月、支出", completed_text)
        await self.assert_unlocked()

    async def test_parallel_questions_can_be_answered_one_at_a_time(self):
        self.graph = self.build_graph(parallel=True)
        self.app.state.chat_graph = self.graph
        first = await self.start()
        # 同一 ToolNode 内的并行工具在当前 SDK 中会逐个呈现中断。
        self.assertEqual(len(first["questions"]), 1)
        first_id = first["questions"][0]["interruptId"]
        response = await self.resume(first_id, "上月")
        events = parse_events(response.text)
        self.assertEqual(events[-1]["event"], "question", response.text)
        remaining = events[-1]["data"]["questions"]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["question"], "想查看哪种统计？")
        second_id = remaining[0]["interruptId"]
        # SDK 的原生中断编号可能复用，对外问题编号仍须区分提问阶段。
        self.assertNotEqual(first_id, second_id)
        self.assertEqual((await self.detail())["pendingQuestions"], remaining)
        self.assertEqual((await self.resume(first_id, "上月")).status_code, 409)
        completed = await self.resume(second_id, "收入")
        self.assertEqual(parse_events(completed.text)[-1]["event"], "done", completed.text)
        completed_text = "".join(item["data"]["content"] for item in parse_events(completed.text) if item["event"] == "token")
        self.assertIn("上月、收入", completed_text)
        await self.assert_unlocked()

    async def test_invalid_resume_payloads_never_change_waiting_history(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        for changes in (
            {"answer": " "}, {"interruptId": ""}, {"answer": "x" * 10001},
            {"message": "不能同时发送"}, {"user_id": 22},
        ):
            response = await self.request("POST", "/chat/stream", data={
                "conversationId": "same-chat", "interruptId": question_id, "answer": "上月", **changes,
            })
            self.assertEqual(response.status_code, 422, response.text)
        record = await self.detail()
        self.assertEqual(len(record["messages"]), 2)
        self.assertEqual(record["pendingQuestions"], event["questions"])
        await self.assert_unlocked()

    async def test_identical_questions_in_one_tool_node_keep_distinct_external_ids(self):
        self.graph = self.build_graph(parallel=True, same_question=True)
        self.app.state.chat_graph = self.graph
        first = await self.start()
        first_id = first["questions"][0]["interruptId"]
        response = await self.resume(first_id, "上月")
        second = parse_events(response.text)[-1]["data"]["questions"][0]
        self.assertEqual(second["question"], first["questions"][0]["question"])
        self.assertNotEqual(second["interruptId"], first_id)
        self.assertEqual((await self.resume(first_id)).status_code, 409)
        completed = await self.resume(second["interruptId"], "本月")
        self.assertEqual(parse_events(completed.text)[-1]["event"], "done", completed.text)
        await self.assert_unlocked()

    async def test_choice_only_question_rejects_custom_text_without_consuming_question(self):
        @tool("ask_user")
        def choice_only(question: str, options: list[str]) -> str:
            """测试只允许从选项选择答案的提问。"""
            return interrupt({"question": question, "options": options, "allowCustomAnswer": False})

        self.graph = self.build_graph(question_tool=choice_only)
        self.app.state.chat_graph = self.graph
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        rejected = await self.resume(question_id, "自行输入的月份")
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(len((await self.detail())["messages"]), 2)
        self.assertEqual((await self.detail())["pendingQuestions"], event["questions"])
        await self.assert_unlocked()
        accepted = await self.resume(question_id, "上月")
        self.assertEqual(parse_events(accepted.text)[-1]["event"], "done", accepted.text)

    async def test_concurrent_answer_is_rejected_while_first_resume_is_running(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        self.hold_answer = True
        first = asyncio.create_task(self.resume(question_id))
        try:
            await asyncio.wait_for(self.answering.wait(), timeout=3)
            duplicate = await self.resume(question_id)
            self.assertEqual(duplicate.status_code, 409, duplicate.text)
        finally:
            self.release_answer.set()
            completed = await asyncio.wait_for(first, timeout=3)
        self.assertEqual(parse_events(completed.text)[-1]["event"], "done", completed.text)
        self.assertEqual(len((await self.detail())["messages"]), 4)
        await self.assert_unlocked()

    async def test_cancelled_resume_keeps_checkpoint_question_for_retry(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        graph = self.graph
        entered = asyncio.Event()
        release = asyncio.Event()

        class BeforeResumeGraph:
            async def aget_state(self, config):
                return await graph.aget_state(config)

            async def astream(self, inputs, **options):
                if isinstance(inputs, Command):
                    entered.set()
                    await release.wait()
                async for chunk in graph.astream(inputs, **options):
                    yield chunk

        self.app.state.chat_graph = BeforeResumeGraph()
        pending = asyncio.create_task(self.resume(question_id))
        try:
            await asyncio.wait_for(entered.wait(), timeout=3)
        finally:
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        record = await self.detail()
        self.assertEqual(record["pendingQuestions"], event["questions"])
        self.assertTrue(record["messages"][-1]["interrupted"])
        self.assertFalse(record["messages"][-1]["pending"])
        await self.assert_unlocked()
        self.app.state.chat_graph = graph
        response = await self.resume(question_id, "本月")
        self.assertEqual(parse_events(response.text)[-1]["event"], "done", response.text)

    async def test_stale_checkpoint_is_rejected_before_answer_is_saved(self):
        event = await self.start()
        question_id = event["questions"][0]["interruptId"]
        await self.checkpointer.adelete_thread("11:same-chat")
        stale = await self.resume(question_id)
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(len((await self.detail())["messages"]), 2)
        await self.assert_unlocked()


if __name__ == "__main__":
    unittest.main()

"""离线聊天协议测试：不启动模型、Redis 或 MySQL。

使用 unittest discover -s tests/chat 运行，避开上层 MySQL 集成测试夹具。
"""

import asyncio
import json
import sys
import unittest
from types import ModuleType
from unittest.mock import patch

import jwt
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from helpers import FakeCheckpointer, FakeRedis

# tools 包会同时导入知识检索工具；此处只隔离知识库的模型、嵌入和
# Chroma 启动依赖，common 工具与 AgentContext 仍使用真实生产模块。
knowledge_stub = ModuleType("agents.tools.knowledge")
knowledge_stub.search_knowledge = object()
previous_knowledge_module = sys.modules.get("agents.tools.knowledge")
sys.modules["agents.tools.knowledge"] = knowledge_stub
try:
    from agents.tools.common import AgentContext
finally:
    if previous_knowledge_module is None:
        sys.modules.pop("agents.tools.knowledge", None)
    else:
        sys.modules["agents.tools.knowledge"] = previous_knowledge_module
from core.auth_middleware import JWTAuthMiddleware
from core.exception_handlers import register_exception_handlers
from core.jwt_tokens import SessionIdentity
from router.chat import router
from schemas.chat_request import ChatRequest
from service.chat import ChatService


class FakeGraph:
    def __init__(self):
        self.chunks = []
        self.calls = []
        self.error = None
        self.wait = False
        self.waiting = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = False
        self.completed = False

    async def astream(self, inputs, **options):
        self.calls.append((inputs, options))
        try:
            for chunk in self.chunks:
                yield chunk
            if self.wait:
                self.waiting.set()
                await self.release.wait()
            if self.error:
                raise self.error
            self.completed = True
        finally:
            self.closed = True

def parse_events(body):
    events = []
    for frame in body.split("\n\n"):
        fields = {}
        for line in frame.splitlines():
            if line.startswith("event: "):
                fields["event"] = line[7:]
            elif line.startswith("data: "):
                fields["data"] = json.loads(line[6:])
        if fields:
            events.append(fields)
    return events


class ChatStreamTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.graph = FakeGraph()
        self.app = FastAPI()
        self.app.state.settings = object()
        self.app.state.chat_graph = self.graph
        self.app.state.redis_client = FakeRedis()
        self.app.state.chat_checkpointer = FakeCheckpointer()
        self.app.include_router(router)
        self.app.add_middleware(JWTAuthMiddleware)
        register_exception_handlers(self.app)

        async def identity(token, settings):
            if token not in {"one", "two"}:
                raise jwt.InvalidTokenError()
            return SessionIdentity(user_id=11 if token == "one" else 22, token_hash="test")

        auth = patch("core.auth_middleware.load_identity", identity)
        auth.start()
        self.addCleanup(auth.stop)

    async def asyncSetUp(self):
        # 先创建属于两位用户的同名会话，流式接口不再隐式创建列表记录。
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://testserver") as client:
            for token in ("one", "two"):
                response = await client.post("/chat/conversations", headers={"token": token}, json={
                    "id": "same-chat", "title": "测试对话",
                })
                self.assertEqual(response.status_code, 200, response.text)

    async def post(self, *, token="one", data=None):
        async with AsyncClient(
            transport=ASGITransport(app=self.app), base_url="http://testserver",
        ) as client:
            return await client.post(
                "/chat/stream",
                headers={"token": token} if token else {},
                json=data if data is not None else {"conversationId": "same-chat", "message": "你好"},
            )

    async def test_stream_sends_only_public_text_then_done(self):
        self.graph.chunks = [
            (AIMessageChunk(content="你好\n"), {"langgraph_node": "chat"}),
            (ToolMessage(content="private database result", tool_call_id="t"), {"langgraph_node": "tools"}),
            (AIMessageChunk(content="private other node"), {"langgraph_node": "other"}),
            (AIMessageChunk(content=[{"type": "reasoning", "reasoning": "private reasoning"}]), {"langgraph_node": "chat"}),
            (AIMessageChunk(content="", tool_call_chunks=[{"name": "summary", "args": '{"secret":1}', "id": "t", "index": 0}]), {"langgraph_node": "chat"}),
            (AIMessageChunk(content=[{"type": "text", "text": "完成"}]), {"langgraph_node": "chat"}),
        ]
        response = await self.post()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertEqual(parse_events(response.text), [
            {"event": "token", "data": {"content": "你好\n"}},
            {"event": "token", "data": {"content": "完成"}},
            {"event": "done", "data": {"conversationId": "same-chat"}},
        ])
        self.assertNotIn("private", response.text)
        self.assertNotIn("secret", response.text)
        self.assertTrue(self.graph.completed)
        self.assertTrue(self.graph.closed)
        inputs, options = self.graph.calls[0]
        self.assertEqual(inputs, {"messages": [("user", "你好")]})
        self.assertEqual(options["stream_mode"], "messages")
        self.assertEqual(options["context"].user_id, 11)
        self.assertEqual(options["config"]["configurable"]["thread_id"], "11:same-chat")

    async def test_error_is_public_and_does_not_send_done(self):
        self.graph.chunks = [(AIMessageChunk(content="部分回复"), {"langgraph_node": "chat"})]
        self.graph.error = RuntimeError("private API key or connection details")
        with self.assertLogs("router.chat", level="ERROR"):
            response = await self.post()
        events = parse_events(response.text)
        self.assertEqual([event["event"] for event in events], ["token", "error"])
        self.assertEqual(events[-1]["data"], {"message": "回答生成失败，请稍后重试。"})
        self.assertNotIn("private", response.text)
        self.assertTrue(self.graph.closed)
        self.assertFalse(self.graph.completed)

    async def test_authentication_happens_before_streaming(self):
        for token in (None, "invalid"):
            response = await self.post(token=token)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["code"], 0)
            self.assertNotIn("text/event-stream", response.headers["content-type"])
        self.assertEqual(self.graph.calls, [])

    async def test_same_conversation_is_scoped_by_authenticated_user(self):
        await self.post(token="one")
        await self.post(token="two")
        configs = [options["config"]["configurable"]["thread_id"] for _, options in self.graph.calls]
        self.assertEqual(configs, ["11:same-chat", "22:same-chat"])

    async def test_validation_rejects_blank_messages_and_client_identity(self):
        for data in (
            {"conversationId": "same-chat", "message": "  "},
            {"conversationId": "", "message": "你好"},
            {"conversationId": "same-chat", "message": "你好", "user_id": 22},
        ):
            response = await self.post(data=data)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["code"], 0)
        self.assertEqual(self.graph.calls, [])

    async def test_real_graph_restores_history_and_accepts_full_ai_messages(self):
        async def answer(state):
            turns = sum(isinstance(message, HumanMessage) for message in state["messages"])
            return {"messages": [AIMessage(content=f"第{turns}条消息")]}

        builder = StateGraph(MessagesState, context_schema=AgentContext)
        builder.add_node("chat", answer)
        builder.add_edge(START, "chat")
        builder.add_edge("chat", END)
        self.app.state.chat_graph = builder.compile(checkpointer=InMemorySaver())

        first = parse_events((await self.post()).text)
        second = parse_events((await self.post()).text)
        another_user = parse_events((await self.post(token="two")).text)
        self.assertEqual(first[0], {"event": "token", "data": {"content": "第1条消息"}})
        self.assertEqual(second[0], {"event": "token", "data": {"content": "第2条消息"}})
        self.assertEqual(another_user[0], {"event": "token", "data": {"content": "第1条消息"}})

    async def test_cancellation_propagates_and_closes_graph_iterator(self):
        self.graph.wait = True
        stream = ChatService(self.graph).stream_reply(
            11, ChatRequest(conversationId="same-chat", message="你好"),
        )
        pending = asyncio.create_task(anext(stream))
        await asyncio.wait_for(self.graph.waiting.wait(), timeout=2)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(self.graph.closed)
        self.assertFalse(self.graph.completed)

    async def test_early_consumer_close_closes_graph_iterator(self):
        self.graph.chunks = [(AIMessageChunk(content="第一段"), {"langgraph_node": "chat"})]
        self.graph.wait = True
        stream = ChatService(self.graph).stream_reply(
            11, ChatRequest(conversationId="same-chat", message="你好"),
        )
        self.assertEqual(await anext(stream), "第一段")
        await stream.aclose()
        self.assertTrue(self.graph.closed)

    async def test_browser_disconnect_cancels_stream_without_done(self):
        self.graph.chunks = [(AIMessageChunk(content="第一段"), {"langgraph_node": "chat"})]
        self.graph.wait = True
        disconnected = asyncio.Event()
        request_sent = False
        sent = []

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": json.dumps({
                    "conversationId": "same-chat", "message": "你好",
                }).encode(), "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and b"event: token" in message.get("body", b""):
                disconnected.set()

        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1", "method": "POST", "scheme": "http", "root_path": "",
            "path": "/chat/stream", "raw_path": b"/chat/stream", "query_string": b"",
            "server": ("testserver", 80), "client": ("test", 123),
            "headers": [(b"content-type", b"application/json"), (b"token", b"one")],
        }
        await asyncio.wait_for(self.app(scope, receive, send), timeout=2)
        self.assertTrue(disconnected.is_set())
        self.assertTrue(self.graph.closed)
        self.assertFalse(self.graph.completed)
        self.assertFalse(any(b"event: done" in item.get("body", b"") for item in sent))
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://testserver") as client:
            detail = await client.get("/chat/conversations/same-chat", headers={"token": "one"})
            messages = detail.json()["data"]["messages"]
            self.assertEqual(messages[-1]["content"], "第一段")
            self.assertTrue(messages[-1]["interrupted"])
            self.assertFalse(messages[-1].get("pending", False))
            deleted = await client.delete("/chat/conversations/same-chat", headers={"token": "one"})
            self.assertEqual(deleted.status_code, 200, deleted.text)


if __name__ == "__main__":
    unittest.main()

"""离线验证会话的账号隔离、迁移、持久化及删除与生成互斥。"""

import asyncio
import unittest
from unittest.mock import patch

import jwt
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain.messages import AIMessageChunk
from redis.exceptions import ConnectionError as RedisConnectionError

from helpers import FakeCheckpointer, FakeRedis
# 复用协议测试中的假图，同时隔离 agents.tools 的知识库启动副作用。
from test_stream import FakeGraph, parse_events
from core.auth_middleware import JWTAuthMiddleware
from core.exception_handlers import register_exception_handlers
from core.jwt_tokens import SessionIdentity
from router.chat import router
from schemas.chat_request import ChatRequest
from service.chat_conversation import ChatConversationService


def legacy_message(message_id="old-user", content="以前的消息", *, role="user", created_at=10):
    return {"id": message_id, "role": role, "content": content, "createdAt": created_at, "updatedAt": created_at}


class ChatConversationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.checkpointer = FakeCheckpointer()
        self.graph = FakeGraph()
        self.app = FastAPI()
        self.app.state.settings = object()
        self.app.state.redis_client = self.redis
        self.app.state.chat_checkpointer = self.checkpointer
        self.app.state.chat_graph = self.graph
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

    async def request(self, method, path="/chat/conversations", *, token="one", data=None):
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://testserver") as client:
            return await client.request(method, path, headers={"token": token} if token else {}, json=data)

    async def create(self, conversation_id="same-chat", *, token="one", title="第一段对话", created_at=20):
        response = await self.request("POST", token=token, data={"id": conversation_id, "title": title, "createdAt": created_at})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["code"], 1)
        self.assertIsNone(response.json()["msg"])
        return response.json()["data"]

    async def get(self, conversation_id="same-chat", *, token="one"):
        return await self.request("GET", f"/chat/conversations/{conversation_id}", token=token)

    async def import_conversation(self, *, conversation_id="same-chat", title="旧标题", messages=None, token="one"):
        return await self.request("POST", "/chat/conversations/import", token=token, data={
            "id": conversation_id, "title": title, "createdAt": 10, "pinned": True,
            "messages": [legacy_message()] if messages is None else messages,
        })

    async def test_create_list_detail_and_partial_metadata_updates(self):
        created = await self.create(title="  第一段对话  ")
        self.assertEqual(created["id"], "same-chat")
        self.assertEqual(created["title"], "第一段对话")
        self.assertEqual(created["messages"], [])
        pinned = await self.request("PATCH", "/chat/conversations/same-chat", data={"pinned": True})
        self.assertEqual(pinned.status_code, 200, pinned.text)
        renamed = await self.request("PATCH", "/chat/conversations/same-chat", data={"title": "  修改后的标题  "})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["data"]["title"], "修改后的标题")
        self.assertTrue(renamed.json()["data"]["pinned"])
        await self.create("another", created_at=1)
        listed = (await self.request("GET")).json()["data"]
        self.assertEqual({row["id"] for row in listed}, {"same-chat", "another"})
        self.assertTrue(all(row["messages"] == [] for row in listed))
        detail = (await self.get()).json()["data"]
        self.assertEqual(detail["title"], "修改后的标题")
        self.assertTrue(detail["pinned"])

    async def test_same_id_is_private_to_authenticated_user(self):
        await self.create(title="用户一")
        await self.import_conversation(messages=[legacy_message(content="用户一隐私")])
        self.assertEqual((await self.get(token="two")).status_code, 404)
        self.assertEqual((await self.request("GET", token="two")).json()["data"], [])
        await self.create(token="two", title="用户二")
        await self.request("PATCH", "/chat/conversations/same-chat", token="two", data={"title": "用户二的新标题"})
        self.assertEqual((await self.get()).json()["data"]["title"], "用户一")
        second = (await self.get(token="two")).json()["data"]
        self.assertEqual(second["title"], "用户二的新标题")
        self.assertEqual(second["messages"], [])
        await self.request("DELETE", "/chat/conversations/same-chat", token="two")
        self.assertEqual(self.checkpointer.deleted_threads, ["22:same-chat"])
        self.assertEqual((await self.get()).json()["data"]["messages"][0]["content"], "用户一隐私")

    async def test_import_retries_only_fill_missing_messages_and_keep_server_metadata(self):
        await self.create(title="服务端新标题")
        first = await self.import_conversation(messages=[legacy_message("first", "原始内容")])
        self.assertEqual(first.status_code, 200, first.text)
        repeated = await self.import_conversation(title="浏览器旧标题", messages=[
            legacy_message("first", "延迟到达的旧页面内容"),
            legacy_message("second", "另一条旧消息", role="ai", created_at=11),
        ])
        self.assertEqual(repeated.status_code, 200, repeated.text)
        detail = (await self.get()).json()["data"]
        self.assertEqual(detail["title"], "服务端新标题")
        self.assertFalse(detail["pinned"])
        self.assertEqual([(row["id"], row["content"]) for row in detail["messages"]], [
            ("first", "原始内容"), ("second", "另一条旧消息"),
        ])
        self.assertEqual((await self.request("GET")).json()["data"][0]["messages"], [])

    async def test_import_creates_missing_conversation_and_accepts_bounded_chunks(self):
        first = await self.import_conversation(messages=[legacy_message(str(i), str(i), created_at=i) for i in range(100)])
        self.assertEqual(first.status_code, 200, first.text)
        second = await self.import_conversation(messages=[legacy_message("100", "下一批", created_at=100)])
        self.assertEqual(second.status_code, 200, second.text)
        detail = (await self.get()).json()["data"]
        self.assertEqual(len(detail["messages"]), 101)
        self.assertTrue(detail["pinned"])
        too_many = await self.import_conversation(messages=[legacy_message(str(i)) for i in range(101)])
        self.assertEqual(too_many.status_code, 422)
        self.assertEqual(len((await self.get()).json()["data"]["messages"]), 101)

    async def test_delete_removes_display_history_and_model_memory_and_blocks_late_import(self):
        await self.import_conversation()
        deleted = await self.request("DELETE", "/chat/conversations/same-chat")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json(), {"code": 1, "msg": None, "data": None})
        self.assertEqual(self.checkpointer.deleted_threads, ["11:same-chat"])
        self.assertEqual((await self.get()).status_code, 404)
        self.assertEqual((await self.request("GET")).json()["data"], [])
        self.assertEqual((await self.import_conversation()).status_code, 200)
        self.assertEqual((await self.get()).status_code, 404)
        self.assertEqual((await self.request("DELETE", "/chat/conversations/same-chat")).status_code, 200)
        recreated = await self.request("POST", data={"id": "same-chat", "title": "迟到的新建请求"})
        self.assertIn(recreated.status_code, (404, 409))

    async def test_failed_checkpoint_deletion_can_be_retried_without_resurrection(self):
        await self.import_conversation()
        self.checkpointer.error = RuntimeError("private Redis detail")
        async with AsyncClient(transport=ASGITransport(app=self.app, raise_app_exceptions=False), base_url="http://testserver") as client:
            failed = await client.delete("/chat/conversations/same-chat", headers={"token": "one"})
        self.assertGreaterEqual(failed.status_code, 500)
        self.assertNotIn("private", failed.text)
        self.checkpointer.error = None
        self.assertEqual((await self.request("DELETE", "/chat/conversations/same-chat")).status_code, 200)
        self.assertIn("11:same-chat", self.checkpointer.deleted_threads)
        self.assertEqual((await self.get()).status_code, 404)
        self.assertEqual((await self.import_conversation()).status_code, 200)
        self.assertEqual((await self.get()).status_code, 404)

    async def test_stream_persists_matching_ids_and_public_transcript(self):
        await self.create()
        self.graph.chunks = [(AIMessageChunk(content="你好"), {"langgraph_node": "chat"}),
                             (AIMessageChunk(content="，完成"), {"langgraph_node": "chat"})]
        response = await self.request("POST", "/chat/stream", data={
            "conversationId": "same-chat", "message": "问题", "messageId": "user-id", "replyId": "reply-id",
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(parse_events(response.text)[-1]["event"], "done")
        messages = (await self.get()).json()["data"]["messages"]
        self.assertEqual([(message["id"], message["role"], message["content"]) for message in messages], [
            ("user-id", "user", "问题"), ("reply-id", "ai", "你好，完成"),
        ])
        self.assertFalse(messages[1].get("pending", False))
        self.assertFalse(messages[1].get("failed", False))

    async def test_successful_empty_reply_has_public_fallback_without_failure(self):
        await self.create()
        response = await self.request("POST", "/chat/stream", data={"conversationId": "same-chat", "message": "问题"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([event["event"] for event in parse_events(response.text)], ["done"])
        reply = (await self.get()).json()["data"]["messages"][-1]
        self.assertEqual(reply["content"], "模型没有返回文字内容")
        self.assertFalse(reply["pending"])
        self.assertFalse(reply["failed"])

    async def test_redis_failure_returns_public_503_and_logs_only_type(self):
        with patch.object(self.redis, "hgetall", side_effect=RedisConnectionError("redis://:private-credential@private-host/0")):
            with self.assertLogs("core.exception_handlers", level="ERROR") as captured:
                response = await self.request("GET")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json(), {"code": 0, "msg": "聊天存储暂时不可用，请稍后重试", "data": None})
        self.assertIn("ConnectionError", "\n".join(captured.output))
        self.assertNotIn("private", response.text)
        self.assertNotIn("private", "\n".join(captured.output))

    async def test_expired_placeholder_after_process_crash_is_displayed_as_interrupted(self):
        await self.create()
        service = ChatConversationService(self.redis, self.checkpointer)
        with patch("service.chat_conversation._now", return_value=1_000_000):
            reply = await service.begin_reply(11, ChatRequest(conversationId="same-chat", message="问题"))
        # 直接留下占位记录模拟进程退出；读取不依赖原请求继续执行收尾。
        with patch("service.chat_conversation._now", return_value=1_125_000):
            record = (await self.get()).json()["data"]["messages"][-1]
        self.assertFalse(record["pending"])
        self.assertTrue(record["failed"])
        self.assertTrue(record["interrupted"])
        self.assertEqual(record["content"], "回复未完成，请重新发送")
        await service.finish_reply(reply, "", interrupted=True)

    async def test_future_legacy_timestamp_does_not_extend_pending_reply_deadline(self):
        await self.import_conversation(messages=[legacy_message(created_at=9_000_000_000_000)])
        service = ChatConversationService(self.redis, self.checkpointer)
        with patch("service.chat_conversation._now", return_value=1_000_000):
            reply = await service.begin_reply(11, ChatRequest(conversationId="same-chat", message="问题"))
        self.assertGreater(reply.message["createdAt"], 9_000_000_000_000)
        self.assertGreater(reply.message["expiresAt"], 1_119_000)
        self.assertLessEqual(reply.message["expiresAt"], 1_120_000)
        await service.finish_reply(reply, "", interrupted=True)

    async def test_stream_error_keeps_partial_reply_and_releases_lock(self):
        await self.create()
        self.graph.chunks = [(AIMessageChunk(content="部分回答"), {"langgraph_node": "chat"})]
        self.graph.error = RuntimeError("private model detail")
        with self.assertLogs("router.chat", level="ERROR"):
            response = await self.request("POST", "/chat/stream", data={
                "conversationId": "same-chat", "message": "问题", "messageId": "u", "replyId": "a",
            })
        self.assertEqual([event["event"] for event in parse_events(response.text)], ["token", "error"])
        messages = (await self.get()).json()["data"]["messages"]
        self.assertEqual(messages[1]["content"], "部分回答")
        self.assertTrue(messages[1]["failed"])
        self.assertFalse(messages[1].get("pending", False))
        self.assertEqual((await self.request("DELETE", "/chat/conversations/same-chat")).status_code, 200)

    async def test_duplicate_message_ids_do_not_run_model_twice_or_rewrite_history(self):
        await self.create()
        self.graph.chunks = [(AIMessageChunk(content="已完成"), {"langgraph_node": "chat"})]
        body = {"conversationId": "same-chat", "message": "问题", "messageId": "u", "replyId": "a"}
        first = await self.request("POST", "/chat/stream", data=body)
        self.assertEqual(first.status_code, 200, first.text)
        duplicate = await self.request("POST", "/chat/stream", data={**body, "message": "重试的新内容"})
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(len(self.graph.calls), 1)
        messages = (await self.get()).json()["data"]["messages"]
        self.assertEqual([row["content"] for row in messages], ["问题", "已完成"])

    async def test_imported_pending_message_becomes_interrupted_instead_of_staying_busy(self):
        pending = {**legacy_message("unfinished", "", role="ai"), "pending": True, "expiresAt": 9_000_000_000_000}
        imported = await self.import_conversation(messages=[pending])
        self.assertEqual(imported.status_code, 200, imported.text)
        message = (await self.get()).json()["data"]["messages"][0]
        self.assertFalse(message["pending"])
        self.assertTrue(message["interrupted"])
        self.assertTrue(message["failed"])
        self.assertTrue(message["content"])

    async def test_generation_lock_blocks_parallel_reply_and_delete_until_completion(self):
        await self.create()
        self.graph.wait = True
        pending = asyncio.create_task(self.request("POST", "/chat/stream", data={"conversationId": "same-chat", "message": "问题"}))
        try:
            await asyncio.wait_for(self.graph.waiting.wait(), timeout=2)
            deleted = await self.request("DELETE", "/chat/conversations/same-chat")
            self.assertEqual(deleted.status_code, 409, deleted.text)
            second = await self.request("POST", "/chat/stream", data={"conversationId": "same-chat", "message": "并发消息"})
            self.assertEqual(second.status_code, 409, second.text)
            self.assertNotIn("text/event-stream", second.headers["content-type"])
            self.assertEqual(self.checkpointer.deleted_threads, [])
        finally:
            self.graph.release.set()
            await asyncio.wait_for(pending, timeout=2)
        self.assertEqual((await self.request("DELETE", "/chat/conversations/same-chat")).status_code, 200)

    async def test_missing_conversation_does_not_start_model_or_return_sse(self):
        response = await self.request("POST", "/chat/stream", data={"conversationId": "missing", "message": "问题"})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["code"], 0)
        self.assertEqual(self.graph.calls, [])

    async def test_all_conversation_operations_require_authentication(self):
        for method, path, data in (
            ("GET", "/chat/conversations", None),
            ("POST", "/chat/conversations", {"id": "a", "title": "标题"}),
            ("POST", "/chat/conversations/import", {"id": "a", "title": "标题", "createdAt": 1, "messages": []}),
            ("GET", "/chat/conversations/a", None),
            ("PATCH", "/chat/conversations/a", {"pinned": True}),
            ("DELETE", "/chat/conversations/a", None),
        ):
            response = await self.request(method, path, token=None, data=data)
            self.assertEqual(response.status_code, 401, (method, path, response.text))
            self.assertEqual(response.json()["code"], 0)

    async def test_validation_rejects_blank_titles_invalid_identity_and_oversize_content(self):
        for body in (
            {"id": "", "title": "标题"},
            {"id": "a", "title": "  "},
            {"id": "a", "title": "x" * 51},
            {"id": "a", "title": "标题", "user_id": 22},
        ):
            self.assertEqual((await self.request("POST", data=body)).status_code, 422)
        await self.create()
        for body in ({"title": " "}, {"title": "x" * 51}, {"user_id": 22}):
            self.assertEqual((await self.request("PATCH", "/chat/conversations/same-chat", data=body)).status_code, 422)
        invalid_message = await self.import_conversation(messages=[legacy_message(content="x" * 100_001)])
        self.assertEqual(invalid_message.status_code, 422)
        self.assertEqual((await self.get()).json()["data"]["messages"], [])


if __name__ == "__main__":
    unittest.main()

"""会话管理及可展示聊天记录；与模型记忆共用 Redis，但分别保存。"""

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from uuid import uuid4

import anyio
from langgraph.checkpoint.redis.aio import AsyncRedisSaver
from redis.asyncio import Redis

from core.errors import BusinessError
from core.messages import Messages
from repository.chat_conversation import ChatConversationRepository
from schemas.chat_request import (
    ChatRequest, ConversationCreateRequest, ConversationImportRequest, ConversationUpdateRequest,
)

REPLY_TIMEOUT_SECONDS = 120
_LOCK_SECONDS = 180
_UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"


def _now() -> int:
    return time.time_ns() // 1_000_000


@dataclass
class ChatReply:
    user_id: int
    conversation_id: str
    token: str
    message: dict
    deadline: float
    finished: bool = False


class ChatConversationService:
    def __init__(self, redis_client: Redis, checkpointer: AsyncRedisSaver):
        self.repository = ChatConversationRepository(redis_client)
        self.checkpointer = checkpointer

    async def _acquire(self, user_id: int, conversation_id: str) -> str:
        token = uuid4().hex
        if not await self.repository.redis.set(
            self.repository.lock_key(user_id, conversation_id), token, nx=True, ex=_LOCK_SECONDS,
        ):
            raise BusinessError(Messages.CHAT_BUSY, 409)
        return token

    async def _release(self, user_id: int, conversation_id: str, token: str) -> None:
        # 比较令牌后再释放，不能误删其他请求重新取得的锁。
        await self.repository.redis.eval(_UNLOCK, 1, self.repository.lock_key(user_id, conversation_id), token)

    @asynccontextmanager
    async def _locked(self, user_id: int, conversation_id: str) -> AsyncIterator[None]:
        token = await self._acquire(user_id, conversation_id)
        try:
            with anyio.fail_after(REPLY_TIMEOUT_SECONDS):
                yield
        except TimeoutError as error:
            raise BusinessError(Messages.CHAT_UNAVAILABLE, 503) from error
        finally:
            with anyio.CancelScope(shield=True):
                with anyio.move_on_after(12):
                    await self._release(user_id, conversation_id, token)

    async def _get(self, user_id: int, conversation_id: str) -> dict:
        record = await self.repository.get(user_id, conversation_id)
        if record is None:
            raise BusinessError(Messages.CHAT_NOT_FOUND, 404)
        return record

    async def list(self, user_id: int) -> list[dict]:
        return [{**record, "messages": []} for record in await self.repository.list(user_id)]

    async def create(self, user_id: int, data: ConversationCreateRequest) -> dict:
        async with self._locked(user_id, data.id):
            if await self.repository.is_deleted(user_id, data.id):
                raise BusinessError(Messages.CHAT_NOT_FOUND, 404)
            record = await self.repository.get(user_id, data.id)
            if record is None:
                now = _now()
                record = {"id": data.id, "title": data.title, "createdAt": data.created_at if data.created_at is not None else now,
                          "pinned": False, "metadataUpdatedAt": now}
                await self.repository.save(user_id, record)
            return {**record, "messages": []}

    async def get(self, user_id: int, conversation_id: str) -> dict:
        record = await self._get(user_id, conversation_id)
        messages = await self.repository.messages(user_id, conversation_id)
        for message in messages:
            # 服务进程意外退出也不能使占位消息永久停在“正在回复”。
            if message.get("pending") and message.get("expiresAt", 0) <= _now():
                message.update(pending=False, failed=True, interrupted=True)
                message["content"] = message["content"] or Messages.CHAT_REPLY_INTERRUPTED
        # 读取消息期间发生删除时，不向客户端重新返回已删除会话。
        await self._get(user_id, conversation_id)
        return {**record, "messages": messages}

    async def update(self, user_id: int, conversation_id: str, data: ConversationUpdateRequest) -> dict:
        async with self._locked(user_id, conversation_id):
            record = await self._get(user_id, conversation_id)
            record.update(data.model_dump(exclude_unset=True))
            record["metadataUpdatedAt"] = max(_now(), record["metadataUpdatedAt"] + 1)
            await self.repository.save(user_id, record)
            return {**record, "messages": []}

    async def delete(self, user_id: int, conversation_id: str) -> None:
        async with self._locked(user_id, conversation_id):
            await self.repository.mark_deleted(user_id, conversation_id)
            # 包含用户编号的 thread_id 与 ChatService 中的模型记忆命名一致。
            # 清理失败保留墓碑并返回错误，重复删除可继续清理，不会重新出现。
            await self.checkpointer.adelete_thread(f"{user_id}:{conversation_id}")
            await self.repository.remove(user_id, conversation_id)

    async def import_conversation(self, user_id: int, data: ConversationImportRequest) -> None:
        async with self._locked(user_id, data.id):
            if await self.repository.is_deleted(user_id, data.id):
                return
            record = await self.repository.get(user_id, data.id)
            if record is None:
                record = data.model_dump(by_alias=True, exclude={"messages"})
                record["metadataUpdatedAt"] = data.metadata_updated_at or data.created_at
                await self.repository.save(user_id, record)
            for item in data.messages:
                message = item.model_dump(by_alias=True, exclude_none=True)
                message["conversationId"] = data.id
                if message["pending"]:
                    message.update(pending=False, failed=True, interrupted=True)
                    message["content"] = message["content"] or Messages.CHAT_REPLY_INTERRUPTED
                # 迁移可重复执行，旧浏览器快照不能覆盖服务器上的新版本。
                await self.repository.save_message(user_id, data.id, message, only_if_missing=True)
            if data.messages:
                record["lastMessageAt"] = max(record.get("lastMessageAt", 0), max(item.created_at for item in data.messages))
                await self.repository.save(user_id, record)

    async def begin_reply(self, user_id: int, data: ChatRequest) -> ChatReply:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + REPLY_TIMEOUT_SECONDS
        token = await self._acquire(user_id, data.conversation_id)
        try:
            # 预写入和模型运行使用同一截止时间，慢 Redis 也不能耗尽锁的安全余量。
            async with asyncio.timeout_at(deadline):
                record = await self._get(user_id, data.conversation_id)
                message_id, reply_id = data.message_id or uuid4().hex, data.reply_id or uuid4().hex
                for identifier in (message_id, reply_id):
                    if await self.repository.get_message(user_id, data.conversation_id, identifier):
                        raise BusinessError(Messages.CHAT_DUPLICATE_MESSAGE, 409)
                # 毫秒内连续提交或导入过较晚的客户端时间，也保持消息顺序。
                now = max(_now(), record.get("lastMessageAt", 0) + 1)
                record["lastMessageAt"] = now + 1
                await self.repository.save(user_id, record)
                user_message = {"id": message_id, "role": "user", "content": data.message,
                                "createdAt": now, "updatedAt": now, "conversationId": data.conversation_id}
                reply = {"id": reply_id, "role": "ai", "content": "", "createdAt": now + 1,
                         "updatedAt": now + 1, "conversationId": data.conversation_id, "pending": True,
                         # 过期时间只依赖服务器时钟，不使用导入记录中的客户端时间。
                         "expiresAt": _now() + max(0, int((deadline - loop.time()) * 1000))}
                await self.repository.save_message(user_id, data.conversation_id, user_message)
                await self.repository.save_message(user_id, data.conversation_id, reply)
                return ChatReply(user_id, data.conversation_id, token, reply, deadline)
        except BaseException as error:
            with anyio.CancelScope(shield=True):
                with anyio.move_on_after(12):
                    await self._release(user_id, data.conversation_id, token)
            if isinstance(error, TimeoutError):
                raise BusinessError(Messages.CHAT_UNAVAILABLE, 503) from error
            raise

    async def finish_reply(self, reply: ChatReply, content: str, *, failed: bool = False, interrupted: bool = False) -> None:
        if reply.finished:
            return
        try:
            token = await self.repository.redis.get(self.repository.lock_key(reply.user_id, reply.conversation_id))
            if token not in (reply.token, reply.token.encode()):
                return
            if await self.repository.get(reply.user_id, reply.conversation_id) is not None:
                message = {**reply.message, "content": content or (
                    Messages.CHAT_REPLY_INTERRUPTED if interrupted else (
                        Messages.CHAT_REPLY_FAILED if failed else Messages.CHAT_REPLY_EMPTY
                    )
                ), "updatedAt": _now(), "pending": False, "failed": failed or interrupted,
                           "interrupted": interrupted}
                message.pop("expiresAt", None)
                await self.repository.save_message(reply.user_id, reply.conversation_id, message)
        finally:
            await self._release(reply.user_id, reply.conversation_id, reply.token)
            reply.finished = True

"""Redis 会话记录访问；所有键均包含后端认证得到的用户编号。"""

from __future__ import annotations

import json
from urllib.parse import quote

from redis.asyncio import Redis


class ChatConversationRepository:
    # 保存应用共享的 Redis 客户端
    def __init__(self, redis_client: Redis):
        self.redis = redis_client

    # 生成包含用户编号的聊天键前缀
    @staticmethod
    def _prefix(user_id: int) -> str:
        return f"managehub:chat:{user_id}:"

    # 生成用户指定会话的消息存储键
    def _messages_key(self, user_id: int, conversation_id: str) -> str:
        return self._prefix(user_id) + "messages:" + quote(conversation_id, safe="")

    # 生成用户指定会话的互斥锁键
    def lock_key(self, user_id: int, conversation_id: str) -> str:
        return self._prefix(user_id) + "lock:" + quote(conversation_id, safe="")

    # 查询会话是否已有删除标记
    async def is_deleted(self, user_id: int, conversation_id: str) -> bool:
        return bool(await self.redis.sismember(self._prefix(user_id) + "deleted", conversation_id))

    # 读取未删除会话，按置顶和创建时间排序
    async def list(self, user_id: int) -> list[dict]:
        values = await self.redis.hgetall(self._prefix(user_id) + "conversations")
        deleted = await self.redis.smembers(self._prefix(user_id) + "deleted")
        deleted_ids = {item.decode() if isinstance(item, bytes) else item for item in deleted}
        records = [json.loads(value) for value in values.values()]
        return sorted((item for item in records if item["id"] not in deleted_ids),
                      key=lambda item: (not item["pinned"], item["createdAt"], item["id"]))

    # 读取未删除会话的元数据
    async def get(self, user_id: int, conversation_id: str) -> dict | None:
        if await self.is_deleted(user_id, conversation_id):
            return None
        return await self.get_record(user_id, conversation_id)

    # 只读取会话元数据，不重复查询删除标记
    async def get_record(self, user_id: int, conversation_id: str) -> dict | None:
        """只读记录；创建和导入在持锁确认未删除后复用，避免再次查询删除标记。"""
        value = await self.redis.hget(self._prefix(user_id) + "conversations", conversation_id)
        return json.loads(value) if value is not None else None

    # 保存指定用户的会话元数据
    async def save(self, user_id: int, record: dict) -> None:
        await self.redis.hset(self._prefix(user_id) + "conversations", record["id"], json.dumps(record, ensure_ascii=False))

    # 读取会话消息并按创建时间排序
    async def messages(self, user_id: int, conversation_id: str) -> list[dict]:
        values = await self.redis.hgetall(self._messages_key(user_id, conversation_id))
        return sorted((json.loads(value) for value in values.values()), key=lambda item: (item["createdAt"], item["id"]))

    # 按消息编号读取单条会话消息
    async def get_message(self, user_id: int, conversation_id: str, message_id: str) -> dict | None:
        value = await self.redis.hget(self._messages_key(user_id, conversation_id), message_id)
        return json.loads(value) if value is not None else None

    # 保存消息，导入时可选择仅写入缺失项
    async def save_message(self, user_id: int, conversation_id: str, message: dict, *, only_if_missing: bool = False) -> None:
        method = self.redis.hsetnx if only_if_missing else self.redis.hset
        await method(self._messages_key(user_id, conversation_id), message["id"], json.dumps(message, ensure_ascii=False))

    # 记录会话删除标记，防止旧数据重新导入
    async def mark_deleted(self, user_id: int, conversation_id: str) -> None:
        # 先保存墓碑，失败重试和其他设备的旧导入不能重新创建此 ID。
        await self.redis.sadd(self._prefix(user_id) + "deleted", conversation_id)

    # 删除会话元数据及消息，保留删除标记
    async def remove(self, user_id: int, conversation_id: str) -> None:
        await self.redis.hdel(self._prefix(user_id) + "conversations", conversation_id)
        await self.redis.delete(self._messages_key(user_id, conversation_id))

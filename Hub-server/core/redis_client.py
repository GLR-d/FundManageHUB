from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from langgraph.checkpoint.redis.aio import AsyncRedisSaver
from redis.asyncio import Redis


@asynccontextmanager
async def open_redis(redis_url: str) -> AsyncIterator[Redis]:
    """会话列表与 checkpointer 共用此客户端及其连接池。"""
    client = Redis.from_url(redis_url, socket_connect_timeout=5, socket_timeout=10)
    try:
        yield client
    finally:
        await client.aclose()


@asynccontextmanager
async def open_checkpointer(redis_client: Redis) -> AsyncIterator[AsyncRedisSaver]:
    # 客户端由 open_redis 统一关闭，saver 只管理自己的初始化和退出。
    async with AsyncRedisSaver(redis_client=redis_client) as checkpointer:
        yield checkpointer

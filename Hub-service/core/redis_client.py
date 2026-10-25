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
async def open_checkpointer(
    redis_url: str,
    redis_client: Redis | None = None,
) -> AsyncIterator[AsyncRedisSaver]:
    if redis_client is None:
        async with open_redis(redis_url) as client:
            async with open_checkpointer(redis_url, client) as checkpointer:
                yield checkpointer
    else:
        # 外部提供客户端时 saver 不负责关闭，避免重复释放共用连接。
        async with AsyncRedisSaver(redis_client=redis_client) as checkpointer:
            yield checkpointer

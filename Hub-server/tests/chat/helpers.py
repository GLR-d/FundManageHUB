"""聊天离线测试的异常处理映射与 Redis 替身，不连接开发库。"""

import time

from fastapi.exceptions import RequestValidationError
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from core.exception_handlers import (
    BusinessError, business_error_handler, database_error_handler, http_error_handler,
    redis_error_handler, unexpected_error_handler, validation_error_handler,
)

# 与主应用使用相同处理器，离线测试直接在 FastAPI 构造时注册。
EXCEPTION_HANDLERS = {
    BusinessError: business_error_handler,
    RequestValidationError: validation_error_handler,
    SQLAlchemyError: database_error_handler,
    RedisError: redis_error_handler,
    StarletteHTTPException: http_error_handler,
    Exception: unexpected_error_handler,
}


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.deadlines = {}

    @staticmethod
    def encode(value):
        return value if isinstance(value, bytes) else str(value).encode()

    def _value(self, name, factory=None):
        key = self.encode(name)
        if self.deadlines.get(key, float("inf")) <= time.monotonic():
            self.values.pop(key, None)
            self.deadlines.pop(key, None)
        if factory is not None:
            return self.values.setdefault(key, factory())
        return self.values.get(key)

    async def get(self, name):
        return self._value(name)

    async def set(self, name, value, *, nx=False, ex=None):
        if nx and self._value(name) is not None:
            return None
        key = self.encode(name)
        self.values[key] = self.encode(value)
        if ex is not None:
            self.deadlines[key] = time.monotonic() + ex
        else:
            self.deadlines.pop(key, None)
        return True

    async def delete(self, *names):
        count = 0
        for name in names:
            key = self.encode(name)
            count += int(self._value(key) is not None)
            self.values.pop(key, None)
            self.deadlines.pop(key, None)
        return count

    async def hget(self, name, key):
        return (self._value(name) or {}).get(self.encode(key))

    async def hgetall(self, name):
        return dict(self._value(name) or {})

    async def hset(self, name, key=None, value=None, *, mapping=None):
        target = self._value(name, dict)
        values = mapping if mapping is not None else {key: value}
        count = 0
        for field, item in values.items():
            field = self.encode(field)
            count += int(field not in target)
            target[field] = self.encode(item)
        return count

    async def hsetnx(self, name, key, value):
        target = self._value(name, dict)
        field = self.encode(key)
        if field in target:
            return 0
        target[field] = self.encode(value)
        return 1

    async def hdel(self, name, *keys):
        target = self._value(name) or {}
        count = 0
        for key in keys:
            count += int(self.encode(key) in target)
            target.pop(self.encode(key), None)
        return count

    async def sadd(self, name, *values):
        target = self._value(name, set)
        previous = len(target)
        target.update(self.encode(value) for value in values)
        return len(target) - previous

    async def sismember(self, name, value):
        return self.encode(value) in (self._value(name) or set())

    async def smembers(self, name):
        return set(self._value(name) or set())

    async def eval(self, script, key_count, *arguments):
        # 只支持安全释放锁的通用 compare-and-delete Lua；不模拟业务脚本。
        if key_count != 1 or len(arguments) != 2 or "redis.call" not in script:
            raise AssertionError("测试替身未实现此 Lua 命令")
        name, token = arguments
        if await self.get(name) == self.encode(token):
            return await self.delete(name)
        return 0

class FakeCheckpointer:
    def __init__(self):
        self.deleted_threads = []
        self.error = None

    async def adelete_thread(self, thread_id):
        if self.error is not None:
            raise self.error
        self.deleted_threads.append(thread_id)

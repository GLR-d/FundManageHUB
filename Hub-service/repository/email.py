"""邮箱一次性凭据和邮件发送频率的数据访问。"""

from datetime import datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.security import hash_secret
from models.auth import AuthEmailCode, AuthEmailRateLimit


class EmailRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def allow_request(self, scope: str, identifier: str, limit: int, seconds: int, now: datetime) -> bool:
        key = hash_secret(scope + "\0" + identifier)
        # 首次请求也通过唯一主键和行锁串行化，多个进程共享同一频率限制。
        statement = insert(AuthEmailRateLimit).values(hash_key=key, window_start=now, count=0)
        await self.session.execute(statement.on_duplicate_key_update(hash_key=key))
        row = (await self.session.execute(
            select(AuthEmailRateLimit).where(AuthEmailRateLimit.hash_key == key).with_for_update()
        )).scalar_one()
        if row.window_start <= now - timedelta(seconds=seconds):
            row.window_start, row.count = now, 0
        if row.count >= limit:
            return False
        row.count += 1
        await self.session.flush()
        return True

    async def clean_old_limits(self, now: datetime) -> None:
        await self.session.execute(delete(AuthEmailRateLimit).where(
            AuthEmailRateLimit.window_start < now - timedelta(days=1),
        ).with_dialect_options(mysql_limit=1000))

    async def get_code(self, hash_key: str, *, for_update=False) -> dict | None:
        statement = select(*AuthEmailCode.__table__.c).where(AuthEmailCode.hash_key == hash_key)
        if for_update:
            statement = statement.with_for_update()
        row = (await self.session.execute(statement)).mappings().first()
        return dict(row) if row else None

    async def delete_codes(self, user_id: int, purpose: str | None = None) -> None:
        statement = delete(AuthEmailCode).where(AuthEmailCode.user_id == user_id)
        if purpose is not None:
            statement = statement.where(AuthEmailCode.purpose == purpose)
        await self.session.execute(statement)

    async def create_code(self, **values) -> None:
        self.session.add(AuthEmailCode(**values))

    async def delete_code(self, hash_key: str) -> None:
        # 注册没有用户编号，必须按当前邮箱对应的主键删除，不能删除其他注册验证码。
        await self.session.execute(delete(AuthEmailCode).where(AuthEmailCode.hash_key == hash_key))

    async def record_failed_attempt(self, hash_key: str) -> None:
        await self.session.execute(update(AuthEmailCode).where(AuthEmailCode.hash_key == hash_key).values(
            attempt_count=AuthEmailCode.attempt_count + 1,
        ))

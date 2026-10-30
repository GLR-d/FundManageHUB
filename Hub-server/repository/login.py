"""通过 SQLAlchemy 读取验证码、登录会话及密码失败计数。"""

from datetime import datetime
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models.auth import AuthCaptcha, AuthSession
from models.user import User


class LoginRepository:
    # 保存登录数据读写使用的数据库会话
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # 分批删除过期验证码和登录会话
    async def clean_expired(self, now: datetime) -> None:
        # 每次只清理有限条记录，避免获取验证码时长时间锁住整张表。
        for model in (AuthCaptcha, AuthSession):
            statement = (
                delete(model)
                .where(model.expires_at <= now)
                .with_dialect_options(mysql_limit=1000)
            )
            await self.session.execute(statement)

    # 登记验证码摘要、浏览器绑定和有效期
    async def create_captcha(self, uuid, browser_token_hash, code_hash, expires_at) -> None:
        self.session.add(AuthCaptcha(
            uuid=uuid,
            browser_token_hash=browser_token_hash,
            code_hash=code_hash,
            expires_at=expires_at,
        ))

    # 读取并锁定指定验证码记录
    async def get_captcha(self, uuid: str) -> dict[str, Any] | None:
        statement = (
            select(*AuthCaptcha.__table__.c)
            .where(AuthCaptcha.uuid == uuid)
            .with_for_update()
        )
        result = await self.session.execute(statement)
        row = result.mappings().first()
        return dict(row) if row is not None else None

    # 增加验证码错误次数并清除已验证状态
    async def fail_captcha(self, uuid: str) -> None:
        statement = (
            update(AuthCaptcha)
            .where(AuthCaptcha.uuid == uuid)
            .values(attempt_count=AuthCaptcha.attempt_count + 1, verified_at=None)
        )
        await self.session.execute(statement)

    # 记录验证码通过验证的时间
    async def verify_captcha(self, uuid: str, now: datetime) -> None:
        statement = update(AuthCaptcha).where(AuthCaptcha.uuid == uuid).values(verified_at=now)
        await self.session.execute(statement)

    # 删除已使用的验证码记录
    async def consume_captcha(self, uuid: str) -> None:
        await self.session.execute(delete(AuthCaptcha).where(AuthCaptcha.uuid == uuid))

    # 按邮箱读取并锁定登录用户记录
    async def get_user_by_email(self, email: str) -> dict[str, Any] | None:
        statement = select(*User.__table__.c).where(User.email == email).with_for_update()
        result = await self.session.execute(statement)
        row = result.mappings().first()
        return dict(row) if row is not None else None

    # 保存密码错误次数和账号锁定期限
    async def record_password_failure(self, user_id: int, failures: int, locked_until) -> None:
        statement = (
            update(User).where(User.id == user_id)
            .values(login_failures=failures, locked_until=locked_until)
        )
        await self.session.execute(statement)

    # 清除密码失败记录，可同时更新登录时间
    async def reset_password_failures(self, user_id: int, *, login_at=None) -> None:
        values = {"login_failures": 0, "locked_until": None}
        if login_at is not None:
            values["last_login_at"] = login_at
        await self.session.execute(update(User).where(User.id == user_id).values(**values))

    # 登记令牌摘要、用户和登录有效期
    async def create_session(self, token_hash: str, user_id: int, expires_at: datetime) -> None:
        self.session.add(AuthSession(
            token_hash=token_hash, user_id=user_id, expires_at=expires_at,
        ))

    # 读取登录会话，按需加锁或关联账号状态
    async def get_session(self, token_hash: str, *, for_update=False) -> dict[str, Any] | None:
        statement = select(*AuthSession.__table__.c).where(AuthSession.token_hash == token_hash)
        if for_update:
            statement = statement.with_for_update()
        else:
            statement = statement.add_columns(User.is_active).join(User, User.id == AuthSession.user_id)
        result = await self.session.execute(statement)
        row = result.mappings().first()
        return dict(row) if row is not None else None

    # 撤销用户当前令牌对应的登录会话
    async def revoke_session(self, user_id: int, token_hash: str) -> None:
        await self.session.execute(delete(AuthSession).where(
            AuthSession.user_id == user_id, AuthSession.token_hash == token_hash,
        ))

    # 撤销用户的全部登录会话
    async def revoke_user_sessions(self, user_id: int) -> None:
        await self.session.execute(delete(AuthSession).where(AuthSession.user_id == user_id))

    # 保留当前令牌，撤销用户其他登录会话
    async def revoke_other_sessions(self, user_id: int, current_token_hash: str) -> None:
        await self.session.execute(delete(AuthSession).where(
            AuthSession.user_id == user_id, AuthSession.token_hash != current_token_hash,
        ))

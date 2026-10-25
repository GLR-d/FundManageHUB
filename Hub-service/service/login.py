"""验证码验证、密码登录、退出登录和失败锁定。"""

import secrets
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core.config import Settings
from core.errors import BusinessError
from core.jwt_tokens import SessionIdentity, create_access_token
from core.messages import Messages
from core.security import (
    CAPTCHA_VERIFICATION_SECONDS,
    DUMMY_PASSWORD_HASH,
    MAX_CAPTCHA_ATTEMPTS,
    generate_captcha_code,
    hash_captcha,
    hash_secret,
    next_password_failure,
    render_captcha,
    utcnow,
    verify_password,
)
from repository.login import LoginRepository
from repository.user import UserRepository
from schemas.auth_request import LoginRequest
from schemas.auth_response import CaptchaData, LoginData
from service.image_urls import ImageUrls


class LoginService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.repository = LoginRepository(session)

    async def create_captcha(self) -> tuple[CaptchaData, str]:
        """保存验证码摘要，分别返回图片数据和绑定浏览器的 Cookie。"""
        uuid = str(uuid4())
        browser_token = secrets.token_urlsafe(32)
        code = generate_captcha_code()
        # 绘图交给线程池，异步请求可以继续处理其他连接。
        image = await run_in_threadpool(render_captcha, code)
        now = utcnow()
        expires_at = now + timedelta(seconds=self.settings.captcha_ttl)
        browser_token_hash = hash_secret(browser_token)
        code_hash = hash_captcha(uuid, code)
        await self.repository.clean_expired(now)
        await self.repository.create_captcha(
            uuid, browser_token_hash, code_hash, expires_at,
        )
        await self.session.commit()
        captcha_data = CaptchaData(uuid=uuid, image=image)
        browser_cookie = f"{uuid}.{browser_token}"
        return captcha_data, browser_cookie

    async def _validate_captcha(
        self,
        uuid: str,
        code: str,
        browser_cookie: str | None,
        *,
        require_verified: bool = False,
    ) -> dict[str, Any]:
        """同时校验验证码内容、有效期和浏览器绑定。"""
        try:
            cookie_uuid, browser_token = (browser_cookie or "").split(".", 1)
        except ValueError:
            raise BusinessError(Messages.CAPTCHA_INVALID)
        if cookie_uuid != uuid or len(browser_token) > 128:
            raise BusinessError(Messages.CAPTCHA_INVALID)
        captcha = await self.repository.get_captcha(uuid)
        now = utcnow()
        if not captcha or captcha["expires_at"] <= now:
            raise BusinessError(Messages.CAPTCHA_EXPIRED)
        browser_token_hash = hash_secret(browser_token)
        if not secrets.compare_digest(captcha["browser_token_hash"], browser_token_hash):
            raise BusinessError(Messages.CAPTCHA_INVALID)
        if captcha["attempt_count"] >= MAX_CAPTCHA_ATTEMPTS:
            raise BusinessError(Messages.CAPTCHA_ATTEMPTS_EXCEEDED)
        code_hash = hash_captcha(uuid, code)
        if not secrets.compare_digest(captcha["code_hash"], code_hash):
            await self.repository.fail_captcha(uuid)
            # 失败也要提交，才能保存尝试次数并清除此前的验证状态。
            await self.session.commit()
            raise BusinessError(Messages.CAPTCHA_INCORRECT)
        if require_verified:
            verified_at = captcha["verified_at"]
            if verified_at is None:
                raise BusinessError(Messages.CAPTCHA_VERIFICATION_REQUIRED)
            seconds_since_verification = (now - verified_at).total_seconds()
            if seconds_since_verification > CAPTCHA_VERIFICATION_SECONDS:
                raise BusinessError(Messages.CAPTCHA_VERIFICATION_REQUIRED)
        return captcha

    async def verify_captcha(self, uuid: str, code: str, browser_cookie: str | None) -> None:
        await self._validate_captcha(uuid, code, browser_cookie)
        await self.repository.verify_captcha(uuid, utcnow())
        await self.session.commit()

    async def logout(self, identity: SessionIdentity) -> None:
        # 仅撤销本次请求使用的会话，保留其他设备的登录状态。
        await self.repository.revoke_session(identity.user_id, identity.token_hash)
        await self.session.commit()

    async def login(self, data: LoginRequest, browser_cookie: str | None) -> LoginData:
        """校验验证码与密码，成功后创建 JWT 及对应的数据库会话。"""
        uuid = (browser_cookie or "").split(".", 1)[0]
        await self._validate_captcha(uuid, data.captcha, browser_cookie, require_verified=True)
        # 一次登录尝试消耗一次验证码，密码错误时也不能重复使用。
        await self.repository.consume_captcha(uuid)
        user = await self.repository.get_user_by_email(data.email)
        now = utcnow()
        password = data.password.get_secret_value()
        # 账号不存在时也执行密码哈希校验，减小通过响应耗时猜测账号的差异。
        password_hash = DUMMY_PASSWORD_HASH
        if user:
            password_hash = user["password_hash"]
        # 密码哈希计算耗时较长，避免占用事件循环。
        password_ok = await run_in_threadpool(verify_password, password, password_hash)

        locked = False
        if user and user["locked_until"]:
            locked = user["locked_until"] > now

        if not user or not user["is_active"] or user["email_verified_at"] is None or locked or not password_ok:
            if user and not locked and user["is_active"]:
                failures, locked_until = next_password_failure(
                    user["login_failures"], user["locked_until"], now,
                )
                await self.repository.record_password_failure(user["id"], failures, locked_until)
            # 保存失败次数和验证码消费；不能等登录成功才提交。
            await self.session.commit()
            raise BusinessError(Messages.LOGIN_FAILED)

        token = create_access_token(user["id"], self.settings, issued_at=now)
        token_hash = hash_secret(token)
        session_expires_at = now.replace(microsecond=0) + timedelta(seconds=self.settings.session_ttl)
        await self.repository.reset_password_failures(user["id"], login_at=now)
        await self.repository.create_session(
            token_hash, user["id"], session_expires_at,
        )
        user_repository = UserRepository(self.session)
        updated_user = await user_repository.get_by_id(user["id"])
        await self.session.commit()
        updated_user["avatar"] = await ImageUrls(self.settings, user["id"]).display(updated_user["avatar"])
        return LoginData(**updated_user, token=token)

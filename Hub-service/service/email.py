"""邮箱注册、换绑和找回密码共用验证码发送、校验与失效逻辑。"""

import hmac
import secrets
from datetime import timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core.config import Settings
from core.errors import BusinessError
from core.jwt_tokens import SessionIdentity
from core.mail import ensure_mail_config
from core.messages import Messages
from core.security import hash_password, hash_secret, utcnow
from repository.email import EmailRepository
from repository.login import LoginRepository
from repository.user import UserRepository
from schemas.auth_response import EmailVerificationGrant, PublicUser
from service.image_urls import ImageUrls
from service.user import UserService

EMAIL_CODE_TTL_SECONDS = 60
EMAIL_CODE_RESEND_SECONDS = 60
EMAIL_CODE_MAX_ATTEMPTS = 5
EMAIL_GRANT_TTL_SECONDS = 300


def generate_email_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


class EmailService:
    def __init__(self, session: AsyncSession, settings: Settings):
        self.session = session
        self.settings = settings
        self.repository = EmailRepository(session)
        self.users = UserRepository(session)
        self.logins = LoginRepository(session)

    @staticmethod
    def state_hash(user: dict | None) -> str:
        if user is None:
            return ""
        # 邮箱或密码改变后，之前发出的验证码不能继续使用。
        return hash_secret("\0".join((user["password_hash"], user["email"], str(user["email_verified_at"]))))

    @staticmethod
    def code_key(user_id: int | None, purpose: str, email: str) -> str:
        return hash_secret(f"{purpose}\0{user_id or 0}\0{email}")

    def code_hash(self, hash_key: str, code: str) -> str:
        # 六位数字不能只做普通摘要，否则数据库泄露后可直接穷举所有验证码。
        return hmac.new(
            self.settings.jwt_secret_key.encode("utf-8"),
            f"email-code\0{hash_key}\0{code}".encode("utf-8"), "sha256",
        ).hexdigest()

    async def _rate_limit(self, email: str, ip: str) -> None:
        now = utcnow()
        await self.repository.clean_old_limits(now)
        # 先释放清理过期记录产生的范围锁，再创建/锁定当前请求计数。
        await self.session.commit()
        ip_allowed = await self.repository.allow_request("email-ip", ip, 10, 600, now)
        email_allowed = await self.repository.allow_request(
            "email-address", email, 1, EMAIL_CODE_RESEND_SECONDS, now,
        ) if ip_allowed else False
        await self.session.commit()
        if not ip_allowed:
            raise BusinessError(Messages.EMAIL_REQUEST_LIMIT, 429)
        if not email_allowed:
            raise BusinessError(Messages.EMAIL_RESEND_LIMIT, 429)

    async def _issue(self, user: dict | None, purpose: str, email: str) -> tuple[str, str, str]:
        code = generate_email_code()
        now = utcnow()
        user_id = user["id"] if user else None
        hash_key = self.code_key(user_id, purpose, email)
        if user:
            # 同一用户、同一用途仅保留最新验证码。
            await self.repository.delete_codes(user_id, purpose)
            if purpose in ("change_password", "change_email"):
                await self.repository.delete_codes(user_id, "password_grant" if purpose == "change_password" else "email_grant")
        else:
            # 注册尚无用户，重发只能覆盖当前邮箱，不能清掉其他邮箱的注册验证码。
            await self.repository.delete_code(hash_key)
        await self.repository.create_code(
            hash_key=hash_key, user_id=user_id, purpose=purpose, email=email,
            code_hash=self.code_hash(hash_key, code), state_hash=self.state_hash(user), attempt_count=0,
            expires_at=now + timedelta(seconds=EMAIL_CODE_TTL_SECONDS), created_at=now,
        )
        await self.session.commit()
        title = {"register": "注册账号", "bind": "更换邮箱", "reset": "重置密码", "change_password": "更改密码", "change_email": "更换邮箱"}[purpose]
        return email, f"花销管理 - {title}", f"您的{title}验证码为：{code}\n\n验证码1分钟内有效，只能使用一次。若非本人操作，请忽略此邮件。"

    async def request_registration(self, email: str, ip: str) -> tuple[str, str, str] | None:
        email = email.strip().lower()
        ensure_mail_config(self.settings)
        await self._rate_limit(email, ip)
        if await self.users.get_by_email(email):
            # 与找回密码一致，发送接口不透露邮箱是否已注册。
            await self.session.commit()
            return None
        return await self._issue(None, "register", email)

    async def _check_email_available(self, user_id: int, email: str) -> None:
        owner = await self.users.get_by_email(email)
        if owner and owner["id"] != user_id:
            raise BusinessError(Messages.EMAIL_ALREADY_BOUND)

    async def request_binding(
        self, identity: SessionIdentity, email: str, ip: str, verification_token: str = "",
    ) -> tuple[str, str, str]:
        email = email.strip().lower()
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        await self._check_grant(user, identity, "email_grant", verification_token)
        ensure_mail_config(self.settings)
        await self._rate_limit(email, ip)
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        await self._check_grant(user, identity, "email_grant", verification_token)
        await self._check_email_available(user["id"], email)
        return await self._issue(user, "bind", email)

    @staticmethod
    def _check_bound_email(user: dict, email: str) -> None:
        if user["email_verified_at"] is None or user["email"] != email:
            raise BusinessError(Messages.BOUND_EMAIL_REQUIRED)

    async def request_password_change(
        self, identity: SessionIdentity, email: str, ip: str,
    ) -> tuple[str, str, str]:
        email = email.strip().lower()
        ensure_mail_config(self.settings)
        # 改密验证码仅发送到当前账号的已验证邮箱，不接受其他用户的邮箱。
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        await self._rate_limit(email, ip)
        # 限流会提交事务，发码前重新锁定并确认会话和邮箱没有变化。
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        return await self._issue(user, "change_password", email)

    async def request_email_change(
        self, identity: SessionIdentity, email: str, ip: str,
    ) -> tuple[str, str, str]:
        email = email.strip().lower()
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        ensure_mail_config(self.settings)
        await self._rate_limit(email, ip)
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        return await self._issue(user, "change_email", email)

    def _grant_state(self, user: dict, identity: SessionIdentity) -> str:
        return hash_secret(identity.token_hash + "\0" + self.state_hash(user))

    async def verify_current_email(
        self, identity: SessionIdentity, email: str, code: str, purpose: str,
    ) -> EmailVerificationGrant:
        email = email.strip().lower()
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        code_key = await self._check_code(user, purpose, email, code)
        grant_purpose = "password_grant" if purpose == "change_password" else "email_grant"
        token = secrets.token_urlsafe(32)
        key = self.code_key(user["id"], grant_purpose, token)
        now = utcnow()
        await self.repository.delete_code(code_key)
        await self.repository.delete_codes(user["id"], grant_purpose)
        await self.repository.create_code(
            hash_key=key, user_id=user["id"], purpose=grant_purpose, email=email,
            code_hash=self.code_hash(key, token), state_hash=self._grant_state(user, identity),
            attempt_count=0, expires_at=now + timedelta(seconds=EMAIL_GRANT_TTL_SECONDS), created_at=now,
        )
        await self.session.commit()
        return EmailVerificationGrant(verificationToken=token, expiresIn=EMAIL_GRANT_TTL_SECONDS)

    async def _check_grant(self, user: dict, identity: SessionIdentity, purpose: str, token: str) -> None:
        if not token:
            raise BusinessError(Messages.EMAIL_VERIFICATION_EXPIRED, 428)
        key = self.code_key(user["id"], purpose, token)
        row = await self.repository.get_code(key, for_update=True)
        if (
            not row or row["user_id"] != user["id"] or row["purpose"] != purpose
            or row["email"] != user["email"] or user["email_verified_at"] is None
            or row["expires_at"] <= utcnow()
            or not secrets.compare_digest(row["state_hash"], self._grant_state(user, identity))
            or not secrets.compare_digest(row["code_hash"], self.code_hash(key, token))
        ):
            raise BusinessError(Messages.EMAIL_VERIFICATION_EXPIRED, 428)

    async def change_verified_password(self, identity: SessionIdentity, token: str, password: str) -> None:
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        await self._check_grant(user, identity, "password_grant", token)
        password_hash = await run_in_threadpool(hash_password, password)
        await self.users.update_password(user["id"], password_hash)
        await self.repository.delete_codes(user["id"])
        await self.logins.revoke_user_sessions(user["id"])
        await self.session.commit()

    async def request_password_reset(self, email: str, ip: str) -> tuple[str, str, str] | None:
        email = email.strip().lower()
        ensure_mail_config(self.settings)
        await self._rate_limit(email, ip)
        user = await self.users.get_by_email(email, for_update=True)
        if not user or not user["is_active"] or user["email_verified_at"] is None:
            await self.session.commit()
            return None
        return await self._issue(user, "reset", email)

    async def _check_code(self, user: dict | None, purpose: str, email: str, code: str) -> str:
        # 已有账号由调用方先锁用户再锁验证码；注册只锁当前邮箱的验证码。
        user_id = user["id"] if user else None
        hash_key = self.code_key(user_id, purpose, email)
        row = await self.repository.get_code(hash_key, for_update=True)
        if (
            not row or row["user_id"] != user_id or row["purpose"] != purpose or row["email"] != email
            or row["expires_at"] <= utcnow() or row["attempt_count"] >= EMAIL_CODE_MAX_ATTEMPTS
            or not secrets.compare_digest(row["state_hash"], self.state_hash(user))
        ):
            raise BusinessError(Messages.EMAIL_CODE_INVALID)
        if not secrets.compare_digest(row["code_hash"], self.code_hash(hash_key, code)):
            await self.repository.record_failed_attempt(hash_key)
            # 错误次数也必须提交，避免错误响应回滚后绕过尝试次数。
            await self.session.commit()
            raise BusinessError(Messages.EMAIL_CODE_INVALID)
        return hash_key

    async def check_registration_code(self, email: str, code: str) -> str:
        return await self._check_code(None, "register", email, code)

    async def verify_email(self, identity: SessionIdentity, email: str, code: str, verification_token: str = "") -> PublicUser:
        email = email.strip().lower()
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        await self._check_grant(user, identity, "email_grant", verification_token)
        await self._check_code(user, "bind", email, code)
        await self._check_email_available(user["id"], email)
        try:
            await self.users.update_profile(user["id"], {"email": email, "email_verified_at": utcnow()})
            await self.repository.delete_codes(user["id"])
            # 邮箱变更后其他设备重新登录，当前设备继续使用原来的用户编号和会话。
            await self.logins.revoke_other_sessions(user["id"], identity.token_hash)
            updated_user = await self.users.get_by_id(user["id"])
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            if error.orig.args and error.orig.args[0] == 1062 and "uq_users_email" in str(error.orig):
                raise BusinessError(Messages.EMAIL_ALREADY_BOUND) from None
            raise
        updated_user["avatar"] = await ImageUrls(self.settings, identity.user_id).display(updated_user["avatar"])
        return PublicUser.model_validate(updated_user)

    async def reset_password(self, email: str, code: str, password: str) -> None:
        email = email.strip().lower()
        user = await self.users.get_by_email(email, for_update=True)
        if not user or not user["is_active"] or user["email_verified_at"] is None:
            raise BusinessError(Messages.EMAIL_CODE_INVALID)
        await self._check_code(user, "reset", email, code)
        password_hash = await run_in_threadpool(hash_password, password)
        await self.users.update_password(user["id"], password_hash)
        await self.repository.delete_codes(user["id"])
        await self.logins.revoke_user_sessions(user["id"])
        # 消费验证码、改密和撤销旧会话在同一事务内完成。
        await self.session.commit()

    async def change_password(
        self, identity: SessionIdentity, email: str, code: str, password: str,
    ) -> None:
        email = email.strip().lower()
        user, _ = await UserService(self.session, self.settings)._lock_user_and_session(identity)
        self._check_bound_email(user, email)
        await self._check_code(user, "change_password", email, code)
        password_hash = await run_in_threadpool(hash_password, password)
        await self.users.update_password(user["id"], password_hash)
        await self.repository.delete_codes(user["id"])
        await self.logins.revoke_user_sessions(user["id"])
        # 校验、改密和验证码消费原子提交；原密码或旧的验证接口均不能绕过邮箱校验。
        await self.session.commit()

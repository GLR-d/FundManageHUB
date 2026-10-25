"""注册业务：验证邮箱归属，原子创建用户并消费验证码。"""

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core.config import Settings
from core.errors import BusinessError
from core.messages import Messages
from core.security import hash_password
from repository.register import RegisterRepository
from repository.user import UserRepository
from schemas.auth_request import RegisterRequest
from schemas.auth_response import PublicUser
from service.email import EmailService


class RegisterService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.repository = RegisterRepository(session)
        self.email_service = EmailService(session, settings)

    async def register(self, data: RegisterRequest) -> PublicUser:
        users = UserRepository(self.session)
        if await users.get_by_email(data.email):
            raise BusinessError(Messages.EMAIL_EXISTS)
        hash_key = await self.email_service.check_registration_code(data.email, data.code.get_secret_value())
        # Argon2 在线程池计算；验证码锁保持到创建用户和消费凭据的事务提交。
        password_hash = await run_in_threadpool(hash_password, data.password.get_secret_value())
        try:
            user_id = await self.repository.create(data.email, data.name, password_hash)
            await self.email_service.repository.delete_code(hash_key)
            user = await users.get_by_id(user_id)
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            if error.orig.args and error.orig.args[0] == 1062 and "uq_users_email" in str(error.orig):
                raise BusinessError(Messages.EMAIL_EXISTS) from None
            raise
        return PublicUser.model_validate(user)

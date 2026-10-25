"""月限额独立于公开资料，写入前重新确认用户和可撤销登录会话。"""

from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from core.errors import BusinessError
from core.jwt_tokens import SessionIdentity
from core.messages import Messages
from core.security import utcnow
from repository.login import LoginRepository
from repository.monthly_limit import MonthlyLimitRepository
from repository.user import UserRepository
from schemas.monthly_limit import MonthlyLimitRequest, MonthlyLimitResponse


class MonthlyLimitService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = MonthlyLimitRepository(session)
        self.users = UserRepository(session)
        self.sessions = LoginRepository(session)

    async def get(self, identity: SessionIdentity) -> MonthlyLimitResponse:
        amount = await self.repository.get(identity.user_id)
        return MonthlyLimitResponse(amount=format(amount, ".2f") if amount is not None else None)

    async def save(self, identity: SessionIdentity, data: MonthlyLimitRequest) -> MonthlyLimitResponse:
        # 与资料修改保持相同顺序：先锁用户，再锁会话。撤销或过期的会话不能晚写。
        user = await self.users.get_by_id(identity.user_id, for_update=True)
        current_session = await self.sessions.get_session(identity.token_hash, for_update=True)
        if (
            not user or not user["is_active"] or not current_session
            or current_session["user_id"] != identity.user_id
            or current_session["expires_at"] <= utcnow()
        ):
            raise BusinessError(Messages.SESSION_EXPIRED, 401)
        amount = Decimal(data.amount) if data.amount is not None else None
        await self.repository.save(identity.user_id, amount)
        await self.session.commit()
        return MonthlyLimitResponse(amount=data.amount)

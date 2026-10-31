"""月限额独立于公开资料，写入前重新确认用户和可撤销登录会话。"""

from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from utils.jwt_tokens import SessionIdentity
from repository.monthly_limit import MonthlyLimitRepository
from schemas.request.monthly_limit_request import MonthlyLimitRequest
from schemas.response.monthly_limit_response import MonthlyLimitResponse
from service.account import lock_user_and_session


class MonthlyLimitService:
    # 保存数据库会话并初始化月限额仓储
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repository = MonthlyLimitRepository(session)

    # 读取当前用户的每月支出限额
    async def get(self, identity: SessionIdentity) -> MonthlyLimitResponse:
        amount = await self.repository.get(identity.user_id)
        return MonthlyLimitResponse(amount=format(amount, ".2f") if amount is not None else None)

    # 复核登录身份后保存或清除月支出限额
    async def save(self, identity: SessionIdentity, data: MonthlyLimitRequest) -> MonthlyLimitResponse:
        await lock_user_and_session(self.session, identity)
        amount = Decimal(data.amount) if data.amount is not None else None
        await self.repository.save(identity.user_id, amount)
        await self.session.commit()
        return MonthlyLimitResponse(amount=data.amount)

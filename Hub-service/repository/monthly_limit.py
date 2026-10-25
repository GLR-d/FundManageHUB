"""仅按服务端鉴权用户编号读取和更新月支出限额。"""

from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.security import utcnow
from models.monthly_expense_limit import MonthlyExpenseLimit


class MonthlyLimitRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, user_id: int) -> Decimal | None:
        return await self.session.scalar(select(MonthlyExpenseLimit.amount).where(MonthlyExpenseLimit.user_id == user_id))

    async def save(self, user_id: int, amount: Decimal | None) -> None:
        if amount is None:
            await self.session.execute(delete(MonthlyExpenseLimit).where(MonthlyExpenseLimit.user_id == user_id))
            return
        now = utcnow()
        statement = insert(MonthlyExpenseLimit).values(user_id=user_id, amount=amount, updated_at=now)
        await self.session.execute(statement.on_duplicate_key_update(amount=amount, updated_at=now))

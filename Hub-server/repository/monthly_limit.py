"""仅按服务端鉴权用户编号读取和更新月支出限额。"""

from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from utils.security import utcnow
from models.monthly_expense_limit import MonthlyExpenseLimit


class MonthlyLimitRepository:
    # 保存限额读写使用的数据库会话
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # 查询用户月支出限额，未设置时返回空值
    async def get(self, user_id: int) -> Decimal | None:
        return await self.session.scalar(select(MonthlyExpenseLimit.amount).where(MonthlyExpenseLimit.user_id == user_id))

    # 新增或更新用户限额，空值表示清除
    async def save(self, user_id: int, amount: Decimal | None) -> None:
        if amount is None:
            await self.session.execute(delete(MonthlyExpenseLimit).where(MonthlyExpenseLimit.user_id == user_id))
            return
        now = utcnow()
        statement = insert(MonthlyExpenseLimit).values(user_id=user_id, amount=amount, updated_at=now)
        await self.session.execute(statement.on_duplicate_key_update(amount=amount, updated_at=now))

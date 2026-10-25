"""账单数据访问：每次查询和修改都限定当前用户。"""

from datetime import date
from typing import Any

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from models.fund import Fund
from schemas.fund_request import FundRequest, FundUpdateRequest


class FundRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def _build_conditions(
        user_id: int, search_type: int | None = None, search_value: Any = None, before: date | None = None,
    ) -> list[ColumnElement[bool]]:
        """两个分页查询共用条件，SQLAlchemy 自动绑定实际参数。"""
        conditions = [Fund.user_id == user_id]
        if search_type == 1:
            conditions.append(Fund.type == search_value)
        elif search_type == 2:
            conditions.append(Fund.amount == search_value)
        elif search_type == 3:
            # LOCATE 按字面查找，备注中的 %、_ 不会被当成通配符。
            conditions.append(func.locate(search_value, Fund.remark) > 0)
        if before is not None:
            conditions.append(Fund.time < before)
        return conditions

    async def get_page(
        self,
        user_id: int,
        days: int = 5,
        before: date | None = None,
        search_type: int | None = None,
        search_value: Any = None,
    ) -> tuple[list[dict[str, Any]], bool]:
        """先确定本页包含哪些日期，再取这些日期中的完整账单。"""
        conditions = self._build_conditions(user_id, search_type, search_value, before)
        day = func.date(Fund.time).label("day")
        # 只读取本页日期和一个额外日期，额外日期仅用于判断是否还有下一页。
        page_dates_result = await self.session.scalars(
            select(day).where(*conditions).distinct().order_by(day.desc()).limit(days + 1)
        )
        page_dates = page_dates_result.all()
        if not page_dates:
            return [], False
        has_more = len(page_dates) > days
        oldest_day_in_page = page_dates[min(days, len(page_dates)) - 1]
        # 两次查询使用同一个 AsyncSession 的事务快照，同一天的账单不会被拆开。
        result = await self.session.execute(
            select(Fund.id, Fund.time, Fund.type, Fund.amount, Fund.remark, Fund.photo)
            .where(*conditions, Fund.time >= oldest_day_in_page)
            .order_by(Fund.time.desc(), Fund.id.desc())
        )
        records = result.mappings().all()
        return [dict(record) for record in records], has_more

    async def get(self, user_id: int, fund_id: int, *, for_update: bool = False) -> dict[str, Any] | None:
        statement = (
            select(Fund.id, Fund.time, Fund.type, Fund.amount, Fund.remark, Fund.photo)
            .where(Fund.user_id == user_id, Fund.id == fund_id)
        )
        if for_update:
            statement = statement.with_for_update()
        result = await self.session.execute(statement)
        record = result.mappings().first()
        return dict(record) if record is not None else None

    async def lock_many(self, user_id: int, fund_ids: list[int]) -> list[dict[str, Any]]:
        """批量删除也先读取原值，按编号取得行锁后才能修改图片引用。"""
        result = await self.session.execute(
            select(Fund.id, Fund.photo)
            .where(Fund.user_id == user_id, Fund.id.in_(fund_ids))
            .order_by(Fund.id)
            .with_for_update()
        )
        return [dict(record) for record in result.mappings().all()]

    async def get_all(self, user_id: int) -> list[dict[str, Any]]:
        """导出不受列表分页影响，但仍只读取当前用户的账单。"""
        result = await self.session.execute(
            select(Fund.id, Fund.time, Fund.type, Fund.amount, Fund.remark, Fund.photo)
            .where(Fund.user_id == user_id)
            .order_by(Fund.time.desc(), Fund.id.desc())
        )
        return [dict(record) for record in result.mappings().all()]

    async def create_many(self, user_id: int, records: list[FundRequest]) -> None:
        # 文件不能指定编号或所属用户；这些字段只由后端决定。
        await self.session.execute(
            insert(Fund), [{**record.model_dump(), "user_id": user_id} for record in records],
        )

    async def create(self, user_id: int, data: FundRequest) -> int:
        fund = Fund(
            user_id=user_id, time=data.time, type=data.type, amount=data.amount,
            remark=data.remark, photo=data.photo,
        )
        self.session.add(fund)
        await self.session.flush()
        return fund.id

    async def update(self, user_id: int, data: FundUpdateRequest) -> None:
        await self.session.execute(
            update(Fund)
            .where(Fund.user_id == user_id, Fund.id == data.id)
            .values(time=data.time, type=data.type, amount=data.amount, remark=data.remark, photo=data.photo)
            .execution_options(synchronize_session=False)
        )

    async def delete(self, user_id: int, fund_ids: list[int]) -> int:
        result = await self.session.execute(
            delete(Fund)
            .where(Fund.user_id == user_id, Fund.id.in_(fund_ids))
            .execution_options(synchronize_session=False)
        )
        return result.rowcount

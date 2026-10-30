"""账单数据访问：每次查询和修改都限定当前用户。"""

from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from models.fund import Fund
from schemas.request.fund_request import FundRequest, FundUpdateRequest


class FundRepository:
    # 保存账单读写使用的数据库会话
    def __init__(self, session: AsyncSession):
        self.session = session

    # 组合用户归属、搜索和日期条件
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

    # 按完整日期分页查询账单及后续页标记
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

    # 按用户查询单笔账单，可选加行锁
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

    # 按编号顺序锁定待删除账单并读取图片原值
    async def lock_many(self, user_id: int, fund_ids: list[int]) -> list[dict[str, Any]]:
        """批量删除也先读取原值，按编号取得行锁后才能修改图片引用。"""
        result = await self.session.execute(
            select(Fund.id, Fund.photo)
            .where(Fund.user_id == user_id, Fund.id.in_(fund_ids))
            .order_by(Fund.id)
            .with_for_update()
        )
        return [dict(record) for record in result.mappings().all()]

    # 读取用户全部账单供导出使用
    async def get_all(self, user_id: int) -> list[dict[str, Any]]:
        """导出不受列表分页影响，但仍只读取当前用户的账单。"""
        result = await self.session.execute(
            select(Fund.id, Fund.time, Fund.type, Fund.amount, Fund.remark, Fund.photo)
            .where(Fund.user_id == user_id)
            .order_by(Fund.time.desc(), Fund.id.desc())
        )
        return [dict(record) for record in result.mappings().all()]

    # 批量插入当前用户的账单，等待业务层提交
    async def create_many(self, user_id: int, records: list[FundRequest]) -> None:
        # 文件不能指定编号或所属用户；这些字段只由后端决定。
        await self.session.execute(
            insert(Fund), [{**record.model_dump(), "user_id": user_id} for record in records],
        )

    # 插入账单并刷新取得自增编号
    async def create(self, user_id: int, data: FundRequest) -> int:
        fund = Fund(
            user_id=user_id, time=data.time, type=data.type, amount=data.amount,
            remark=data.remark, photo=data.photo,
        )
        self.session.add(fund)
        await self.session.flush()
        return fund.id

    # 更新当前用户指定账单的字段
    async def update(self, user_id: int, data: FundUpdateRequest) -> None:
        await self.session.execute(
            update(Fund)
            .where(Fund.user_id == user_id, Fund.id == data.id)
            .values(time=data.time, type=data.type, amount=data.amount, remark=data.remark, photo=data.photo)
            .execution_options(synchronize_session=False)
        )

    # 删除当前用户指定的一批账单
    async def delete(self, user_id: int, fund_ids: list[int]) -> None:
        await self.session.execute(
            delete(Fund)
            .where(Fund.user_id == user_id, Fund.id.in_(fund_ids))
            .execution_options(synchronize_session=False)
        )

    # 按聊天筛选条件分页读取账单，不查询图片
    async def search_for_chat(
        self,
        user_id: int,
        *,
        start_date: date | None,
        end_date: date | None,
        category: str | None,
        keyword: str | None,
        min_amount: Decimal | None,
        max_amount: Decimal | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        """聊天按笔分页，不读取图片；查询始终限定服务端鉴权用户。"""
        conditions = [Fund.user_id == user_id]
        if start_date is not None:
            conditions.append(Fund.time >= datetime.combine(start_date, time.min))
        if end_date is not None:
            # 避免最大日期加一天溢出，同时包含结束日期的全部记录。
            conditions.append(Fund.time <= datetime.combine(end_date, time.max))
        if category is not None:
            conditions.append(Fund.type == int(category))
        if keyword is not None:
            conditions.append(func.locate(keyword, Fund.remark) > 0)
        if min_amount is not None:
            conditions.append(Fund.amount >= min_amount)
        if max_amount is not None:
            conditions.append(Fund.amount <= max_amount)
        result = await self.session.execute(
            select(Fund.id, Fund.time, Fund.type, Fund.amount, Fund.remark)
            .where(*conditions)
            .order_by(Fund.time.desc(), Fund.id.desc())
            .limit(limit + 1)
            .offset(offset)
        )
        rows = result.mappings().all()
        return [dict(row) for row in rows[:limit]], len(rows) > limit

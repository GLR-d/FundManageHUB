"""账单业务：按日期分组，验证搜索条件，提交增删改。"""

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from config.settings import Settings
from core.exception_handlers import BusinessError
from core.fund_types import FUND_TYPE_CODES
from core.messages import Messages
from repository.fund import FundRepository
from schemas.request.fund_request import (
    MAX_FUND_AMOUNT, MAX_FUND_ID, FundRequest, FundUpdateRequest,
)
from schemas.response.fund_response import FundPage, FundRecord
from service.image_asset import ImageAssetService
from service.image_urls import ImageUrls


class FundService:
    # 保存数据库会话并初始化账单仓储
    def __init__(self, session: AsyncSession, settings: Settings):
        self.session = session
        self.settings = settings
        self.repository = FundRepository(session)

    # 将账单时间金额转换为前端响应格式
    @staticmethod
    def format_fund_record(row: dict[str, Any]) -> FundRecord:
        """把 MySQL 中的 datetime、Decimal 转成前端约定的字符串。"""
        return FundRecord(
            id=row["id"],
            time=row["time"].strftime("%Y-%m-%d %H:%M:%S"),
            type=str(row["type"]),
            amount=format(row["amount"], ".2f"),
            remark=row["remark"],
            photo=row["photo"],
        )

    # 按日期分页分组账单并生成图片访问链接
    async def list_funds(
        self,
        user_id: int,
        search_type: int | None = None,
        search_value: str | int | Decimal | None = None,
        *,
        days: int = 5,
        before: date | None = None,
    ) -> FundPage:
        """读取完整的若干天，再按日期分组；同一天不会被拆成两页。"""
        records, has_more = await self.repository.get_page(
            user_id, days=days, before=before, search_type=search_type, search_value=search_value,
        )
        # 一批照片一起签名，避免每条账单分别切换线程。
        photos = await ImageUrls(self.settings, user_id).display_many([row["photo"] for row in records])
        grouped_records: dict[str, list[FundRecord]] = {}
        for row, photo in zip(records, photos):
            record_day = row["time"].date().isoformat()
            fund_record = self.format_fund_record(row)
            fund_record.photo = photo
            grouped_records.setdefault(record_day, []).append(fund_record)

        next_cursor = None
        if has_more:
            # SQL 按时间倒序返回，最后一条记录的日期就是下一批的边界。
            oldest_day_in_page = records[-1]["time"].date()
            next_cursor = oldest_day_in_page.isoformat()

        return FundPage(items=grouped_records, hasMore=has_more, nextCursor=next_cursor)

    # 校验搜索条件并复用账单分页查询
    async def search_funds(
        self,
        user_id: int,
        search_type: int,
        search_value: str,
        *,
        days: int = 5,
        before: date | None = None,
    ) -> FundPage:
        """先验证搜索条件，再复用与普通列表相同的分页逻辑。"""
        search_text = search_value.strip()
        if not search_text:
            raise BusinessError(Messages.INVALID_FUND_SEARCH)

        parsed_value: str | int | Decimal = search_text
        if search_type == 1:
            if search_text not in FUND_TYPE_CODES:
                raise BusinessError(Messages.INVALID_FUND_SEARCH)
            parsed_value = int(search_text)
        elif search_type == 2:
            try:
                amount = Decimal(search_text)
                if (
                    not amount.is_finite() or not 0 <= amount <= MAX_FUND_AMOUNT
                    or amount != amount.quantize(Decimal("0.01"))
                ):
                    raise InvalidOperation
            except InvalidOperation:
                raise BusinessError(Messages.INVALID_FUND_SEARCH)
            parsed_value = amount

        return await self.list_funds(user_id, search_type, parsed_value, days=days, before=before)

    # 读取当前用户的单笔账单及图片链接
    async def get_fund(self, user_id: int, fund_id: int) -> FundRecord:
        row = await self.repository.get(user_id, fund_id)
        if row is None:
            raise BusinessError(Messages.FUND_NOT_FOUND)
        row["photo"] = await ImageUrls(self.settings, user_id).display(row["photo"])
        return self.format_fund_record(row)

    # 新增账单并同步图片引用后提交事务
    async def create_fund(self, user_id: int, data: FundRequest) -> FundRecord:
        data = data.model_copy(update={"photo": ImageUrls(self.settings, user_id).stored(data.photo)})
        # 插入尚未提交的账单后再锁资产，用户外键锁也就先于资产锁。
        fund_id = await self.repository.create(user_id, data)
        await ImageAssetService(self.session, self.settings, user_id).change_references([], [data.photo])
        await self.session.commit()
        return await self.get_fund(user_id, fund_id)

    # 锁定账单并同步修改内容和图片引用
    async def update_fund(self, user_id: int, data: FundUpdateRequest) -> FundRecord:
        data = data.model_copy(update={"photo": ImageUrls(self.settings, user_id).stored(data.photo)})
        # 使用加锁后的数据库原值，不能拿临时签名后的响应字段计算旧引用。
        original = await self.repository.get(user_id, data.id, for_update=True)
        if original is None:
            raise BusinessError(Messages.FUND_NOT_FOUND)
        await ImageAssetService(self.session, self.settings, user_id).change_references(
            [original["photo"]], [data.photo],
        )
        await self.repository.update(user_id, data)
        await self.session.commit()
        return await self.get_fund(user_id, data.id)

    # 校验并锁定账单后批量删除及解除图片引用
    async def delete_funds(self, user_id: int, ids: str) -> None:
        try:
            # 先转换编号，再去重；保留请求中的顺序。
            parsed_ids = [int(value) for value in ids.split(",")]
            fund_ids = list(dict.fromkeys(parsed_ids))
        except ValueError:
            raise BusinessError(Messages.INVALID_FUND_IDS)
        for fund_id in fund_ids:
            if not 0 < fund_id <= MAX_FUND_ID:
                raise BusinessError(Messages.INVALID_FUND_IDS)

        originals = await self.repository.lock_many(user_id, fund_ids)
        if len(originals) != len(fund_ids):
            raise BusinessError(Messages.FUND_NOT_FOUND)
        await ImageAssetService(self.session, self.settings, user_id).change_references(
            [record["photo"] for record in originals], [],
        )
        await self.repository.delete(user_id, fund_ids)
        await self.session.commit()

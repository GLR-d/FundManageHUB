"""CSV 账单导入导出：先完整校验，再在一个事务中新增。"""

import csv
import re
from datetime import datetime
from decimal import Decimal
from io import StringIO
from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from core.config import Settings
from core.errors import BusinessError
from core.fund_types import FUND_TYPES, FUND_TYPE_CODES
from core.messages import Messages
from repository.fund import FundRepository
from schemas.request.fund_request import FundRequest
from schemas.response.fund_response import FundImportResult
from service.image_asset import ImageAssetService
from service.image_urls import ImageUrls

MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 5000
CSV_HEADERS = ("时间", "类型", "金额", "备注", "图片")
_FIELDS = ("time", "type", "amount", "remark", "photo")
_HEADER_FIELDS = dict(zip(CSV_HEADERS, _FIELDS)) | dict(zip(_FIELDS, _FIELDS))
_LOCAL_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2}(?::[0-9]{2})?)?")
_AMOUNT = re.compile(r"[0-9]+(?:\.[0-9]{1,2})?")


# 判断文本是否需要导出转义
def _needs_escape(value: str) -> bool:
    return value.startswith(("'", "\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@"))


# 转义导出文本以避免表格公式执行
def _escape_text(value: str) -> str:
    """防止表格软件把文本当公式；原有单引号也转义，便于无损导回。"""
    return "'" + value if _needs_escape(value) else value


# 还原导入文本中的导出转义标记
def _unescape_text(value: str) -> str:
    return value[1:] if value.startswith("'") and _needs_escape(value[1:]) else value


# 生成包含CSV行号的导入错误
def _row_error(row: int, reason: str) -> BusinessError:
    return BusinessError(Messages.FUND_IMPORT_ROW_ERROR.format(row=row, reason=reason), 422)


class FundTransferService:
    # 初始化账单导入导出的会话配置和仓储
    def __init__(self, session: AsyncSession, settings: Settings):
        self.session = session
        self.settings = settings
        self.repository = FundRepository(session)

    # 解析并完整校验CSV内容及每行账单
    @staticmethod
    def parse_csv(content: bytes) -> list[FundRequest]:
        """只解析内存中的文件，不访问数据库；错误行不会产生任何写入。"""
        if len(content) > MAX_IMPORT_BYTES:
            raise BusinessError(Messages.FUND_IMPORT_TOO_LARGE, 413)
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = content.decode("gb18030")
            except UnicodeDecodeError:
                raise _row_error(1, Messages.FUND_IMPORT_ENCODING) from None

        reader = csv.reader(StringIO(text, newline=""), strict=True)
        fields: list[str] | None = None
        records: list[FundRequest] = []
        row_number = 1
        try:
            while True:
                # 多行备注占用多行 CSV，这里记录本条账单开始的实际行号。
                row_number = reader.line_num + 1
                row = next(reader, None)
                if row is None:
                    break
                if not row or all(not value.strip() for value in row):
                    continue
                if fields is None:
                    fields = [_HEADER_FIELDS.get(value.strip().lower(), "") for value in row]
                    if (
                        "" in fields or len(fields) != len(set(fields))
                        or not {"time", "type", "amount"}.issubset(fields)
                    ):
                        raise _row_error(row_number, Messages.FUND_IMPORT_HEADERS)
                    continue
                if len(records) >= MAX_IMPORT_ROWS:
                    raise _row_error(row_number, Messages.FUND_IMPORT_TOO_MANY_ROWS)
                if len(row) != len(fields):
                    raise _row_error(row_number, Messages.FUND_IMPORT_COLUMNS)
                if any("\0" in value for value in row):
                    raise _row_error(row_number, Messages.FUND_IMPORT_INVALID_CSV)
                data = dict(zip(fields, row))
                time_text, type_text, amount_text = (data[field].strip() for field in _FIELDS[:3])
                if not _LOCAL_TIME.fullmatch(time_text):
                    raise _row_error(row_number, Messages.INVALID_FUND_TIME)
                try:
                    time = datetime.fromisoformat(time_text)
                except ValueError:
                    raise _row_error(row_number, Messages.INVALID_FUND_TIME) from None
                if type_text in FUND_TYPES:
                    fund_type = FUND_TYPES.index(type_text)
                elif type_text in FUND_TYPE_CODES:
                    fund_type = int(type_text)
                else:
                    raise _row_error(row_number, Messages.FUND_IMPORT_INVALID_TYPE)
                if not _AMOUNT.fullmatch(amount_text):
                    raise _row_error(row_number, Messages.FUND_IMPORT_INVALID_AMOUNT)
                try:
                    records.append(FundRequest(
                        time=time, type=fund_type, amount=Decimal(amount_text),
                        remark=_unescape_text(data.get("remark", "")),
                        photo=_unescape_text(data.get("photo", "")),
                    ))
                except ValidationError as error:
                    first = error.errors()[0]
                    # 对外提示沿用 CSV 的中文字段名。
                    label = dict(zip(_FIELDS, CSV_HEADERS)).get(str(first["loc"][0]), Messages.PARAMETER_LABEL)
                    reason = Messages.VALIDATION_ERROR_TEMPLATE.format(field=label, message=first["msg"])
                    raise _row_error(row_number, reason) from None
        except csv.Error:
            raise _row_error(row_number, Messages.FUND_IMPORT_INVALID_CSV) from None
        if not records:
            raise _row_error(1, Messages.FUND_IMPORT_EMPTY)
        return records

    # 将账单记录编码为带中文表头的CSV
    @staticmethod
    def build_csv(records: list[dict[str, Any]]) -> bytes:
        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(CSV_HEADERS)
        for record in records:
            writer.writerow((
                record["time"].strftime("%Y-%m-%d %H:%M:%S"),
                FUND_TYPES[int(record["type"])], format(record["amount"], ".2f"),
                _escape_text(record["remark"]), _escape_text(record["photo"]),
            ))
        return output.getvalue().encode("utf-8-sig")

    # 生成包含示例账单的CSV导入模板
    @staticmethod
    def template_csv() -> bytes:
        return FundTransferService.build_csv([{
            "time": datetime(2026, 1, 1, 12), "type": 1, "amount": Decimal("12.50"),
            "remark": "示例账单（导入前可删除或修改）", "photo": "",
        }])

    # 查询当前用户全部账单并生成CSV文件
    async def export_csv(self, user_id: int) -> bytes:
        records = await self.repository.get_all(user_id)
        return await run_in_threadpool(self.build_csv, records)

    # 完整校验后批量新增账单并同步图片引用
    async def import_csv(self, user_id: int, content: bytes) -> FundImportResult:
        records = await run_in_threadpool(self.parse_csv, content)
        images = ImageUrls(self.settings, user_id)
        # 与手动记账一致，数据库保留永久对象地址，不保存会过期的签名。
        records = [record.model_copy(update={"photo": images.stored(record.photo)}) for record in records]
        await self.repository.create_many(user_id, records)
        await ImageAssetService(self.session, self.settings, user_id).change_references(
            [], [record.photo for record in records],
        )
        await self.session.commit()
        return FundImportResult(imported=len(records))

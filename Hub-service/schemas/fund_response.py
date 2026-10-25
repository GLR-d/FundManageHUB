"""后端返回给前端的账单详情和分页数据。"""

from pydantic import BaseModel, Field


class FundRecord(BaseModel):
    """返回给前端的一笔账单，与数据库原始行区分开。"""

    id: int
    time: str = Field(description="本地时间，格式 YYYY-MM-DD HH:MM:SS")
    type: str = Field(description="字符串类别编号，0 至 10；8 为交通，9 为收转账，10 为收红包；6、7、9、10 为收入")
    amount: str = Field(description="两位小数字符串，保留金额精度")
    remark: str
    photo: str = Field(description="图片地址，多张图片使用逗号分隔")


class FundPage(BaseModel):
    """按天分页的结果；字段名保持与前端约定一致。"""

    items: dict[str, list[FundRecord]]
    hasMore: bool = Field(description="是否还有更早日期的账单")
    nextCursor: str | None = Field(description="本批最早日期；没有下一批时为 null")


class FundImportResult(BaseModel):
    """整份文件校验并提交成功后，返回实际新增的条数。"""

    imported: int = Field(ge=0)

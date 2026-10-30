"""账单接口：接收请求并调用业务层，返回 Result 或 CSV 文件。"""

from fastapi import APIRouter, File, Path, Query, Request, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from core.database import DatabaseSession
from schemas.request.fund_request import (
    MAX_FUND_ID, FundCursor, FundRequest, FundUpdateRequest,
)
from schemas.response.fund_response import FundImportResult, FundPage, FundRecord
from schemas.response.result import Result
from service.fund import FundService
from service.fund_transfer import MAX_IMPORT_BYTES, FundTransferService

router = APIRouter(prefix="/fund", tags=["资金"])


# 按日期分页返回当前用户账单
@router.get("", response_model=Result[FundPage], summary="按天分批获取当前用户账单")
async def get_funds(
    request: Request,
    session: DatabaseSession,
    days: int = Query(5, ge=1, le=20, description="每批账单日期数量，同一天的记录完整返回"),
    before: FundCursor | None = Query(None, description="只返回此日期之前的账单，格式 YYYY-MM-DD"),
) -> Result[FundPage]:
    return Result[FundPage].success(await FundService(session, request.app.state.settings).list_funds(request.state.identity.user_id, days=days, before=before))


# 创建账单并返回保存结果
@router.post("", response_model=Result[FundRecord], summary="新增账单")
async def add_fund(data: FundRequest, request: Request, session: DatabaseSession) -> Result[FundRecord]:
    return Result[FundRecord].success(await FundService(session, request.app.state.settings).create_fund(request.state.identity.user_id, data))


# 修改账单并返回最新记录
@router.put("", response_model=Result[FundRecord], summary="修改账单")
async def update_fund(data: FundUpdateRequest, request: Request, session: DatabaseSession) -> Result[FundRecord]:
    return Result[FundRecord].success(await FundService(session, request.app.state.settings).update_fund(request.state.identity.user_id, data))


# 按编号批量删除当前用户账单
@router.delete("", response_model=Result[None], summary="按逗号分隔的编号批量删除账单")
async def delete_funds(request: Request, session: DatabaseSession, ids: str = Query(...)) -> Result[None]:
    await FundService(session, request.app.state.settings).delete_funds(request.state.identity.user_id, ids)
    return Result[None].success()


# 固定路径先注册，避免 search、export 等被当成账单编号。
# 按条件分页搜索当前用户账单
@router.get("/search", response_model=Result[FundPage], summary="按类型、金额或备注分批搜索账单")
async def search_funds(
    request: Request,
    session: DatabaseSession,
    search_type: int = Query(..., alias="searchType", ge=1, le=3, description="1=类别，2=金额，3=备注"),
    search_value: str = Query(..., alias="searchValue", max_length=1000),
    days: int = Query(5, ge=1, le=20, description="每批匹配日期数量，同一天的匹配记录完整返回"),
    before: FundCursor | None = Query(None, description="只返回此日期之前的账单，格式 YYYY-MM-DD"),
) -> Result[FundPage]:
    return Result[FundPage].success(await FundService(session, request.app.state.settings).search_funds(
        request.state.identity.user_id, search_type, search_value, days=days, before=before,
    ))


# 导出当前用户的全部账单
@router.get(
    "/export", response_class=Response, summary="导出当前用户全部账单为 CSV",
    responses={200: {"content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def export_funds(request: Request, session: DatabaseSession) -> Response:
    content = await FundTransferService(session, request.app.state.settings).export_csv(request.state.identity.user_id)
    return Response(content, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": 'attachment; filename="bills.csv"',
    })


# 生成并下载 CSV 导入模板
@router.get(
    "/import/template", response_class=Response, summary="下载 CSV 账单导入模板",
    responses={200: {"content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}}}},
)
async def get_import_template() -> Response:
    content = await run_in_threadpool(FundTransferService.template_csv)
    return Response(content, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": 'attachment; filename="bill-import-template.csv"',
    })


# 读取 CSV 文件并批量导入账单
@router.post("/import", response_model=Result[FundImportResult], summary="从 CSV 批量新增账单")
async def import_funds(
    request: Request, session: DatabaseSession, file: UploadFile = File(...),
) -> Result[FundImportResult]:
    try:
        # 只读取上限加一个字节，超限文件不继续加载到应用内存。
        content = await file.read(MAX_IMPORT_BYTES + 1)
    finally:
        await file.close()
    return Result[FundImportResult].success(
        await FundTransferService(session, request.app.state.settings).import_csv(request.state.identity.user_id, content),
    )


# 返回当前用户的单笔账单
@router.get("/{fund_id}", response_model=Result[FundRecord], summary="获取单笔账单")
async def get_fund(
    request: Request,
    session: DatabaseSession,
    fund_id: int = Path(..., ge=1, le=MAX_FUND_ID),
) -> Result[FundRecord]:
    return Result[FundRecord].success(await FundService(session, request.app.state.settings).get_fund(request.state.identity.user_id, fund_id))

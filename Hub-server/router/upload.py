"""图片上传接口：接收文件，调用业务层，返回图片地址。"""

from fastapi import APIRouter, File, Request, UploadFile

from config.database import DatabaseSession
from schemas.response.result import Result
from schemas.request.upload_request import ImageRefreshRequest
from service.image_asset import ImageAssetService
from service.upload import UploadService

router = APIRouter(prefix="/upload", tags=["上传"])


# 上传图片并返回临时访问地址
@router.post("", response_model=Result[str], summary="上传不超过 1MB 的 JPG/PNG 图片")
async def upload_image(request: Request, session: DatabaseSession, file: UploadFile = File(...)) -> Result[str]:
    try:
        url = await UploadService(session, request.app.state.settings, request.state.identity.user_id).upload_image(file.file)
        return Result[str].success(url)
    finally:
        await file.close()


# 为当前用户的私有图片续签地址
@router.post("/refresh", response_model=Result[str], summary="刷新当前用户私有图片的访问地址")
async def refresh_image(request: Request, data: ImageRefreshRequest, session: DatabaseSession) -> Result[str]:
    url = await ImageAssetService(
        session, request.app.state.settings, request.state.identity.user_id,
    ).refresh_url(data.url)
    return Result[str].success(url)

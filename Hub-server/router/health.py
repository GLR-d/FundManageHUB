"""应用及数据库连接的健康检查。"""

from fastapi import APIRouter
from sqlalchemy import select

from core.database import DatabaseSession
from schemas.response.result import Result

router = APIRouter(tags=["运行状态"])


# 检查 MySQL 连接并返回健康状态
@router.get(
    "/health", response_model=Result[dict[str, str]], summary="检查应用及 MySQL 连接",
)
async def health(session: DatabaseSession):
    await session.scalar(select(1))
    return Result[dict[str, str]].success({"status": "ok"})

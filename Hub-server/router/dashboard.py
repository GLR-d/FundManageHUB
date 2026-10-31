"""收支概览：统一返回当前用户的月度汇总、每日、分类和历史月支出。"""

from fastapi import APIRouter, Query, Request

from config.database import DatabaseSession
from schemas.request.dashboard_request import DashboardMonth
from schemas.response.dashboard_response import DashboardStatistics
from schemas.response.result import Result
from service.dashboard import DashboardService

router = APIRouter(prefix="/dashboard", tags=["首页统计"])


# 返回指定月份的收支统计
@router.get("/statistics", response_model=Result[DashboardStatistics], summary="获取月度收支、每日、分类和历史月支出统计")
async def get_dashboard_statistics(
    request: Request,
    session: DatabaseSession,
    month: DashboardMonth | None = Query(None, description="统计月份 YYYY-MM；省略时使用北京时间当月"),
) -> Result[DashboardStatistics]:
    return Result[DashboardStatistics].success(await DashboardService(session).get_statistics(request.state.identity.user_id, month))

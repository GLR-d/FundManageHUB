"""通过邮箱验证码注册账号。"""

from fastapi import APIRouter, BackgroundTasks, Request

from core import mail
from core.database import DatabaseSession
from schemas.auth_request import EmailRequest, RegisterRequest
from schemas.auth_response import PublicUser
from schemas.result import Result
from service.email import EmailService
from service.register import RegisterService

router = APIRouter(prefix="/register", tags=["注册"])


@router.post("/email/request", response_model=Result[None], summary="发送邮箱注册验证码")
async def request_registration_code(
    data: EmailRequest, request: Request, background_tasks: BackgroundTasks, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    message = await EmailService(session, settings).request_registration(
        data.email, request.client.host if request.client else "unknown",
    )
    if message:
        background_tasks.add_task(mail.send_email, settings, *message)
    return Result[None].success()


@router.post("", response_model=Result[PublicUser], summary="验证邮箱验证码并注册账号")
async def register(data: RegisterRequest, request: Request, session: DatabaseSession) -> Result[PublicUser]:
    return Result[PublicUser].success(await RegisterService(session, request.app.state.settings).register(data))

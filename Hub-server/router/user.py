"""当前用户资料、邮箱换绑与邮箱验证码改密。"""

from fastapi import APIRouter, BackgroundTasks, Request, Response

from utils import mail
from config.database import DatabaseSession
from schemas.request.auth_request import (
    BindingEmailCodeRequest, BindingEmailRequest, EmailCodeRequest, EmailRequest,
    PasswordResetRequest, UserUpdateRequest, VerifiedPasswordChangeRequest,
)
from schemas.response.auth_response import EmailVerificationGrant, PublicUser
from schemas.response.result import Result
from schemas.request.monthly_limit_request import MonthlyLimitRequest
from schemas.response.monthly_limit_response import MonthlyLimitResponse
from service.email import EmailService
from service.user import UserService
from service.monthly_limit import MonthlyLimitService

router = APIRouter(prefix="/user", tags=["用户"])


# 返回当前登录用户的公开资料
@router.get("", response_model=Result[PublicUser], summary="获取当前用户资料")
async def get_user(request: Request, session: DatabaseSession) -> Result[PublicUser]:
    return Result[PublicUser].success(await UserService(session, request.app.state.settings).get_user(request.state.identity))


# 发送目标邮箱验证码以申请换绑
@router.post("/email/request", response_model=Result[None], summary="向目标邮箱发送换绑验证码")
async def request_email_binding(
    data: BindingEmailRequest, request: Request, background_tasks: BackgroundTasks, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    message = await EmailService(session, settings).request_binding(
        request.state.identity, data.email, request.client.host if request.client else "unknown",
        data.verificationToken.get_secret_value() if data.verificationToken else "",
    )
    background_tasks.add_task(mail.send_email, settings, *message)
    return Result[None].success()


# 验证目标邮箱并完成邮箱换绑
@router.post("/email/verify", response_model=Result[PublicUser], summary="通过验证码完成当前用户的邮箱换绑")
async def verify_email_binding(
    data: BindingEmailCodeRequest, request: Request, session: DatabaseSession,
) -> Result[PublicUser]:
    user = await EmailService(session, request.app.state.settings).verify_email(
        request.state.identity, data.email, data.code.get_secret_value(),
        data.verificationToken.get_secret_value() if data.verificationToken else "",
    )
    return Result[PublicUser].success(user)


# 发送当前绑定邮箱的改密验证码
@router.post("/password/request", response_model=Result[None], summary="向当前绑定邮箱发送改密验证码")
async def request_password_change(
    data: EmailRequest, request: Request, background_tasks: BackgroundTasks, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    message = await EmailService(session, settings).request_password_change(
        request.state.identity, data.email, request.client.host if request.client else "unknown",
    )
    background_tasks.add_task(mail.send_email, settings, *message)
    return Result[None].success()


# 验证改密凭据并修改登录密码
@router.put("/password", response_model=Result[None], summary="验证绑定邮箱验证码并修改密码")
async def change_password(
    data: VerifiedPasswordChangeRequest | PasswordResetRequest, request: Request, session: DatabaseSession,
) -> Result[None]:
    service = EmailService(session, request.app.state.settings)
    if isinstance(data, VerifiedPasswordChangeRequest):
        await service.change_verified_password(
            request.state.identity, data.verificationToken.get_secret_value(), data.password.get_secret_value(),
        )
    else:
        await service.change_password(
            request.state.identity, data.email, data.code.get_secret_value(), data.password.get_secret_value(),
        )
    return Result[None].success()


# 验证当前邮箱并签发改密凭据
@router.post("/password/verify", response_model=Result[EmailVerificationGrant], summary="验证当前邮箱并签发一次性改密凭据")
async def verify_password_email(
    data: EmailCodeRequest, request: Request, response: Response, session: DatabaseSession,
) -> Result[EmailVerificationGrant]:
    response.headers["Cache-Control"] = "no-store"
    grant = await EmailService(session, request.app.state.settings).verify_current_email(
        request.state.identity, data.email, data.code.get_secret_value(), "change_password",
    )
    return Result[EmailVerificationGrant].success(grant)


# 发送当前邮箱的换绑验证码
@router.post("/email/current/request", response_model=Result[None], summary="向当前邮箱发送更换邮箱的验证码")
async def request_current_email(
    data: EmailRequest, request: Request, background_tasks: BackgroundTasks, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    message = await EmailService(session, settings).request_email_change(
        request.state.identity, data.email, request.client.host if request.client else "unknown",
    )
    background_tasks.add_task(mail.send_email, settings, *message)
    return Result[None].success()


# 验证当前邮箱并签发换绑凭据
@router.post("/email/current/verify", response_model=Result[EmailVerificationGrant], summary="验证当前邮箱并签发一次性换绑凭据")
async def verify_current_email(
    data: EmailCodeRequest, request: Request, response: Response, session: DatabaseSession,
) -> Result[EmailVerificationGrant]:
    response.headers["Cache-Control"] = "no-store"
    grant = await EmailService(session, request.app.state.settings).verify_current_email(
        request.state.identity, data.email, data.code.get_secret_value(), "change_email",
    )
    return Result[EmailVerificationGrant].success(grant)


# 修改并返回当前用户的公开资料
@router.put("", response_model=Result[PublicUser], summary="修改当前用户资料")
async def update_user(
    data: UserUpdateRequest, request: Request, session: DatabaseSession,
) -> Result[PublicUser]:
    return Result[PublicUser].success(await UserService(session, request.app.state.settings).update_user(request.state.identity, data))


# 返回当前用户的每月支出限额
@router.get("/monthly-limit", response_model=Result[MonthlyLimitResponse], summary="获取当前用户的每月支出限额")
async def get_monthly_limit(request: Request, response: Response, session: DatabaseSession) -> Result[MonthlyLimitResponse]:
    response.headers["Cache-Control"] = "no-store"
    return Result[MonthlyLimitResponse].success(await MonthlyLimitService(session).get(request.state.identity))


# 保存或清除当前用户的每月支出限额
@router.put("/monthly-limit", response_model=Result[MonthlyLimitResponse], summary="保存或清除当前用户的每月支出限额")
async def save_monthly_limit(
    data: MonthlyLimitRequest, request: Request, response: Response, session: DatabaseSession,
) -> Result[MonthlyLimitResponse]:
    response.headers["Cache-Control"] = "no-store"
    return Result[MonthlyLimitResponse].success(await MonthlyLimitService(session).save(request.state.identity, data))

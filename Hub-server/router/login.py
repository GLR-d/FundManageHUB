"""验证码、账号密码登录及当前会话退出。"""

from fastapi import APIRouter, BackgroundTasks, Request, Response

from core.database import DatabaseSession
from core import mail
from core.errors import BusinessError
from core.security import CAPTCHA_COOKIE
from schemas.request.auth_request import CaptchaVerifyRequest, EmailRequest, LoginRequest, PasswordResetRequest
from schemas.response.auth_response import CaptchaData, LoginData
from schemas.response.result import Result
from service.login import LoginService
from service.email import EmailService

router = APIRouter(prefix="/login", tags=["登录"])


# 申请找回密码验证码并安排邮件发送
@router.post("/password/forgot", response_model=Result[None], summary="向已验证的绑定邮箱发送找回密码验证码")
async def forgot_password(
    data: EmailRequest, request: Request, background_tasks: BackgroundTasks, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    message = await EmailService(session, settings).request_password_reset(
        data.email, request.client.host if request.client else "unknown",
    )
    if message:
        background_tasks.add_task(mail.send_email, settings, *message)
    return Result[None].success()


# 通过邮箱验证码重置密码
@router.post("/password/reset", response_model=Result[None], summary="通过邮箱验证码重置密码并撤销全部登录")
async def reset_password(data: PasswordResetRequest, request: Request, session: DatabaseSession) -> Result[None]:
    await EmailService(session, request.app.state.settings).reset_password(
        data.email, data.code.get_secret_value(), data.password.get_secret_value(),
    )
    return Result[None].success()


# 生成图形验证码并设置浏览器 Cookie
@router.get("/captcha", response_model=Result[CaptchaData], summary="获取验证码图片")
async def get_captcha(
    request: Request, response: Response, session: DatabaseSession,
) -> Result[CaptchaData]:
    settings = request.app.state.settings
    login_service = LoginService(session, settings)
    data, browser_cookie = await login_service.create_captcha()
    # Cookie 将验证码绑定到发起请求的浏览器，并禁止前端脚本读取。
    response.set_cookie(
        CAPTCHA_COOKIE, browser_cookie, max_age=settings.captcha_ttl,
        httponly=True, secure=settings.cookie_secure, samesite="lax", path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return Result[CaptchaData].success(data)


# 验证图形验证码并记录验证状态
@router.post("/verify", response_model=Result[None], summary="验证验证码")
async def verify_captcha(
    data: CaptchaVerifyRequest, request: Request, session: DatabaseSession,
) -> Result[None]:
    settings = request.app.state.settings
    login_service = LoginService(session, settings)
    browser_cookie = request.cookies.get(CAPTCHA_COOKIE)
    await login_service.verify_captcha(str(data.uuid), data.code, browser_cookie)
    return Result[None].success()


# 撤销当前请求使用的登录会话
@router.post("/logout", response_model=Result[None], summary="退出当前登录会话")
async def logout(request: Request, session: DatabaseSession) -> Result[None]:
    await LoginService(session, request.app.state.settings).logout(request.state.identity)
    return Result[None].success()


# 验证登录资料并返回登录结果
@router.post("", response_model=Result[LoginData], summary="邮箱密码登录")
async def login(
    data: LoginRequest, request: Request, response: Response, session: DatabaseSession,
) -> Result[LoginData]:
    settings = request.app.state.settings
    login_service = LoginService(session, settings)
    browser_cookie = request.cookies.get(CAPTCHA_COOKIE)
    try:
        user = await login_service.login(data, browser_cookie)
        result = Result[LoginData].success(user)
    except BusinessError as error:
        # 此处处理业务错误是为了继续清除验证码 Cookie，同时保留原异常的状态码。
        response.status_code = error.status_code
        result = Result[LoginData].error(error.message)
    # 登录尝试结束后清除 Cookie，成功和业务失败都要求重新获取验证码。
    response.delete_cookie(
        CAPTCHA_COOKIE, path="/", secure=settings.cookie_secure, httponly=True, samesite="lax",
    )
    response.headers["Cache-Control"] = "no-store"
    return result

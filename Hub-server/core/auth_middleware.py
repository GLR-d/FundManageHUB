"""统一拦截业务请求：验证 JWT 和会话，再将身份写入 request.state。"""

import secrets

import jwt
from sqlalchemy.exc import SQLAlchemyError
from fastapi.responses import JSONResponse
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from config import database
from config.settings import Settings
from core.exception_handlers import database_error_response, error_response
from utils.jwt_tokens import SessionIdentity, decode_access_token
from core.messages import Messages
from utils.security import hash_secret, utcnow
from repository.login import LoginRepository

PUBLIC_PATHS = frozenset({
    "/login", "/login/captcha", "/login/verify", "/register", "/register/email/request", "/health",
    "/login/password/forgot", "/login/password/reset",
    "/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json",
})


def is_public_request(path: str, method: str) -> bool:
    path = path.rstrip("/") or "/"
    return method == "OPTIONS" or path in PUBLIC_PATHS


def extract_token(request: Request) -> str | None:
    # 两种请求头都支持；重复或相互冲突的凭据一律拒绝。
    legacy_values = request.headers.getlist("token")
    bearer_values = request.headers.getlist("authorization")
    if len(legacy_values) > 1 or len(bearer_values) > 1:
        raise jwt.InvalidTokenError("Duplicate token headers")
    legacy = legacy_values[0].strip() if legacy_values else None
    bearer = None
    if bearer_values:
        parts = bearer_values[0].split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise jwt.InvalidTokenError("Invalid Authorization header")
        bearer = parts[1]
    if legacy and bearer and not secrets.compare_digest(legacy.encode(), bearer.encode()):
        raise jwt.InvalidTokenError("Conflicting token headers")
    token = bearer or legacy
    if token and len(token) > 4096:
        raise jwt.InvalidTokenError("Token too long")
    return token


async def load_identity(token: str, settings: Settings) -> SessionIdentity:
    # 认证使用独立的异步会话，查询结束后即归还连接。
    claims = decode_access_token(token, settings)
    token_hash = hash_secret(token)
    async with database.async_session() as database_session:
        session = await LoginRepository(database_session).get_session(token_hash)
        if (
            not session or not session["is_active"] or session["expires_at"] <= utcnow()
            or session["user_id"] != int(claims["sub"])
        ):
            raise jwt.InvalidTokenError("Session revoked or expired")
        return SessionIdentity(user_id=session["user_id"], token_hash=token_hash)


class JWTAuthMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or is_public_request(scope["path"], scope["method"]):
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        try:
            token = extract_token(request)
            if not token:
                response = self.error(Messages.LOGIN_REQUIRED, 401)
            else:
                identity = await load_identity(token, request.app.state.settings)
                request.state.identity = identity
                response = None
        except jwt.InvalidTokenError:
            response = self.error(Messages.SESSION_EXPIRED, 401)
        except SQLAlchemyError as error:
            response = database_error_response(error)

        if response is not None:
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)

    @staticmethod
    def error(message: str, status: int) -> JSONResponse:
        return error_response(message, status, {"WWW-Authenticate": "Bearer"} if status == 401 else None)

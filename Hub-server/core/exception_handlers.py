"""将应用异常统一转换为 Result 响应，保留 HTTP 状态码和响应头。"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pymysql.constants import CR, ER
from redis.exceptions import RedisError
from sqlalchemy.exc import DBAPIError, DisconnectionError, OperationalError, SQLAlchemyError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from core.errors import BusinessError
from core.messages import Messages
from schemas.response.result import Result

logger = logging.getLogger(__name__)

# 连接数不足、锁等待超时、死锁及连接中断属于暂时无法提供数据库服务。
_UNAVAILABLE_MYSQL_CODES = {
    ER.CON_COUNT_ERROR, ER.OUT_OF_RESOURCES, ER.BAD_HOST_ERROR,
    ER.TOO_MANY_USER_CONNECTIONS, ER.LOCK_WAIT_TIMEOUT, ER.LOCK_DEADLOCK,
    CR.CR_CONNECTION_ERROR, CR.CR_CONN_HOST_ERROR, CR.CR_UNKNOWN_HOST,
    CR.CR_SERVER_GONE_ERROR, CR.CR_SERVER_LOST, CR.CR_SERVER_LOST_EXTENDED,
}


def error_response(message: str, status_code: int, headers=None) -> JSONResponse:
    """异常处理与认证中间件共用的 JSON 错误响应。"""
    return JSONResponse(status_code=status_code, content=Result.error(message).model_dump(mode="json"), headers=headers)


async def business_error_handler(request: Request, error: BusinessError):
    return error_response(error.message, error.status_code)


async def validation_error_handler(request: Request, error: RequestValidationError):
    first = error.errors()[0]
    field = str(first["loc"][-1]) if first["loc"] else Messages.PARAMETER_LABEL
    message = Messages.VALIDATION_ERROR_TEMPLATE.format(field=field, message=first["msg"])
    return error_response(message, 422)


def database_error_response(error: SQLAlchemyError) -> JSONResponse:
    """路由与认证中间件共用数据库错误分类、日志和 Result 响应。"""
    logger.error("数据库请求失败", exc_info=(type(error), error, error.__traceback__))

    unavailable = isinstance(error, (DisconnectionError, PoolTimeoutError))
    if isinstance(error, DBAPIError) and error.connection_invalidated:
        unavailable = True
    if isinstance(error, OperationalError) and not unavailable:
        arguments = getattr(error.orig, "args", ())
        error_code = arguments[0] if arguments else None
        # MySQL 的未知字段等错误也可能被包装为 OperationalError，不能一律返回 503。
        # 驱动未提供编号时，沿用该异常本身的运行故障分类。
        unavailable = not isinstance(error_code, int) or error_code in _UNAVAILABLE_MYSQL_CODES

    status_code = 503 if unavailable else 500
    message = Messages.DATABASE_UNAVAILABLE if unavailable else Messages.INTERNAL_SERVER_ERROR
    return error_response(message, status_code)


async def database_error_handler(request: Request, error: SQLAlchemyError):
    return database_error_response(error)


async def http_error_handler(request: Request, error: StarletteHTTPException):
    message = error.detail if isinstance(error.detail, str) else Messages.REQUEST_FAILED
    return error_response(message, error.status_code, error.headers)


async def unexpected_error_handler(request: Request, error: Exception):
    return error_response(Messages.INTERNAL_SERVER_ERROR, 500)


async def redis_error_handler(request: Request, error: RedisError):
    # Redis 错误可能包含连接地址，日志仅记录异常类型。
    logger.error("聊天存储请求失败：%s", type(error).__name__)
    return error_response(Messages.CHAT_UNAVAILABLE, 503)


def register_exception_handlers(application: FastAPI) -> None:
    application.add_exception_handler(BusinessError, business_error_handler)
    application.add_exception_handler(RequestValidationError, validation_error_handler)
    application.add_exception_handler(SQLAlchemyError, database_error_handler)
    application.add_exception_handler(RedisError, redis_error_handler)
    application.add_exception_handler(StarletteHTTPException, http_error_handler)
    application.add_exception_handler(Exception, unexpected_error_handler)

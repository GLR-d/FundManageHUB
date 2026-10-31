"""Hub-server 的 FastAPI 应用入口。"""

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

import uvicorn
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from redis.exceptions import RedisError
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import database
from config.logging_config import configure_logging
from config.openapi import register_openapi
from config.redis_client import open_checkpointer, open_redis
from config.settings import Settings, get_settings
from core.auth_middleware import JWTAuthMiddleware
from core.exception_handlers import (
    BusinessError, business_error_handler, database_error_handler,
    http_error_handler, redis_error_handler, unexpected_error_handler,
    validation_error_handler,
)
from router import chat, dashboard, fund, health, login, register, upload, user
from schemas.response.result import Result
from service.image_asset import run_image_cleanup


# 启动共享资源并在退出时关闭后台任务和连接
@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    application.state.settings = application.state.settings or get_settings()
    cleanup_task = None
    try:
        await database.check_database()
        # 启动时再加载 Agent，避免导入应用时初始化模型和向量库。
        from agents.graph import build_graph

        async with (
            open_redis(application.state.settings.redis_url) as redis_client,
            open_checkpointer(redis_client) as checkpointer,
        ):
            application.state.redis_client = redis_client
            application.state.chat_checkpointer = checkpointer
            application.state.chat_graph = build_graph(checkpointer)
            cleanup_task = asyncio.create_task(run_image_cleanup(application.state.settings), name="image-cleanup")
            yield
    finally:
        application.state.chat_graph = None
        application.state.chat_checkpointer = None
        application.state.redis_client = None
        if cleanup_task is not None:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
        await database.engine.dispose()


# 创建应用并注册异常处理、中间件和路由
def create_app(settings: Settings | None = None) -> FastAPI:
    configure_logging()
    application = FastAPI(
        title="Hub Service", version="0.2.0", lifespan=lifespan,
        # Nginx 去掉 /api 前缀后，文档仍使用正确的外部地址。
        root_path=os.getenv("APP_ROOT_PATH", ""),
        exception_handlers={
            BusinessError: business_error_handler,
            RequestValidationError: validation_error_handler,
            SQLAlchemyError: database_error_handler,
            RedisError: redis_error_handler,
            StarletteHTTPException: http_error_handler,
            Exception: unexpected_error_handler,
        },
    )
    application.state.settings = settings
    application.state.chat_graph = None
    application.state.chat_checkpointer = None
    application.state.redis_client = None
    application.add_middleware(JWTAuthMiddleware)

    # 普通 JSON 错误统一声明为 Result，聊天的成功响应仍为 SSE。
    for api_router in (
        health.router, login.router, register.router, user.router,
        fund.router, dashboard.router, upload.router, chat.router,
    ):
        application.include_router(
            api_router,
            responses={422: {"model": Result[None], "description": "请求参数校验失败"}},
        )
    register_openapi(application)
    return application


app = create_app()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8080, log_config=None)

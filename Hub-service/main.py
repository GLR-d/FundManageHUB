"""Hub-service 的 FastAPI 应用入口。"""

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

import uvicorn
from fastapi import FastAPI

from core import database
from core.auth_middleware import JWTAuthMiddleware
from core.config import Settings, get_settings
from core.exception_handlers import register_exception_handlers
from core.logging_config import configure_logging
from core.openapi import register_openapi
from core.redis_client import open_checkpointer, open_redis
from router import chat, dashboard, fund, health, login, register, upload, user
from schemas.result import Result
from service.image_asset import run_image_cleanup


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """启动时检查数据库并连接 Redis；关闭时释放两类连接资源。"""
    # JWT、Redis 等应用配置；数据库使用 core.database 中的固定引擎。
    application.state.settings = application.state.settings or get_settings()
    cleanup_task = None
    try:
        await database.check_database()
        # 启动时再加载 Agent，导入应用时不初始化模型。
        from agents.graph import build_graph

        async with open_redis(application.state.settings.redis_url) as redis_client:
            async with open_checkpointer(application.state.settings.redis_url, redis_client) as checkpointer:
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


def create_app(settings: Settings | None = None) -> FastAPI:
    """组装应用；测试可传入应用配置，数据库由测试夹具单独替换。"""
    # 两种启动方式都会构建应用；重复构建时不重复添加日志处理器。
    configure_logging()
    # 反向代理会去掉 /api；声明外部前缀，让接口文档也使用正确的请求地址。
    application = FastAPI(
        title="Hub Service", version="0.2.0", lifespan=lifespan,
        root_path=os.getenv("APP_ROOT_PATH", ""),
    )
    application.state.settings = settings
    application.state.chat_graph = None
    application.state.chat_checkpointer = None
    application.state.redis_client = None

    register_exception_handlers(application)
    application.add_middleware(JWTAuthMiddleware)

    # 普通 JSON 接口的参数错误与全局异常处理一致，文档统一声明为 Result。
    for api_router in (
        health.router, login.router, register.router, user.router,
        fund.router, dashboard.router, upload.router,
    ):
        application.include_router(
            api_router,
            responses={422: {"model": Result[None], "description": "请求参数校验失败"}},
        )
    application.include_router(
        chat.router,
        responses={422: {"model": Result[None], "description": "请求参数校验失败"}},
    )
    register_openapi(application)
    return application


app = create_app()


if __name__ == "__main__":
    # 只有直接运行 main.py 时才启动服务器，其他模块导入应用时不会启动。
    uvicorn.run(app, host="127.0.0.1", port=8080, log_config=None)

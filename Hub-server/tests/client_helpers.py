"""异步测试客户端：让应用和 MySQL 连接池始终使用同一个事件循环。"""

from contextlib import asynccontextmanager

from httpx import ASGITransport, AsyncClient

from main import create_app


@asynccontextmanager
async def browser_client(app, *, raise_app_exceptions=True):
    """共享已启动的应用，但每个客户端保留各自的 Cookie。"""
    transport = ASGITransport(app=app, raise_app_exceptions=raise_app_exceptions)
    async with AsyncClient(transport=transport, base_url="http://testserver", follow_redirects=True) as client:
        yield client


@asynccontextmanager
async def app_client(settings=None, *, app=None, raise_app_exceptions=True):
    application = app if app is not None else create_app(settings)
    # ASGITransport 不会自动触发启动和关闭，测试需要显式管理 lifespan。
    async with application.router.lifespan_context(application):
        async with browser_client(application, raise_app_exceptions=raise_app_exceptions) as client:
            yield client

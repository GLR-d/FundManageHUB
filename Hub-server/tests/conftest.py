"""在独立、随机命名的 MySQL 测试库中验证，不使用开发库的数据。"""

import sys
from contextlib import asynccontextmanager
from dataclasses import replace
from types import ModuleType
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from core import database
from core.config import get_settings
from scripts.init_database import initialize_database

# 本组测试覆盖普通接口，排除聊天 SDK、Redis 扩展及模型启动依赖。
# 只在导入应用时临时替换聊天连接模块；下面的夹具负责测试期间的生命周期。
chat_bootstrap = ModuleType("core.redis_client")
chat_bootstrap.open_checkpointer = None
chat_bootstrap.open_redis = None
knowledge_bootstrap = ModuleType("agents.tools.knowledge")
knowledge_bootstrap.search_knowledge = object()
previous_chat_module = sys.modules.get("core.redis_client")
previous_knowledge_module = sys.modules.get("agents.tools.knowledge")
sys.modules["core.redis_client"] = chat_bootstrap
sys.modules["agents.tools.knowledge"] = knowledge_bootstrap
try:
    from client_helpers import app_client
    from main import create_app
finally:
    # 只恢复被替换的模块，保留正常加载的应用及路由模块。
    if previous_chat_module is None:
        sys.modules.pop("core.redis_client", None)
    else:
        sys.modules["core.redis_client"] = previous_chat_module
    if previous_knowledge_module is None:
        sys.modules.pop("agents.tools.knowledge", None)
    else:
        sys.modules["agents.tools.knowledge"] = previous_knowledge_module


@pytest.fixture(scope="session")
async def settings():
    base = get_settings()
    test = replace(
        base, mysql_database="managehub_auth_test_" + uuid4().hex[:12],
        smtp_host="smtp.example.test", smtp_port=465, smtp_use_ssl=True,
        smtp_username="sender@example.test", smtp_password="test-mail-authorization",
        mail_from="sender@example.test",
        oss_endpoint="https://oss-cn-hangzhou.aliyuncs.com", oss_region="cn-hangzhou",
        oss_bucket="managehub-test", oss_access_key_id="test-access-key",
        oss_access_key_secret="test-access-secret", oss_public_base_url="https://images.example.test",
    )
    server_engine = database.create_database_engine(base, select_database=False)
    test_engine = database.create_database_engine(test)
    try:
        async with server_engine.connect() as server:
            result = await server.execute(
                text("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = :name"),
                {"name": test.mysql_database},
            )
            assert result.scalar_one() == 0, "测试库必须是新创建的独立库"
        try:
            await initialize_database(test)
            # 整组测试显式替换应用固定的引擎和工厂；create_app(settings)
            # 只改变应用配置，不负责把数据库切换到测试库。
            with pytest.MonkeyPatch.context() as patcher:
                patcher.setattr(database, "engine", test_engine)
                patcher.setattr(database, "async_session", async_sessionmaker(test_engine, expire_on_commit=False))
                yield test
        finally:
            await test_engine.dispose()
            if not test.mysql_database.startswith("managehub_auth_test_"):
                raise RuntimeError("拒绝清理不属于本次测试的数据库")
            async with server_engine.begin() as server:
                await server.execute(text(f"DROP DATABASE IF EXISTS `{test.mysql_database}`"))
    finally:
        await test_engine.dispose()
        await server_engine.dispose()


@pytest.fixture(autouse=True)
async def clean_test_data(settings):
    async with database.engine.begin() as connection:
        for table in ("auth_email_codes", "auth_email_rate_limits", "auth_sessions", "auth_captchas", "funds", "image_assets", "monthly_expense_limits", "users"):
            await connection.execute(text(f"DELETE FROM {table}"))


@pytest.fixture(autouse=True)
def mail_outbox(monkeypatch):
    """所有接口测试只记录邮件；真实 SMTP 始终隔离。"""
    outbox = []

    async def capture(settings, recipient, subject, body):
        outbox.append({"recipient": recipient, "subject": subject, "body": body})

    monkeypatch.setattr("core.mail.send_email", capture)
    # 注册辅助函数也通过同一假邮件箱取得验证码，始终不连接真实 SMTP。
    monkeypatch.setattr("core.mail._test_outbox", outbox, raising=False)
    return outbox


@pytest.fixture(autouse=True)
def oss_objects(monkeypatch):
    """记录 OSS 上传内容；整组接口测试始终禁止连接真实 Bucket。"""
    objects = []

    def capture(settings, key, content, content_type):
        objects.append({"settings": settings, "key": key, "content": content, "content_type": content_type})

    def forbid_real_client(*args, **kwargs):
        raise AssertionError("测试禁止连接真实 OSS")

    monkeypatch.setattr("core.oss.put_image", capture)
    monkeypatch.setattr("alibabacloud_oss_v2.Client", forbid_real_client)
    return objects


@pytest.fixture(autouse=True)
def oss_signatures(monkeypatch):
    """为私有图片生成可观察的新签名，测试不创建真实云端连接。"""
    signed_keys = []

    def sign(settings, key):
        signed_keys.append(key)
        endpoint = settings.oss_endpoint.removeprefix("https://").rstrip("/")
        origin = settings.oss_public_base_url.rstrip("/") or f"https://{settings.oss_bucket}.{endpoint}"
        return f"{origin}/{key}?test-signature={len(signed_keys)}"

    monkeypatch.setattr("core.oss.sign_image_url", sign)
    return signed_keys


@pytest.fixture(autouse=True)
def oss_deletions(monkeypatch):
    """清理测试只记录删除目标，不访问真实 OSS。"""
    deleted = []

    def capture(settings, key):
        deleted.append({"bucket": settings.oss_bucket, "key": key})

    monkeypatch.setattr("core.oss.delete_image", capture)
    return deleted


@pytest.fixture(autouse=True)
def isolated_image_cleanup(monkeypatch):
    """接口生命周期不启动定时清理；清理行为由测试显式触发。"""
    async def stopped(settings):
        return None

    monkeypatch.setattr("main.run_image_cleanup", stopped)


@pytest.fixture(autouse=True)
def predictable_captcha(monkeypatch):
    monkeypatch.setattr("service.login.generate_captcha_code", lambda: "ABCDE")


@pytest.fixture(autouse=True)
def isolated_chat_lifecycle(monkeypatch):
    """普通接口测试不依赖 Redis 扩展、模型服务或真实聊天会话。"""
    @asynccontextmanager
    async def test_checkpointer(redis_client):
        yield object()

    @asynccontextmanager
    async def test_redis(redis_url):
        yield object()

    graph_module = ModuleType("agents.graph")
    graph_module.build_graph = lambda checkpointer: object()
    monkeypatch.setattr("main.open_checkpointer", test_checkpointer)
    monkeypatch.setattr("main.open_redis", test_redis)
    monkeypatch.setitem(sys.modules, "agents.graph", graph_module)


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
async def client(app):
    async with app_client(app=app) as test_client:
        yield test_client


@pytest.fixture
def query(settings):
    async def execute(sql, params=()):
        # 夹具保留直接造测试数据的 SQL，避免和被测仓储共享实现。
        # exec_driver_sql 由 SQLAlchemy 管理事务，%s 是 MySQL 驱动的绑定格式。
        async with database.engine.begin() as connection:
            result = await connection.exec_driver_sql(sql, params)
            return list(result.mappings()) if result.returns_rows else []
    return execute

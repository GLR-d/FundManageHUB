"""数据库入口：一个 engine、一个会话工厂，每次请求创建自己的 Session。"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import URL, inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from config.settings import Settings, get_settings
from core.fund_types import FUND_TYPE_MAX, fund_type_check_upper_bound
from models import Base


def create_database_engine(settings: Settings, *, select_database: bool = True) -> AsyncEngine:
    """按配置创建引擎；应用只创建一次，脚本和测试可创建自己的引擎。"""
    url = URL.create(
        "mysql+aiomysql",
        username=settings.mysql_user,
        password=settings.mysql_password,
        host=settings.mysql_host,
        port=settings.mysql_port,
        database=settings.mysql_database if select_database else None,
        query={"charset": "utf8mb4"},
    )
    return create_async_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=1800,
        isolation_level="REPEATABLE READ",
        hide_parameters=True,
        connect_args={"connect_timeout": 5, "init_command": "SET time_zone = '+00:00'"},
    )


# 引擎和工厂共用；调用 async_session() 才创建一个新的 AsyncSession。
engine = create_database_engine(get_settings())
async_session = async_sessionmaker(bind=engine, expire_on_commit=False)


async def check_database() -> None:
    """启动时检查数据库连接，以及应用所需的表是否已经初始化。"""
    async with engine.connect() as connection:
        existing_tables = set(await connection.run_sync(lambda sync: inspect(sync).get_table_names()))
        if "image_assets" not in existing_tables:
            raise RuntimeError("图片登记表尚未初始化，请运行 scripts/migrate_image_assets.py")
        if "monthly_expense_limits" not in existing_tables:
            raise RuntimeError("月支出限额表尚未初始化，请运行 scripts/migrate_monthly_expense_limits.py")
        if not set(Base.metadata.tables).issubset(existing_tables):
            raise RuntimeError("应用所需表尚未初始化，请运行 scripts/migrate_email_login.py")
        fund_checks = await connection.run_sync(lambda sync: inspect(sync).get_check_constraints("funds"))
        type_check = next((item for item in fund_checks if item["name"] == "chk_funds_type"), None)
        enforced = await connection.scalar(text(
            "SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS "
            "WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'funds' "
            "AND CONSTRAINT_NAME = 'chk_funds_type' AND CONSTRAINT_TYPE = 'CHECK'"
        ))
        if type_check is None or fund_type_check_upper_bound(type_check["sqltext"]) != FUND_TYPE_MAX or enforced != "YES":
            raise RuntimeError("账单类型结构尚未升级，请运行 scripts/migrate_fund_types.py")
        user_columns = await connection.run_sync(
            lambda sync: {column["name"]: column for column in inspect(sync).get_columns("users")}
        )
        if (
            not {"email", "email_verified_at"}.issubset(user_columns)
            or {"username", "recovery_email"}.intersection(user_columns)
            or user_columns["email"]["nullable"]
        ):
            raise RuntimeError("邮箱登录所需结构尚未升级，请运行 scripts/migrate_email_login.py")
        user_constraints = await connection.run_sync(lambda sync: inspect(sync).get_unique_constraints("users"))
        if not any(
            constraint["name"] == "uq_users_email" and constraint["column_names"] == ["email"]
            for constraint in user_constraints
        ):
            raise RuntimeError("邮箱唯一约束尚未初始化，请运行 scripts/migrate_email_login.py")
        session_columns = await connection.run_sync(
            lambda sync: {column["name"] for column in inspect(sync).get_columns("auth_sessions")}
        )
        if "password_verified_at" in session_columns:
            raise RuntimeError("邮箱验证码改密结构尚未升级，请运行 scripts/migrate_email_login.py")
        code_columns = await connection.run_sync(
            lambda sync: {column["name"]: column for column in inspect(sync).get_columns("auth_email_codes")}
        )
        if not code_columns["user_id"]["nullable"]:
            raise RuntimeError("注册验证码结构尚未升级，请运行 scripts/migrate_email_login.py")


async def get_session() -> AsyncIterator[AsyncSession]:
    # 每个请求独立会话；异常外抛时统一回滚尚未提交的事务。
    async with async_session() as session:
        try:
            yield session
        except BaseException:
            # 请求取消也需要回滚当前事务。
            await session.rollback()
            raise


DatabaseSession = Annotated[AsyncSession, Depends(get_session)]

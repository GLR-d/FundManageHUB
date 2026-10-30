"""验证原生 SQL 旧表可继续使用，以及请求结束后的连接归还。"""

from dataclasses import replace
from datetime import datetime
from decimal import Decimal

import pytest

from sqlalchemy import DDL, inspect, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from core import database
from core.config import PROJECT_ROOT
from models.fund import Fund
from repository.fund import FundRepository
from schemas.request.fund_request import FundRequest
from scripts.init_database import initialize_database
from scripts.migrate_email_login import migrate_email_login
from test_auth import logged_in


async def test_legacy_schema_and_records_survive_sqlalchemy_initialization(settings):
    # 只操作以本次随机测试库名派生的新库，不接触开发库或旧业务库。
    legacy = replace(settings, mysql_database=settings.mysql_database + "_legacy")
    assert legacy.mysql_database.startswith("managehub_auth_test_")
    server_engine = database.create_database_engine(settings, select_database=False)
    legacy_engine = database.create_database_engine(legacy)
    legacy_factory = async_sessionmaker(legacy_engine, expire_on_commit=False)
    schema_created = False
    try:
        async with server_engine.connect() as connection:
            schemas = await connection.run_sync(lambda sync_connection: inspect(sync_connection).get_schema_names())
            assert legacy.mysql_database not in schemas
        async with server_engine.begin() as connection:
            await connection.execute(DDL(f"CREATE DATABASE `{legacy.mysql_database}`"))
        schema_created = True
        # 用改造前的 SQL 建表，模拟当前机器中已经存在的数据库结构。
        async with legacy_engine.begin() as connection:
            for schema_file in (PROJECT_ROOT / "tests" / "fixtures" / "legacy_auth_schema.sql", PROJECT_ROOT / "sql" / "fund_schema.sql"):
                for statement in schema_file.read_text(encoding="utf-8").split(";"):
                    if statement.strip():
                        await connection.exec_driver_sql(statement)
        async with legacy_engine.begin() as connection:
            result = await connection.exec_driver_sql(
                "INSERT INTO users (username, name, password_hash, email) VALUES (%s, %s, %s, %s)",
                ("existing-user", "原有用户", "existing-password-hash", "existing@example.test"),
            )
            user_id = result.lastrowid
        async with legacy_factory() as session:
            fund_id = await FundRepository(session).create(user_id, FundRequest(
                time=datetime(2026, 10, 14, 12), type=1, amount=Decimal("12.30"), remark="原有账单",
            ))
            await session.commit()
        async with legacy_engine.connect() as connection:
            previous_ddl = {}
            for name in ("users", "auth_sessions", "auth_captchas", "funds"):
                result = await connection.exec_driver_sql(f"SHOW CREATE TABLE `{name}`")
                previous_ddl[name] = result.one()[1]

        await initialize_database(legacy)
        await initialize_database(legacy)
        async with legacy_engine.begin() as connection:
            # 模拟上一版验证码表的非空用户外键；注册前发码需要升级为可空。
            await connection.exec_driver_sql("ALTER TABLE auth_email_codes MODIFY COLUMN user_id BIGINT UNSIGNED NOT NULL")
            await connection.exec_driver_sql(
                "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (%s, %s, '2099-01-01')",
                ("a" * 64, user_id),
            )

        async with legacy_engine.connect() as connection:
            for name, definition in previous_ddl.items():
                result = await connection.exec_driver_sql(f"SHOW CREATE TABLE `{name}`")
                assert result.one()[1] == definition
        # 缺少归属验证时，迁移必须拒绝，且不能先删旧账号字段。
        with pytest.raises(RuntimeError):
            await migrate_email_login(legacy)
        async with legacy_engine.connect() as connection:
            columns = await connection.run_sync(lambda sync: {column["name"] for column in inspect(sync).get_columns("users")})
            assert "username" in columns
            result = await connection.exec_driver_sql("SELECT username, email FROM users WHERE id = %s", (user_id,))
            assert dict(result.mappings().one()) == {"username": "existing-user", "email": "existing@example.test"}
        # 模拟旧版本完成邮箱验证码验证，再正式迁移为邮箱登录。
        async with legacy_engine.begin() as connection:
            await connection.exec_driver_sql("ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL")
            await connection.exec_driver_sql("ALTER TABLE users ADD COLUMN recovery_email VARCHAR(254) NULL")
            await connection.exec_driver_sql("UPDATE users SET email = ' Existing@Example.Test ', email_verified_at = UTC_TIMESTAMP(), recovery_email = 'existing@example.test' WHERE id = %s", (user_id,))
            await connection.exec_driver_sql(
                "INSERT INTO users (username, name, password_hash, email, email_verified_at) VALUES ('duplicate-user', '重复邮箱', 'unused-hash', 'existing@example.test', UTC_TIMESTAMP())"
            )
        with pytest.raises(RuntimeError):
            await migrate_email_login(legacy)
        async with legacy_engine.begin() as connection:
            # 解决旧邮箱冲突后才能继续；迁移不能任意选一个账号覆盖另一个。
            assert await connection.scalar(select(Fund.id).where(Fund.id == fund_id)) == fund_id
            await connection.exec_driver_sql("DELETE FROM users WHERE username = 'duplicate-user'")
        await migrate_email_login(legacy)
        await migrate_email_login(legacy)
        async with legacy_engine.connect() as connection:
            columns = await connection.run_sync(lambda sync: {column["name"] for column in inspect(sync).get_columns("users")})
            assert "username" not in columns and "recovery_email" not in columns
            result = await connection.exec_driver_sql("SELECT id, email, email_verified_at FROM users WHERE id = %s", (user_id,))
            row = dict(result.mappings().one())
            assert row["id"] == user_id and row["email"] == "existing@example.test" and row["email_verified_at"] is not None
            constraints = await connection.run_sync(lambda sync: inspect(sync).get_unique_constraints("users"))
            assert any(item["name"] == "uq_users_email" and item["column_names"] == ["email"] for item in constraints)
            code_columns = await connection.run_sync(lambda sync: inspect(sync).get_columns("auth_email_codes"))
            assert next(column for column in code_columns if column["name"] == "user_id")["nullable"] is True
            result = await connection.exec_driver_sql("SELECT token_hash FROM auth_sessions WHERE user_id = %s", (user_id,))
            assert result.scalar_one() == "a" * 64
            session_columns = await connection.run_sync(lambda sync: {column["name"] for column in inspect(sync).get_columns("auth_sessions")})
            assert "password_verified_at" not in session_columns
        async with legacy_factory() as session:
            record = await FundRepository(session).get(user_id, fund_id)
            assert record["remark"] == "原有账单" and record["amount"] == Decimal("12.30")
            assert await session.scalar(select(Fund.id).where(Fund.id == fund_id)) == fund_id
    finally:
        await legacy_engine.dispose()
        try:
            if schema_created:
                async with server_engine.begin() as connection:
                    await connection.execute(DDL(f"DROP DATABASE IF EXISTS `{legacy.mysql_database}`"))
        finally:
            await server_engine.dispose()


async def test_requests_return_connections_to_pool_on_success_and_business_error(client, settings):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    assert (await client.get("/user", headers=headers)).status_code == 200
    assert (await client.get("/fund", headers=headers)).status_code == 200
    assert (await client.get("/fund/9007199254740991", headers=headers)).json()["code"] == 0
    assert (await client.post("/fund", headers=headers, json={})).status_code == 422
    assert database.engine.pool.checkedout() == 0

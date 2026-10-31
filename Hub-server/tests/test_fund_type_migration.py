"""扩展收入分类只改变类型约束，旧账单及其他表保持不变。"""

import pytest
from sqlalchemy.exc import DBAPIError

from config import database
from scripts.migrate_fund_types import migrate_fund_types
from test_fund import authenticate, create_fund


@pytest.mark.parametrize("previous_bound", [7, 8])
async def test_income_category_migration_is_idempotent_and_preserves_old_data(client, settings, query, previous_bound):
    assert settings.mysql_database.startswith("managehub_auth_test_")
    headers = await authenticate(client)
    for kind in range(previous_bound + 1):
        await create_fund(client, headers, type=str(kind), remark=f"原编号 {kind}")
    users_before = await query("SELECT * FROM users")
    funds_before = await query("SELECT * FROM funds ORDER BY id")
    ddl_before = {name: await query(f"SHOW CREATE TABLE `{name}`") for name in ("users", "image_assets", "monthly_expense_limits", "auth_sessions")}
    await query(f"ALTER TABLE funds DROP CHECK chk_funds_type, ADD CONSTRAINT chk_funds_type CHECK (type BETWEEN 0 AND {previous_bound})")
    funds_ddl_before = (await query("SHOW CREATE TABLE funds"))[0]["Create Table"]
    try:
        with pytest.raises(RuntimeError, match="scripts/migrate_fund_types.py"):
            await database.check_database()
        assert await migrate_fund_types(settings) == {"changed": True}
        assert await migrate_fund_types(settings) == {"changed": False}
        assert await query("SELECT * FROM users") == users_before
        assert await query("SELECT * FROM funds ORDER BY id") == funds_before
        funds_ddl_after = (await query("SHOW CREATE TABLE funds"))[0]["Create Table"]
        assert funds_ddl_after == funds_ddl_before.replace(f"between 0 and {previous_bound}", "between 0 and 10")
        for name, definition in ddl_before.items():
            assert await query(f"SHOW CREATE TABLE `{name}`") == definition
        await database.check_database()
        for kind, name in [(8, "交通"), (9, "收转账"), (10, "收红包")]:
            assert (await create_fund(client, headers, type=str(kind), remark=name))["type"] == str(kind)
        # 请求校验以外，数据库也必须拦住下一个未知编号。
        with pytest.raises(DBAPIError) as rejected:
            await query("UPDATE funds SET type = 11")
        assert rejected.value.orig.args[0] == 3819
    finally:
        await migrate_fund_types(settings)


@pytest.mark.parametrize("previous", ["missing", "7_not_enforced", "8_not_enforced", "10_not_enforced"])
async def test_income_category_migration_restores_missing_or_unenforced_constraint(settings, query, previous):
    assert settings.mysql_database.startswith("managehub_auth_test_")
    await query("ALTER TABLE funds DROP CHECK chk_funds_type")
    if previous != "missing":
        bound = int(previous.split("_")[0])
        await query(f"ALTER TABLE funds ADD CONSTRAINT chk_funds_type CHECK (type BETWEEN 0 AND {bound}) NOT ENFORCED")
    try:
        with pytest.raises(RuntimeError, match="scripts/migrate_fund_types.py"):
            await database.check_database()
        assert await migrate_fund_types(settings) == {"changed": True}
        assert await migrate_fund_types(settings) == {"changed": False}
        await database.check_database()
    finally:
        await migrate_fund_types(settings)


async def test_income_category_migration_refuses_custom_check_without_changing_it(settings, query):
    assert settings.mysql_database.startswith("managehub_auth_test_")
    await query("ALTER TABLE funds DROP CHECK chk_funds_type, ADD CONSTRAINT chk_funds_type CHECK (type BETWEEN 0 AND 11)")
    try:
        before = await query("SHOW CREATE TABLE funds")
        with pytest.raises(RuntimeError, match="自定义账单类型约束"):
            await migrate_fund_types(settings)
        assert await query("SHOW CREATE TABLE funds") == before
    finally:
        await query("ALTER TABLE funds DROP CHECK chk_funds_type, ADD CONSTRAINT chk_funds_type CHECK (type BETWEEN 0 AND 10)")

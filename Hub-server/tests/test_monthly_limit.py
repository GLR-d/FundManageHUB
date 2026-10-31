"""月支出限额的持久保存、金额校验、账号隔离和会话撤销保护。"""

from decimal import Decimal

import pytest
from sqlalchemy import inspect

from client_helpers import app_client
from config import database
from scripts.migrate_monthly_expense_limits import migrate_monthly_expense_limits
from service.monthly_limit import MonthlyLimitService
from test_auth import logged_in, login, register


async def test_monthly_limit_defaults_to_unset_and_stays_out_of_public_user(client):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    response = await client.get("/user/monthly-limit", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"code": 1, "msg": None, "data": {"amount": None}}
    assert response.headers["cache-control"] == "no-store"
    assert "monthlyLimit" not in (await client.get("/user", headers=headers)).json()["data"]


@pytest.mark.parametrize("amount,expected", [
    ("1", "1.00"), ("0.01", "0.01"), ("2000", "2000.00"), ("2000.5", "2000.50"),
    ("100.10", "100.10"), ("90071992547409.91", "90071992547409.91"),
])
async def test_monthly_limit_saves_exact_decimal(client, query, amount, expected):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    saved = await client.put("/user/monthly-limit", headers=headers, json={"amount": amount})
    assert saved.status_code == 200
    assert saved.json() == {"code": 1, "msg": None, "data": {"amount": expected}}
    assert saved.headers["cache-control"] == "no-store"
    assert (await query("SELECT amount FROM monthly_expense_limits"))[0]["amount"] == Decimal(expected)
    assert (await client.get("/user/monthly-limit", headers=headers)).json()["data"] == {"amount": expected}


async def test_monthly_limit_survives_app_restart_and_can_be_updated_or_cleared(client, settings, query):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    assert (await client.put("/user/monthly-limit", headers=headers, json={"amount": "1234.56"})).json()["code"] == 1
    # 新应用实例及新请求会话读取同一条数据库记录，不依赖进程内缓存。
    async with app_client(settings) as restarted:
        assert (await restarted.get("/user/monthly-limit", headers=headers)).json()["data"] == {"amount": "1234.56"}
        assert (await restarted.put("/user/monthly-limit", headers=headers, json={"amount": "88"})).json()["data"] == {"amount": "88.00"}
        assert len(await query("SELECT user_id FROM monthly_expense_limits")) == 1
        for _ in range(2):
            cleared = await restarted.put("/user/monthly-limit", headers=headers, json={"amount": None})
            assert cleared.json()["data"] == {"amount": None}
        assert (await restarted.get("/user/monthly-limit", headers=headers)).json()["data"] == {"amount": None}
    assert await query("SELECT user_id FROM monthly_expense_limits") == []


async def test_monthly_limit_is_scoped_to_authenticated_account(client, query):
    first = await logged_in(client)
    assert (await register(client, username="bob")).json()["code"] == 1
    second = (await login(client, username="bob")).json()["data"]
    first_headers = {"token": first["token"]}
    second_headers = {"token": second["token"]}
    assert (await client.put("/user/monthly-limit", headers=first_headers, json={"amount": "100"})).json()["code"] == 1
    assert (await client.get("/user/monthly-limit", headers=second_headers)).json()["data"] == {"amount": None}
    assert (await client.put("/user/monthly-limit", headers=second_headers, json={"amount": "200"})).json()["data"] == {"amount": "200.00"}
    assert (await client.get("/user/monthly-limit", headers=first_headers, params={"user_id": second["id"]})).json()["data"] == {"amount": "100.00"}
    assert (await client.put("/user/monthly-limit", headers=first_headers, json={"amount": None})).json()["code"] == 1
    assert (await client.get("/user/monthly-limit", headers=second_headers)).json()["data"] == {"amount": "200.00"}
    await query("DELETE FROM users WHERE id = %s", (second["id"],))
    assert await query("SELECT user_id FROM monthly_expense_limits") == []


@pytest.mark.parametrize("data", [
    {}, {"amount": "0"}, {"amount": "0.00"}, {"amount": "-1"}, {"amount": "-0.01"},
    {"amount": "1.001"}, {"amount": "1.000"}, {"amount": "90071992547409.92"},
    {"amount": "100000000000000"}, {"amount": "NaN"}, {"amount": "Infinity"},
    {"amount": "1e3"}, {"amount": " 12 "}, {"amount": ""}, {"amount": ".5"},
    {"amount": "1."}, {"amount": 12}, {"amount": 12.5}, {"amount": True},
    {"amount": []}, {"amount": {}}, {"amount": "100", "user_id": 1},
    {"amount": None, "userId": 1},
])
async def test_monthly_limit_invalid_input_never_changes_saved_amount(client, query, data):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    assert (await client.put("/user/monthly-limit", headers=headers, json={"amount": "42"})).json()["code"] == 1
    response = await client.put("/user/monthly-limit", headers=headers, json=data)
    assert response.status_code == 422
    assert response.json()["code"] == 0
    assert response.json()["data"] is None
    assert (await query("SELECT amount FROM monthly_expense_limits"))[0]["amount"] == Decimal("42.00")


@pytest.mark.parametrize("method", ["GET", "PUT"])
@pytest.mark.parametrize("headers", [{}, {"token": "invalid-token"}])
async def test_monthly_limit_requires_valid_authentication(client, query, method, headers):
    response = await client.request(method, "/user/monthly-limit", headers=headers, json={"amount": "12"} if method == "PUT" else None)
    assert response.status_code == 401
    assert response.json()["code"] == 0
    assert await query("SELECT user_id FROM monthly_expense_limits") == []


@pytest.mark.parametrize("change", ["revoked", "expired", "inactive"])
async def test_monthly_limit_rechecks_session_after_middleware(client, query, monkeypatch, change):
    user = await logged_in(client)
    original = MonthlyLimitService.save

    async def changed_after_authentication(service, identity, data):
        if change == "revoked":
            await query("DELETE FROM auth_sessions WHERE token_hash = %s", (identity.token_hash,))
        elif change == "expired":
            await query("UPDATE auth_sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE token_hash = %s", (identity.token_hash,))
        else:
            await query("UPDATE users SET is_active = 0 WHERE id = %s", (identity.user_id,))
        return await original(service, identity, data)

    monkeypatch.setattr(MonthlyLimitService, "save", changed_after_authentication)
    response = await client.put("/user/monthly-limit", headers={"token": user["token"]}, json={"amount": "12"})
    assert response.status_code == 401
    assert await query("SELECT user_id FROM monthly_expense_limits") == []


async def test_monthly_limit_migration_only_creates_its_table_and_is_idempotent(client, settings, query):
    user = await logged_in(client)
    headers = {"token": user["token"]}
    before = await query("SELECT * FROM users")
    assert settings.mysql_database.startswith("managehub_auth_test_")
    await query("DROP TABLE monthly_expense_limits")
    try:
        with pytest.raises(RuntimeError, match="scripts/migrate_monthly_expense_limits.py"):
            await database.check_database()
        assert await migrate_monthly_expense_limits(settings) == {"created": True}
        assert await migrate_monthly_expense_limits(settings) == {"created": False}
        assert await query("SELECT * FROM users") == before
        assert (await client.put("/user/monthly-limit", headers=headers, json={"amount": "98.76"})).json()["code"] == 1
        assert await migrate_monthly_expense_limits(settings) == {"created": False}
        assert (await query("SELECT amount FROM monthly_expense_limits"))[0]["amount"] == Decimal("98.76")
        async with database.engine.connect() as connection:
            fks = await connection.run_sync(lambda sync: inspect(sync).get_foreign_keys("monthly_expense_limits"))
            assert fks[0]["constrained_columns"] == ["user_id"]
            assert fks[0]["referred_table"] == "users"
            assert fks[0]["options"]["ondelete"] == "CASCADE"
        await database.check_database()
    finally:
        # 即使断言失败，也恢复随机测试库的表，供测试夹具安全清理。
        await migrate_monthly_expense_limits(settings)

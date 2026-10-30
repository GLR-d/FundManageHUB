"""用真实 MySQL 验证概览的数据格式、月份边界和用户隔离。"""

from datetime import datetime
from decimal import Decimal

import pytest

from core.messages import Messages
from test_fund import authenticate, create_fund


@pytest.fixture(autouse=True)
def dashboard_time(monkeypatch):
    monkeypatch.setattr("service.dashboard.utcnow", lambda: datetime(2026, 10, 14, 4, 30))


@pytest.fixture
async def fund_headers(client):
    return await authenticate(client)


async def test_legacy_dashboard_endpoint_is_removed(client, fund_headers):
    response = await client.get("/dashboard", headers=fund_headers)
    assert response.status_code == 404
    assert response.json()["code"] == 0
    assert response.json()["data"] is None
    assert "/dashboard" not in (await client.get("/openapi.json")).json()["paths"]


async def test_statistics_requires_login(client):
    response = await client.get("/dashboard/statistics")
    assert response.status_code == 401
    assert response.json() == {"code": 0, "msg": "请先登录", "data": None}


async def test_empty_statistics_contains_every_day_and_zero_totals(client, fund_headers):
    response = await client.get("/dashboard/statistics", headers=fund_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 1 and body["msg"] is None
    assert body["data"] == {
        "month": "2026-10", "income": "0.00", "expense": "0.00", "previousMonthExpense": "0.00",
        "dailyExpenses": [{"date": f"2026-10-{day:02d}", "amount": "0.00"} for day in range(1, 32)],
        "categoryExpenses": [],
        "monthlyExpenses": [
            {"month": month, "amount": "0.00"}
            for month in ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
        ],
    }


async def test_statistics_aggregates_exact_expenses_excludes_income_and_other_users(client, fund_headers):
    for kind in range(11):
        await create_fund(client, fund_headers, type=str(kind), amount=f"{kind}.29")
    await create_fund(client, fund_headers, time="2026-09-01T00:00", amount="0.10")
    await create_fund(client, fund_headers, time="2026-09-30T23:59:59", amount="0.20")
    await create_fund(client, fund_headers, time="2026-09-14T12:00", type="7", amount="999.00")
    await create_fund(client, fund_headers, time="2026-09-14T12:00", type="8", amount="0.40")
    await create_fund(client, fund_headers, time="2026-09-14T12:00", type="9", amount="30.50")
    await create_fund(client, fund_headers, time="2025-11-14T12:00", type="10", amount="6.50")
    bob = await authenticate(client, "bob")
    await create_fund(client, bob, amount="999.00")
    await create_fund(client, bob, time="2026-09-14T12:00", amount="999.00")
    response = await client.get("/dashboard/statistics", headers=fund_headers)
    data = response.json()["data"]
    assert data["income"] == "33.16"
    assert data["expense"] == "25.03"
    assert data["categoryExpenses"] == [{"type": str(kind), "amount": f"{kind}.29"} for kind in [0, 1, 2, 3, 4, 5, 8]]
    assert data["previousMonthExpense"] == "0.70"
    assert data["monthlyExpenses"][-2:] == [{"month": "2026-09", "amount": "0.70"}, {"month": "2026-10", "amount": "25.03"}]
    assert data["dailyExpenses"][13] == {"date": "2026-10-14", "amount": "25.03"}
    assert all(row["amount"] == "0.00" for index, row in enumerate(data["dailyExpenses"]) if index != 13)


@pytest.mark.parametrize("month,previous_start,previous_last,start,last,too_early,after,days", [
    ("2028-01", "2027-12-01T00:00", "2027-12-31T23:59:59", "2028-01-01T00:00", "2028-01-31T23:59:59", "2027-11-30T23:59:59", "2028-02-01T00:00", 31),
    ("2028-02", "2028-01-01T00:00", "2028-01-31T23:59:59", "2028-02-01T00:00", "2028-02-29T23:59:59", "2027-12-31T23:59:59", "2028-03-01T00:00", 29),
    ("2026-02", "2026-01-01T00:00", "2026-01-31T23:59:59", "2026-02-01T00:00", "2026-02-28T23:59:59", "2025-12-31T23:59:59", "2026-03-01T00:00", 28),
])
async def test_statistics_month_bounds_cross_year_and_leap_day(
    client, fund_headers, month, previous_start, previous_last, start, last, too_early, after, days,
):
    for time, amount in [(previous_start, "0.30"), (previous_last, "0.40"), (start, "0.10"), (last, "0.20"), (too_early, "8.00"), (after, "9.00")]:
        await create_fund(client, fund_headers, time=time, amount=amount)
    data = (await client.get("/dashboard/statistics", headers=fund_headers, params={"month": month})).json()["data"]
    assert data["month"] == month
    assert data["income"] == "0.00" and data["expense"] == "0.30"
    assert data["previousMonthExpense"] == "0.70"
    assert [item["amount"] for item in data["monthlyExpenses"][-3:]] == ["8.00", "0.70", "0.30"]
    assert data["categoryExpenses"] == [{"type": "1", "amount": "0.30"}]
    assert len(data["dailyExpenses"]) == days
    assert data["dailyExpenses"][0] == {"date": month + "-01", "amount": "0.10"}
    assert data["dailyExpenses"][-1] == {"date": f"{month}-{days:02d}", "amount": "0.20"}
    assert all(row["amount"] == "0.00" for row in data["dailyExpenses"][1:-1])


async def test_statistics_default_month_uses_beijing_calendar(client, fund_headers, monkeypatch):
    monkeypatch.setattr("service.dashboard.utcnow", lambda: datetime(2026, 9, 30, 16, 1))
    await create_fund(client, fund_headers, time="2026-10-01T00:00", amount="0.10")
    await create_fund(client, fund_headers, time="2026-09-30T23:59", amount="0.20")
    data = (await client.get("/dashboard/statistics", headers=fund_headers)).json()["data"]
    assert data["month"] == "2026-10" and data["expense"] == "0.10"
    assert data["previousMonthExpense"] == "0.20"


@pytest.mark.parametrize("month", [
    "2026-1", "2026-00", "2026-13", "2026-02-01", "202610", "2026-10T00:00",
    " 2026-10", "2026-10 ", "0000-01", "0999-12", "10000-01", "", "2026-10 OR 1=1",
])
async def test_statistics_rejects_invalid_months(client, fund_headers, month):
    response = await client.get("/dashboard/statistics", headers=fund_headers, params={"month": month})
    assert response.status_code == 422 and response.json()["code"] == 0, response.text


@pytest.mark.parametrize("month,message", [
    ("2026-1", Messages.INVALID_DASHBOARD_MONTH_FORMAT),
    ("2026-13", Messages.INVALID_DASHBOARD_MONTH),
    ("0999-12", Messages.INVALID_DASHBOARD_MONTH_YEAR),
])
async def test_statistics_month_validation_uses_shared_messages(client, fund_headers, month, message):
    response = await client.get("/dashboard/statistics", headers=fund_headers, params={"month": month})
    assert response.status_code == 422
    assert response.json() == {"code": 0, "msg": f"month: Value error, {message}", "data": None}


@pytest.mark.parametrize("month", ["1000-01", "9999-12"])
async def test_statistics_database_year_limits_do_not_overflow(client, fund_headers, month):
    await create_fund(client, fund_headers, time=month + "-01T00:00", amount="0.29")
    data = (await client.get("/dashboard/statistics", headers=fund_headers, params={"month": month})).json()["data"]
    assert data["month"] == month and data["expense"] == "0.29"
    assert data["previousMonthExpense"] == "0.00"
    assert len(data["dailyExpenses"]) == 31
    assert data["monthlyExpenses"][-1] == {"month": month, "amount": "0.29"}
    assert data["monthlyExpenses"][0]["month"] == ("1000-01" if month == "1000-01" else "9999-01")
    assert len(data["monthlyExpenses"]) == (1 if month == "1000-01" else 12)


async def test_statistics_sums_in_sql_instead_of_loading_every_record(client, fund_headers, settings):
    from sqlalchemy import event
    from core import database

    for minute in range(10):
        await create_fund(client, fund_headers, time=f"2026-10-14T12:{minute:02d}", amount="0.01")
    statements = []
    engine = database.engine.sync_engine

    def capture(connection, cursor, statement, parameters, context, executemany):
        if "from funds" in statement.lower():
            statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", capture)
    try:
        data = (await client.get("/dashboard/statistics", headers=fund_headers)).json()["data"]
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert data["expense"] == "0.10" and data["dailyExpenses"][13]["amount"] == "0.10"
    assert data["categoryExpenses"] == [{"type": "1", "amount": "0.10"}]
    assert data["monthlyExpenses"][-1] == {"month": "2026-10", "amount": "0.10"}
    assert len(data["monthlyExpenses"]) == 12
    assert len(statements) == 1
    assert "sum(funds.amount)" in statements[0] and "group by" in statements[0]
    assert "funds.user_id =" in statements[0] and "funds.time >=" in statements[0] and "funds.time <" in statements[0]
    assert "funds.remark" not in statements[0] and "funds.photo" not in statements[0]


async def test_category_expenses_combine_days_skip_zero_and_preserve_decimal_precision(client, fund_headers):
    for time, kind, amount in [
        ("2026-10-01T00:00", "5", "90071992547000.91"),
        ("2026-10-12T12:00", "5", "0.09"),
        ("2026-10-13T12:00", "1", "0.10"),
        ("2026-10-14T12:00", "1", "0.20"),
        ("2026-10-15T12:00", "0", "0.00"),
        ("2026-10-16T12:00", "6", "999.00"),
        ("2026-10-17T12:00", "7", "999.00"),
        ("2026-09-30T23:59", "2", "999.00"),
        ("2026-11-01T00:00", "3", "999.00"),
    ]:
        await create_fund(client, fund_headers, time=time, type=kind, amount=amount)
    data = (await client.get("/dashboard/statistics", headers=fund_headers)).json()["data"]
    assert data["categoryExpenses"] == [
        {"type": "1", "amount": "0.30"},
        {"type": "5", "amount": "90071992547001.00"},
    ]
    assert sum(Decimal(item["amount"]) for item in data["categoryExpenses"]) == Decimal(data["expense"])
    assert data["monthlyExpenses"][-1] == {"month": "2026-10", "amount": "90071992547001.30"}


async def test_income_only_month_has_no_category_expenses(client, fund_headers):
    await create_fund(client, fund_headers, type="6", amount="100.00")
    await create_fund(client, fund_headers, type="7", amount="50.00")
    await create_fund(client, fund_headers, type="9", amount="12.30")
    await create_fund(client, fund_headers, type="10", amount="5.70")
    data = (await client.get("/dashboard/statistics", headers=fund_headers)).json()["data"]
    assert data["income"] == "168.00" and data["expense"] == "0.00"
    assert all(item["amount"] == "0.00" for item in data["monthlyExpenses"])
    assert data["categoryExpenses"] == []


async def test_monthly_expenses_cover_twelve_months_without_polluting_current_or_previous_totals(client, fund_headers):
    for time, kind, amount in [
        ("2025-10-31T23:59:59", "1", "999.00"),
        ("2025-11-01T00:00", "0", "0.10"),
        ("2025-11-30T23:59:59", "5", "0.20"),
        ("2025-12-31T23:59:59", "3", "12.34"),
        ("2026-01-01T00:00", "2", "23.45"),
        ("2026-08-14T12:00", "4", "100.00"),
        ("2026-09-30T23:59:59", "1", "0.40"),
        ("2026-10-01T00:00", "1", "0.50"),
        ("2026-10-31T23:59:59", "2", "0.60"),
        ("2026-11-01T00:00", "1", "999.00"),
        ("2025-11-14T12:00", "6", "999.00"),
        ("2026-09-14T12:00", "7", "999.00"),
    ]:
        await create_fund(client, fund_headers, time=time, type=kind, amount=amount)
    await create_fund(client, fund_headers, time="2026-09-14T12:00", type="9", amount="30.50")
    await create_fund(client, fund_headers, time="2025-11-14T12:00", type="10", amount="6.50")
    bob = await authenticate(client, "bob")
    await create_fund(client, bob, time="2025-11-01T00:00", amount="999.00")
    await create_fund(client, bob, time="2026-10-01T00:00", amount="999.00")
    data = (await client.get("/dashboard/statistics", headers=fund_headers)).json()["data"]
    assert data["monthlyExpenses"] == [
        {"month": "2025-11", "amount": "0.30"},
        {"month": "2025-12", "amount": "12.34"},
        {"month": "2026-01", "amount": "23.45"},
        *[{"month": f"2026-{month:02d}", "amount": "0.00"} for month in range(2, 8)],
        {"month": "2026-08", "amount": "100.00"},
        {"month": "2026-09", "amount": "0.40"},
        {"month": "2026-10", "amount": "1.10"},
    ]
    assert data["income"] == "0.00" and data["expense"] == "1.10"
    assert data["previousMonthExpense"] == "0.40"
    assert data["categoryExpenses"] == [{"type": "1", "amount": "0.50"}, {"type": "2", "amount": "0.60"}]
    assert sum(Decimal(item["amount"]) for item in data["dailyExpenses"]) == Decimal("1.10")


@pytest.mark.parametrize("month,first_month,count", [
    ("1000-02", "1000-01", 2),
    ("1000-11", "1000-01", 11),
    ("1000-12", "1000-01", 12),
    ("1001-01", "1000-02", 12),
])
async def test_monthly_expenses_clip_to_database_minimum_month(client, fund_headers, month, first_month, count):
    data = (await client.get("/dashboard/statistics", headers=fund_headers, params={"month": month})).json()["data"]
    assert len(data["monthlyExpenses"]) == count
    assert data["monthlyExpenses"][0] == {"month": first_month, "amount": "0.00"}
    assert data["monthlyExpenses"][-1] == {"month": month, "amount": "0.00"}
    assert data["previousMonthExpense"] == "0.00" and data["expense"] == "0.00"


async def test_chat_month_summary_counts_transfer_and_red_packet_as_income(client, fund_headers, query):
    from types import SimpleNamespace
    from agents.tools.common import AgentContext, get_month_summary

    await create_fund(client, fund_headers, type="8", amount="12.30", remark="交通")
    await create_fund(client, fund_headers, type="5", amount="4.20", remark="其他仍是其他")
    await create_fund(client, fund_headers, type="6", amount="100.00")
    await create_fund(client, fund_headers, type="7", amount="5.00")
    await create_fund(client, fund_headers, type="9", amount="12.30")
    await create_fund(client, fund_headers, type="10", amount="5.70")
    user_id = (await query("SELECT id FROM users"))[0]["id"]
    runtime = SimpleNamespace(context=AgentContext(user_id=user_id))
    result = await get_month_summary.coroutine(runtime)
    assert result == {"income": "123.00", "expense": "16.50", "balance": "106.50", "count": 6}

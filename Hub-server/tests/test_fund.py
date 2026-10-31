"""用真实 MySQL 验证账单页面的请求、金额精度和账号隔离。"""

from decimal import Decimal
from io import BytesIO
from urllib.parse import urlsplit

import pytest
from PIL import Image
from sqlalchemy import event

from client_helpers import app_client
from config import database
from repository.fund import FundRepository
from test_auth import register, login


async def authenticate(client, username="alice"):
    assert (await register(client, username=username, name=username)).json()["code"] == 1
    result = (await login(client, username=username)).json()
    assert result["code"] == 1
    return {"token": result["data"]["token"]}


@pytest.fixture
async def fund_headers(client):
    return await authenticate(client)


def payload(**changes):
    return {"time": "2026-10-14T12:30", "type": "1", "amount": "0.29", "remark": "午餐", "photo": "", **changes}


async def create_fund(client, headers, **changes):
    response = await client.post("/fund", headers=headers, json=payload(**changes))
    assert response.status_code == 200 and response.json()["code"] == 1, response.text
    return response.json()["data"]


def rows(response):
    assert response.status_code == 200 and response.json()["code"] == 1, response.text
    return [row for day in response.json()["data"]["items"].values() for row in day]


async def test_empty_fund_list_matches_frontend_format(client, fund_headers):
    assert (await client.get("/fund", headers=fund_headers)).json()["data"] == {"items": {}, "hasMore": False, "nextCursor": None}


async def test_funds_are_grouped_sorted_and_money_stays_exact(client, fund_headers, query):
    first = await create_fund(client, fund_headers, amount="0.10")
    second = await create_fund(client, fund_headers, amount="0.20")
    await create_fund(client, fund_headers, time="2026-10-13T10:00", type="6", amount="12.30", photo="/a.png,/b.png")
    result = (await client.get("/fund", headers=fund_headers)).json()["data"]["items"]
    assert list(result) == ["2026-10-14", "2026-10-13"]
    assert [row["id"] for row in result["2026-10-14"]] == [second["id"], first["id"]]
    assert [row["amount"] for row in result["2026-10-14"]] == ["0.20", "0.10"]
    assert result["2026-10-13"][0]["type"] == "6"
    assert result["2026-10-13"][0]["photo"] == "/a.png,/b.png"
    assert set(first) == {"id", "time", "type", "amount", "remark", "photo"}
    assert (await query("SELECT amount FROM funds WHERE id = %s", (first["id"],)))[0]["amount"] == Decimal("0.10")


async def test_detail_and_update_accept_the_frontend_copy_of_a_row(client, fund_headers):
    original = await create_fund(client, fund_headers)
    assert (await client.get(f"/fund/{original['id']}", headers=fund_headers)).json()["data"] == original
    unchanged = await client.put("/fund", headers=fund_headers, json=original)
    assert unchanged.json()["code"] == 1
    updated = {**original, "time": "2026-10-15T08:00", "amount": 0.31, "type": "7", "remark": "理财"}
    response = await client.put("/fund", headers=fund_headers, json=updated)
    assert response.json()["code"] == 1
    assert response.json()["data"]["amount"] == "0.31"
    assert response.json()["data"]["type"] == "7"
    assert list((await client.get("/fund", headers=fund_headers)).json()["data"]["items"]) == ["2026-10-15"]
    assert (await client.put("/fund", headers=fund_headers, json=payload())).status_code == 422


async def test_all_three_search_modes_and_literal_remark_search(client, fund_headers):
    lunch = await create_fund(client, fund_headers, remark="午餐优惠 10%")
    await create_fund(client, fund_headers, type="6", amount="100.00", remark="工资")
    for search_type, search_value in [("1", "1"), ("2", "0.29"), ("3", "午餐"), ("3", "%")]:
        result = await client.get("/fund/search", headers=fund_headers, params={"searchType": search_type, "searchValue": search_value})
        assert [row["id"] for row in rows(result)] == [lunch["id"]]
    assert rows((await client.get("/fund/search", headers=fund_headers, params={"searchType": "3", "searchValue": "missing"}))) == []
    assert rows((await client.get("/fund/search", headers=fund_headers, params={"searchType": "3", "searchValue": "' OR 1=1 --"}))) == []
    for search_type, search_value in [("1", "11"), ("2", "NaN"), ("2", "0.001"), ("2", "-1"), ("3", " ")]:
        result = await client.get("/fund/search", headers=fund_headers, params={"searchType": search_type, "searchValue": search_value})
        assert result.json()["code"] == 0


@pytest.mark.parametrize("changes", [
    {"amount": -1}, {"amount": "0.001"}, {"amount": "NaN"},
    {"amount": "90071992547409.92"}, {"type": "11"}, {"type": "-1"},
    {"time": "2026-02-29T12:00"}, {"time": "2026-10-14T12:00Z"},
    {"time": "0999-01-01T12:00"}, {"remark": "x" * 51},
    {"user_id": 999}, {"id": 999},
])
async def test_invalid_funds_do_not_write(client, fund_headers, query, changes):
    response = await client.post("/fund", headers=fund_headers, json=payload(**changes))
    assert response.status_code == 422 and response.json()["code"] == 0
    assert (await query("SELECT id FROM funds")) == []


async def test_transport_can_be_created_updated_and_searched_without_changing_other(client, fund_headers):
    other = await create_fund(client, fund_headers, type="5", remark="其他")
    transport = await create_fund(client, fund_headers, type="8", amount="12.30", remark="地铁")
    original = await create_fund(client, fund_headers, type="1")
    response = await client.put("/fund", headers=fund_headers, json={**original, "type": "8", "remark": "公交"})
    assert response.status_code == 200 and response.json()["data"]["type"] == "8"
    result = await client.get("/fund/search", headers=fund_headers, params={"searchType": "1", "searchValue": "8"})
    assert [row["id"] for row in rows(result)] == [original["id"], transport["id"]]
    assert (await client.get(f"/fund/{transport['id']}", headers=fund_headers)).json()["data"] == transport
    assert (await client.get(f"/fund/{other['id']}", headers=fund_headers)).json()["data"] == other


@pytest.mark.parametrize("kind,name", [("9", "收转账"), ("10", "收红包")])
async def test_income_categories_can_be_created_updated_and_searched(client, fund_headers, kind, name):
    old = await create_fund(client, fund_headers, type="6", remark="原有薪资")
    created = await create_fund(client, fund_headers, type=kind, amount="0.10", remark=name)
    original = await create_fund(client, fund_headers, type="1")
    response = await client.put("/fund", headers=fund_headers, json={**original, "type": kind, "remark": name})
    assert response.status_code == 200 and response.json()["data"]["type"] == kind
    result = await client.get("/fund/search", headers=fund_headers, params={"searchType": "1", "searchValue": kind})
    assert [row["id"] for row in rows(result)] == [original["id"], created["id"]]
    assert (await client.get(f"/fund/{created['id']}", headers=fund_headers)).json()["data"] == created
    assert (await client.get(f"/fund/{old['id']}", headers=fund_headers)).json()["data"] == old


async def test_accounts_cannot_read_search_update_or_delete_others_funds(client):
    alice = await authenticate(client, "alice")
    alice_fund = await create_fund(client, alice)
    bob = await authenticate(client, "bob")
    bob_fund = await create_fund(client, bob)
    assert [row["id"] for row in rows((await client.get("/fund", headers=bob)))] == [bob_fund["id"]]
    assert [row["id"] for row in rows((await client.get("/fund/search", headers=bob, params={"searchType": "2", "searchValue": "0.29"})))] == [bob_fund["id"]]
    assert (await client.get(f"/fund/{alice_fund['id']}", headers=bob)).json()["code"] == 0
    assert (await client.put("/fund", headers=bob, json={**alice_fund, "remark": "changed"})).json()["code"] == 0
    assert (await client.delete("/fund", headers=bob, params={"ids": str(alice_fund["id"])})).json()["code"] == 0
    assert (await client.get(f"/fund/{alice_fund['id']}", headers=alice)).json()["data"] == alice_fund
    mixed = await client.delete("/fund", headers=alice, params={"ids": f"{alice_fund['id']},{bob_fund['id']}"})
    assert mixed.json()["code"] == 0
    assert (await client.get(f"/fund/{alice_fund['id']}", headers=alice)).json()["code"] == 1


async def test_batch_delete_is_atomic_and_accepts_duplicate_ids(client, fund_headers):
    first = await create_fund(client, fund_headers)
    second = await create_fund(client, fund_headers)
    for invalid in ["", "0", "-1", "abc", "1,", "9007199254740992", f"{first['id']},999999"]:
        assert (await client.delete("/fund", headers=fund_headers, params={"ids": invalid})).json()["code"] == 0
        assert len(rows((await client.get("/fund", headers=fund_headers)))) == 2
    response = await client.delete("/fund", headers=fund_headers, params={"ids": f"{first['id']},{second['id']},{second['id']}"})
    assert response.json()["code"] == 1
    assert (await client.get("/fund", headers=fund_headers)).json()["data"] == {"items": {}, "hasMore": False, "nextCursor": None}


async def test_fund_operations_require_login(client):
    for method, path, data in [
        ("GET", "/fund", None), ("POST", "/fund", payload()),
        ("PUT", "/fund", {**payload(), "id": 1}), ("DELETE", "/fund?ids=1", None),
        ("GET", "/fund/search?searchType=1&searchValue=1", None), ("GET", "/fund/1", None),
    ]:
        response = await client.request(method, path, json=data)
        assert response.status_code == 401 and response.json()["code"] == 0


async def test_funds_persist_after_app_restarts(client, fund_headers, settings):
    fund = await create_fund(client, fund_headers)
    async with app_client(settings) as restarted:
        assert (await restarted.get(f"/fund/{fund['id']}", headers=fund_headers)).json()["data"] == fund


def image_bytes(format="PNG"):
    buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format=format)
    return buffer.getvalue()


@pytest.mark.parametrize("format,suffix", [("PNG", ".png"), ("JPEG", ".jpg")])
async def test_upload_and_photo_round_trip(client, fund_headers, oss_objects, query, format, suffix):
    content = image_bytes(format)
    response = await client.post("/upload", headers=fund_headers, files={"file": ("../../receipt.php", content, "application/octet-stream")})
    assert response.json()["code"] == 1, response.text
    url = response.json()["data"]
    assert url.startswith("https://images.example.test/images/") and urlsplit(url).path.endswith(suffix)
    assert urlsplit(url).query.startswith("test-signature=")
    assert "receipt" not in url and ".." not in url
    assert len(oss_objects) == 1
    assert oss_objects[0]["key"] == urlsplit(url).path.lstrip("/")
    assert oss_objects[0]["content"] == content
    assert oss_objects[0]["content_type"] == ("image/png" if format == "PNG" else "image/jpeg")
    fund = await create_fund(client, fund_headers, photo=f"{url},{url}")
    stored_url = "oss://managehub-test/" + oss_objects[0]["key"]
    assert (await query("SELECT photo FROM funds WHERE id = %s", (fund["id"],)))[0]["photo"] == f"{stored_url},{stored_url}"
    photos = (await client.get(f"/fund/{fund['id']}", headers=fund_headers)).json()["data"]["photo"].split(",")
    assert all(urlsplit(photo).path == urlsplit(url).path and urlsplit(photo).query for photo in photos)


async def test_upload_rejects_invalid_images_and_requires_login(client, fund_headers):
    for content in (b"not an image", image_bytes("GIF"), b"x" * (1024 * 1024 + 1)):
        response = await client.post("/upload", headers=fund_headers, files={"file": ("receipt.png", content, "image/png")})
        assert response.json()["code"] == 0
    response = await client.post("/upload", files={"file": ("receipt.png", image_bytes(), "image/png")})
    assert response.status_code == 401


async def test_day_pages_keep_whole_days_and_have_no_overlap(client, fund_headers):
    created = []
    for day in range(14, 7, -1):
        created.append((await create_fund(client, fund_headers, time=f"2026-10-{day:02d}T00:00")))
    # 同一天超过常见记录分页数量，也必须完整返回，并包含日末的记录。
    for minute in range(25):
        created.append((await create_fund(client, fund_headers, time=f"2026-10-10T23:{minute:02d}")))
    first = (await client.get("/fund", headers=fund_headers)).json()["data"]
    assert list(first["items"]) == [f"2026-10-{day:02d}" for day in range(14, 9, -1)]
    assert len(first["items"]["2026-10-10"]) == 26
    assert first["hasMore"] is True and first["nextCursor"] == "2026-10-10"
    second = (await client.get("/fund", headers=fund_headers, params={"before": first["nextCursor"]})).json()["data"]
    assert list(second["items"]) == ["2026-10-09", "2026-10-08"]
    assert second["hasMore"] is False and second["nextCursor"] is None
    ids = [row["id"] for page in (first, second) for records in page["items"].values() for row in records]
    assert len(ids) == len(set(ids)) == len(created)
    exhausted = (await client.get("/fund", headers=fund_headers, params={"before": "2026-10-08"})).json()["data"]
    assert exhausted == {"items": {}, "hasMore": False, "nextCursor": None}


async def test_search_cursor_counts_only_matching_days_and_keeps_filters(client, fund_headers):
    expected = []
    for day in range(14, 7, -1):
        match = day % 2 == 0
        row = await create_fund(client, fund_headers, time=f"2026-10-{day:02d}T12:00", remark="午餐" if match else "早餐")
        if match:
            expected.append(row["id"])
    parameters = {"searchType": 3, "searchValue": "午餐", "days": 2}
    first = (await client.get("/fund/search", headers=fund_headers, params=parameters)).json()["data"]
    assert list(first["items"]) == ["2026-10-14", "2026-10-12"]
    assert first["hasMore"] is True and first["nextCursor"] == "2026-10-12"
    second = (await client.get("/fund/search", headers=fund_headers, params={**parameters, "before": first["nextCursor"]})).json()["data"]
    assert list(second["items"]) == ["2026-10-10", "2026-10-08"]
    assert second["hasMore"] is False and second["nextCursor"] is None
    assert [row["id"] for page in (first, second) for records in page["items"].values() for row in records] == expected


@pytest.mark.parametrize("parameters", [
    {"days": 0}, {"days": 21}, {"days": "1.5"},
    {"before": "2026-02-29"}, {"before": "2026-1-01"}, {"before": "20261014"},
    {"before": "2026-10-14T12:00:00"}, {"before": "1791936000"},
    {"before": "2026-10-14 OR 1=1"}, {"before": ""},
])
async def test_both_page_endpoints_reject_invalid_boundaries(client, fund_headers, parameters):
    for path, search in [("/fund", {}), ("/fund/search", {"searchType": 3, "searchValue": "午餐"})]:
        response = await client.get(path, headers=fund_headers, params={**search, **parameters})
        assert response.status_code == 422 and response.json()["code"] == 0, response.text


async def test_day_cursor_accepts_leap_date_and_is_exclusive(client, fund_headers):
    earlier = await create_fund(client, fund_headers, time="2024-02-28T23:59")
    await create_fund(client, fund_headers, time="2024-02-29T00:00")
    response = await client.get("/fund", headers=fund_headers, params={"days": 20, "before": "2024-02-29"})
    assert rows(response) == [earlier]
    assert response.json()["data"]["hasMore"] is False


async def test_page_lookahead_and_cursor_never_include_another_user(client):
    alice = await authenticate(client, "alice")
    for day in range(14, 7, -1):
        await create_fund(client, alice, time=f"2026-10-{day:02d}T12:00")
    bob = await authenticate(client, "bob")
    own = await create_fund(client, bob, time="2026-10-10T12:00")
    for path, search in [("/fund", {}), ("/fund/search", {"searchType": 3, "searchValue": "午餐"})]:
        page = (await client.get(path, headers=bob, params={**search, "days": 1, "before": "2026-10-14"})).json()["data"]
        assert page == {"items": {"2026-10-10": [own]}, "hasMore": False, "nextCursor": None}


async def test_repository_only_fetches_page_dates_and_page_records(client, fund_headers, settings, query):
    for day in range(14, 7, -1):
        await create_fund(client, fund_headers, time=f"2026-10-{day:02d}T12:00")
    user_id = (await query("SELECT id FROM users WHERE email = %s", ("alice@example.test",)))[0]["id"]
    session = database.async_session()
    engine = session.bind.sync_engine
    reads = []

    def record_select(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            reads.append({
                "sql": " ".join(statement.split()),
                "parameters": dict(context.compiled_parameters[0]),
                # MySQL 的缓冲结果集已在 execute 后获知总行数，无需再次消费结果。
                "count": cursor.rowcount,
            })

    event.listen(engine, "after_cursor_execute", record_select)
    try:
        records, has_more = await FundRepository(session).get_page(user_id, days=2)
        assert len(records) == 2 and has_more is True
        assert [read["count"] for read in reads] == [3, 2]
        assert "LIMIT" in reads[0]["sql"].upper()
        assert 3 in reads[0]["parameters"].values(), "只预读 days + 1 个日期"
        assert "funds.time >= " in reads[1]["sql"], "第二次查询限制当前页的最早日期"
        assert all(
            "funds.user_id = " in read["sql"]
            and any(name.startswith("user_id") and value == user_id for name, value in read["parameters"].items())
            for read in reads
        )
    finally:
        event.remove(engine, "after_cursor_execute", record_select)
        await session.close()

"""通过接口验证 CSV 导入导出的格式、追加语义、原子性和账号隔离。"""

import asyncio
import csv
import threading
from datetime import datetime
from decimal import Decimal
from io import StringIO

import pytest
from sqlalchemy import event

from config import database
from service.fund_transfer import FundTransferService
from test_fund import authenticate, create_fund

CSV_HEADERS = ["时间", "类型", "金额", "备注", "图片"]
TYPE_NAMES = ["消费", "餐饮", "购物", "住房", "娱乐", "其他", "薪资", "理财", "交通", "收转账", "收红包"]


@pytest.fixture
async def transfer_headers(client):
    return await authenticate(client)


def csv_content(records, headers=CSV_HEADERS, encoding="utf-8-sig"):
    text = StringIO(newline="")
    writer = csv.writer(text)
    writer.writerow(headers)
    writer.writerows(records)
    return text.getvalue().encode(encoding)


async def import_csv(client, headers, content):
    return await client.post(
        "/fund/import", headers=headers,
        files={"file": ("账单.csv", content, "text/csv")},
    )


def exported_rows(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"\xef\xbb\xbf")
    reader = csv.reader(StringIO(response.content.decode("utf-8-sig"), newline=""))
    assert next(reader) == CSV_HEADERS
    return list(reader)


def assert_imported(response, count):
    assert response.status_code == 200, response.text
    assert response.json() == {"code": 1, "msg": None, "data": {"imported": count}}


def assert_error(response, status=422):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"code", "msg", "data"}
    assert body["code"] == 0 and body["data"] is None
    assert isinstance(body["msg"], str) and body["msg"]
    return body["msg"]


async def test_empty_export_and_downloadable_template_never_write(client, transfer_headers, query):
    assert exported_rows(await client.get("/fund/export", headers=transfer_headers)) == []
    template = await client.get("/fund/import/template", headers=transfer_headers)
    assert len(exported_rows(template)) >= 1
    assert await query("SELECT id FROM funds") == []
    # 下载模板只是取得文件；明确上传模板才会新增其中的示例。
    assert_imported(await import_csv(client, transfer_headers, template.content), 1)
    assert len(await query("SELECT id FROM funds")) == 1


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-8", "gb18030"])
@pytest.mark.parametrize("english", [False, True])
async def test_import_supports_header_aliases_encodings_and_all_types(client, transfer_headers, query, encoding, english):
    headers = ["time", "type", "amount"] if english else CSV_HEADERS[:3]
    records = [
        ["2026-10-14 12:30:00", str(index) if english else name, "0.29"]
        for index, name in enumerate(TYPE_NAMES)
    ]
    response = await import_csv(client, transfer_headers, csv_content(records, headers, encoding))
    assert_imported(response, 11)
    saved = await query("SELECT time, type, amount, remark, photo FROM funds ORDER BY id")
    assert [record["type"] for record in saved] == list(range(11))
    assert all(record["time"] == datetime(2026, 10, 14, 12, 30) for record in saved)
    assert all(record["amount"] == Decimal("0.29") for record in saved)
    assert all(record["remark"] == record["photo"] == "" for record in saved)
    exported = exported_rows(await client.get("/fund/export", headers=transfer_headers))
    assert [record[1] for record in exported] == list(reversed(TYPE_NAMES))


async def test_import_allows_reordered_optional_columns_and_quotes(client, transfer_headers, query):
    photo, remark = '/a.png,/带"引号.png', '备注,引号"和\n换行'
    content = csv_content(
        [[photo, "12.3", remark, "理财", "2026-10-14 12:30:00"]],
        ["photo", "金额", "remark", "类型", "time"],
    )
    assert_imported(await import_csv(client, transfer_headers, content), 1)
    assert (await query("SELECT amount, type, remark, photo FROM funds")) == [
        {"amount": Decimal("12.30"), "type": 7, "remark": remark, "photo": photo},
    ]


async def test_export_includes_every_day_orders_ties_and_preserves_money(client, transfer_headers):
    records = [[f"2026-10-{day:02d} 12:30:00", "1", "0.29", str(day), ""] for day in range(1, 8)]
    records.extend([
        ["2026-10-07 12:30:00", "6", "90071992547409.91", "较新编号", ""],
        ["2026-10-07 13:00:00", "7", "0", "较新时间", ""],
    ])
    assert_imported(await import_csv(client, transfer_headers, csv_content(records)), 9)
    # 列表默认只有五天；导出仍包含全部七天，并忽略列表分页参数。
    page = (await client.get("/fund", headers=transfer_headers)).json()["data"]
    assert len(page["items"]) == 5 and page["hasMore"] is True
    exported = exported_rows(await client.get("/fund/export", headers=transfer_headers, params={"days": 1}))
    assert [record[3] for record in exported] == ["较新时间", "较新编号", "7", "6", "5", "4", "3", "2", "1"]
    assert [record[2] for record in exported[:3]] == ["0.00", "90071992547409.91", "0.29"]
    assert datetime.fromisoformat(exported[-1][0]) == datetime(2026, 10, 1, 12, 30)


async def test_export_import_is_lossless_and_always_appends(client, transfer_headers, query):
    remarks = [
        '普通,引号"和\n换行', "=SUM(1,2)", "+1", "-1", "@cmd", " \t=1", "\t普通", "\r普通",
        "\n普通", "'原始单引号", "''两个单引号",
    ]
    photo = '/api/uploads/a.png,/api/uploads/带"引号.png'
    originals = [await create_fund(client, transfer_headers, remark=remark, photo=photo) for remark in remarks]
    exported = await client.get("/fund/export", headers=transfer_headers)
    records = exported_rows(exported)
    assert records[-1][3] == remarks[0]
    for record, remark in zip(records[:-1], reversed(remarks[1:])):
        assert record[3] == "'" + remark, "会触发公式或已含转义前缀的文本应加单引号"
    assert_imported(await import_csv(client, transfer_headers, exported.content), len(originals))
    saved = await query("SELECT id, amount, remark, photo FROM funds ORDER BY id")
    assert len(saved) == 2 * len(originals)
    assert [record["id"] for record in saved[:len(originals)]] == [record["id"] for record in originals]
    assert [record["remark"] for record in saved[:len(originals)]] == remarks
    assert [record["remark"] for record in saved[len(originals):]] == list(reversed(remarks))
    assert all(record["amount"] == Decimal("0.29") and record["photo"] == photo for record in saved)
    # 再次上传同一文件也会追加，不会默默去重或覆盖已有记录。
    assert_imported(await import_csv(client, transfer_headers, exported.content), len(originals))
    assert len(await query("SELECT id FROM funds")) == 3 * len(originals)


async def test_import_and_export_only_use_current_user(client, query):
    alice = await authenticate(client, "alice")
    alice_fund = await create_fund(client, alice, remark="Alice 的账单")
    bob = await authenticate(client, "bob")
    assert exported_rows(await client.get("/fund/export", headers=bob)) == []
    content = csv_content([["2026-10-14 12:30:00", "6", "12.30", "Bob 的账单", ""]])
    assert_imported(await import_csv(client, bob, content), 1)
    assert [row[3] for row in exported_rows(await client.get("/fund/export", headers=bob))] == ["Bob 的账单"]
    assert [row[3] for row in exported_rows(await client.get("/fund/export", headers=alice))] == ["Alice 的账单"]
    saved = await query("SELECT f.id, u.email FROM funds f JOIN users u ON u.id = f.user_id ORDER BY f.id")
    assert [record["email"] for record in saved] == ["alice@example.test", "bob@example.test"]
    assert saved[0]["id"] == alice_fund["id"] and saved[1]["id"] != alice_fund["id"]
    for forbidden in ("id", "user_id"):
        attack = csv_content([["2026-10-14 12:30:00", "1", "1.00", str(alice_fund["id"])]], ["time", "type", "amount", forbidden])
        assert_error(await import_csv(client, bob, attack))
    assert (await client.get(f"/fund/{alice_fund['id']}", headers=alice)).json()["data"] == alice_fund
    assert len(await query("SELECT id FROM funds")) == 2


@pytest.mark.parametrize("headers,record", [
    (["时间", "类型"], ["2026-10-14 12:30:00", "1"]),
    (["时间", "类型", "金额", "未知"], ["2026-10-14 12:30:00", "1", "1.00", ""]),
    (["时间", "类型", "金额", "金额"], ["2026-10-14 12:30:00", "1", "1.00", "2.00"]),
    (["time", "type", "amount", "金额"], ["2026-10-14 12:30:00", "1", "1.00", "2.00"]),
    (CSV_HEADERS[:3], ["2026-10-14 12:30:00", "1", "1.00", "多余列"]),
    (CSV_HEADERS, ["2026-10-14 12:30:00", "1"]),
])
async def test_invalid_headers_and_row_shapes_do_not_write(client, transfer_headers, query, headers, record):
    message = assert_error(await import_csv(client, transfer_headers, csv_content([record], headers)))
    assert "行" in message
    assert await query("SELECT id FROM funds") == []


@pytest.mark.parametrize("field,value", [
    (0, "2026-02-29 12:00:00"), (0, "0999-01-01 12:00:00"),
    (0, "2026-10-14T12:00:00Z"), (0, "2026-10-14T12:00:00+08:00"),
    (1, "11"), (1, "-1"), (1, "餐饮以外"),
    (2, "-0.01"), (2, "0.001"), (2, "NaN"), (2, "Infinity"), (2, "1e2"),
    (2, "90071992547409.92"), (3, "x" * 51), (4, "x" * 8193),
])
async def test_invalid_row_is_reported_with_line_and_entire_batch_has_no_write(client, transfer_headers, query, field, value):
    existing = await create_fund(client, transfer_headers, remark="保留原账单")
    valid = ["2026-10-14 12:30:00", "1", "0.29", "待导入", ""]
    invalid = [*valid]
    invalid[field] = value
    inserted = []

    def record_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("INSERT INTO FUNDS"):
            inserted.append(statement)

    event.listen(database.engine.sync_engine, "before_cursor_execute", record_insert)
    try:
        message = assert_error(await import_csv(client, transfer_headers, csv_content([valid, invalid])))
    finally:
        event.remove(database.engine.sync_engine, "before_cursor_execute", record_insert)
    assert "3" in message and "行" in message
    assert inserted == [], "整批校验通过之前不应尝试写入前面的有效行"
    assert [record["id"] for record in await query("SELECT id FROM funds")] == [existing["id"]]


@pytest.mark.parametrize("content", [b"", b"\xff", csv_content([])])
async def test_empty_and_unreadable_files_fail_without_writes(client, transfer_headers, query, content):
    assert_error(await import_csv(client, transfer_headers, content))
    assert await query("SELECT id FROM funds") == []


async def test_multiline_csv_reports_the_actual_bad_start_line(client, transfer_headers, query):
    content = csv_content([
        ["2026-10-14 12:30:00", "1", "0.29", "第一行\n第二行", ""],
        ["2026-10-14 12:30:00", "1", "bad", "错误记录", ""],
    ])
    message = assert_error(await import_csv(client, transfer_headers, content))
    assert "4" in message and "行" in message
    assert await query("SELECT id FROM funds") == []


async def test_import_size_and_row_limits_do_not_write(client, transfer_headers, query):
    over_bytes = b"x" * (2 * 1024 * 1024 + 1)
    assert_error(await import_csv(client, transfer_headers, over_bytes), 413)
    records = [["2026-10-14 12:30:00", "1", "0.29"]] * 5001
    assert_error(await import_csv(client, transfer_headers, csv_content(records, CSV_HEADERS[:3])))
    assert await query("SELECT id FROM funds") == []


async def test_maximum_row_count_is_accepted(client, transfer_headers, query):
    records = [["2026-10-14 12:30:00", "1", "0.29"]] * 5000
    assert_imported(await import_csv(client, transfer_headers, csv_content(records, CSV_HEADERS[:3])), 5000)
    assert (await query("SELECT COUNT(*) AS count, SUM(amount) AS total FROM funds")) == [
        {"count": 5000, "total": Decimal("1450.00")},
    ]


async def test_transfer_requires_login_and_multipart_file(client, transfer_headers, query):
    content = csv_content([["2026-10-14 12:30:00", "1", "0.29"]], CSV_HEADERS[:3])
    for path in ("/fund/export", "/fund/import/template"):
        assert_error(await client.get(path), 401)
    assert_error(await import_csv(client, {}, content), 401)
    assert_error(await client.post("/fund/import", headers=transfer_headers))
    assert await query("SELECT id FROM funds") == []


async def test_csv_cpu_work_runs_outside_the_request_event_loop(client, transfer_headers, monkeypatch):
    request_thread = threading.get_ident()
    worker_threads = []
    original_parse = FundTransferService.parse_csv
    original_build = FundTransferService.build_csv

    def parse(content):
        worker_threads.append(threading.get_ident())
        return original_parse(content)

    def build(records):
        worker_threads.append(threading.get_ident())
        return original_build(records)

    monkeypatch.setattr(FundTransferService, "parse_csv", staticmethod(parse))
    monkeypatch.setattr(FundTransferService, "build_csv", staticmethod(build))
    content = csv_content([["2026-10-14 12:30:00", "1", "0.29"]], CSV_HEADERS[:3])
    assert_imported(await import_csv(client, transfer_headers, content), 1)
    assert len(exported_rows(await client.get("/fund/export", headers=transfer_headers))) == 1
    assert len(worker_threads) == 2 and all(thread != request_thread for thread in worker_threads)


async def test_cancelling_import_during_validation_never_inserts(client, transfer_headers, query, monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    original_parse = FundTransferService.parse_csv

    def paused_parse(content):
        entered.set()
        try:
            assert release.wait(5), "测试必须释放 CSV 解析工作线程"
            return original_parse(content)
        finally:
            finished.set()

    monkeypatch.setattr(FundTransferService, "parse_csv", staticmethod(paused_parse))
    task = asyncio.create_task(import_csv(client, transfer_headers, csv_content([["2026-10-14 12:30:00", "1", "0.29"]], CSV_HEADERS[:3])))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
        if not task.done():
            task.cancel()
    assert await asyncio.to_thread(finished.wait, 3)
    assert await query("SELECT id FROM funds") == []

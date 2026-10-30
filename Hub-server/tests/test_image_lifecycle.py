"""用隔离 MySQL 和假 OSS 验证引用计数、事务及延迟删除。"""

import asyncio
from datetime import timedelta
from threading import Event
from types import SimpleNamespace

import pytest
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from client_helpers import browser_client
from core import database
from core.oss import delete_image as sdk_delete_image
from core.security import utcnow
from models.image_asset import ImageAsset
from scripts.migrate_image_assets import migrate_image_assets
from service.image_asset import cleanup_expired_images
from test_fund import authenticate, create_fund, payload
from test_fund_transfer import csv_content, import_csv
from test_upload_oss import assert_error, upload


@pytest.fixture
async def image_headers(client):
    return await authenticate(client)


async def asset(query, key):
    rows = await query("SELECT * FROM image_assets WHERE bucket = %s AND object_key = %s", ("managehub-test", key))
    assert len(rows) == 1
    return rows[0]


async def make_due(query, key):
    await query(
        "UPDATE image_assets SET cleanup_after = %s WHERE bucket = %s AND object_key = %s",
        (utcnow() - timedelta(minutes=1), "managehub-test", key),
    )


def assert_unused(row):
    assert row["reference_count"] == 0 and not row["deleting"]
    assert utcnow() + timedelta(hours=23, minutes=59) <= row["cleanup_after"] <= utcnow() + timedelta(hours=24, minutes=1)


async def test_upload_is_committed_before_the_first_oss_request(
    client, image_headers, settings, query, monkeypatch, oss_objects,
):
    loop = asyncio.get_running_loop()
    observed = []

    def inspect_registered(config, key, content, content_type):
        # 另开数据库连接，只有已提交的资产才能被 SDK 线程观察到。
        row = asyncio.run_coroutine_threadsafe(asset(query, key), loop).result(timeout=3)
        observed.append(row)
        assert row["bucket"] == settings.oss_bucket and row["object_key"] == key
        assert row["user_id"] == int(key.split("/")[1])
        assert_unused(row)

    monkeypatch.setattr("core.oss.put_image", inspect_registered)
    response = await upload(client, image_headers)
    assert response.status_code == 200 and response.json()["code"] == 1, response.text
    assert len(observed) == 1 and oss_objects == []
    assert (await query("SELECT * FROM image_assets")) == observed


async def test_rejected_upload_has_no_asset_registration(client, image_headers, query, oss_objects):
    response = await upload(client, image_headers, content=b"invalid image bytes")
    assert response.json()["code"] == 0
    assert await query("SELECT * FROM image_assets") == []
    assert oss_objects == []


async def test_failed_upload_remains_registered_and_can_be_cleaned(
    client, image_headers, settings, query, monkeypatch, oss_deletions,
):
    def unavailable(*args):
        raise RuntimeError("simulated PUT response loss")

    monkeypatch.setattr("core.oss.put_image", unavailable)
    assert_error(await upload(client, image_headers), 502)
    rows = await query("SELECT * FROM image_assets")
    assert len(rows) == 1
    assert_unused(rows[0])
    key = rows[0]["object_key"]
    assert await cleanup_expired_images(settings) == 0
    await make_due(query, key)
    assert await cleanup_expired_images(settings) == 1
    assert await query("SELECT * FROM image_assets") == []
    assert oss_deletions == [{"bucket": settings.oss_bucket, "key": key}]


async def test_cancelled_upload_still_has_a_recoverable_asset(
    client, image_headers, query, monkeypatch,
):
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()

    def held_put(*args):
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr("core.oss.put_image", held_put)
    task = asyncio.create_task(upload(client, image_headers))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=3)
    rows = await query("SELECT * FROM image_assets")
    assert len(rows) == 1
    assert_unused(rows[0])


async def test_duplicate_bill_photos_shared_bills_and_avatar_are_counted_per_entity(
    client, image_headers, settings, query, oss_objects, oss_deletions,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    first = await create_fund(client, image_headers, photo=url + "," + url)
    second = await create_fund(client, image_headers, photo=url)
    assert (await client.put("/user", headers=image_headers, json={"avatar": url})).json()["code"] == 1
    row = await asset(query, key)
    assert row["reference_count"] == 3 and row["cleanup_after"] is None

    # 原样保存同一账单不能重复增加计数；批删的重复编号也只减一次。
    assert (await client.put("/fund", headers=image_headers, json=first)).json()["code"] == 1
    deleted = await client.delete("/fund", headers=image_headers, params={"ids": f"{first['id']},{first['id']}"})
    assert deleted.json()["code"] == 1
    assert (await asset(query, key))["reference_count"] == 2
    assert (await client.put("/user", headers=image_headers, json={"avatar": ""})).json()["code"] == 1
    assert (await asset(query, key))["reference_count"] == 1
    assert await cleanup_expired_images(settings) == 0 and oss_deletions == []

    assert (await client.delete("/fund", headers=image_headers, params={"ids": str(second["id"])})).json()["code"] == 1
    assert_unused(await asset(query, key))
    assert await cleanup_expired_images(settings) == 0
    await make_due(query, key)
    assert await cleanup_expired_images(settings) == 1
    assert oss_deletions == [{"bucket": settings.oss_bucket, "key": key}]


async def test_photo_and_avatar_replacements_release_only_removed_references(
    client, image_headers, query, oss_objects,
):
    first_url = (await upload(client, image_headers)).json()["data"]
    second_url = (await upload(client, image_headers)).json()["data"]
    first_key, second_key = [item["key"] for item in oss_objects]
    fund = await create_fund(client, image_headers, photo=first_url)
    assert (await client.put("/user", headers=image_headers, json={"avatar": first_url})).json()["code"] == 1
    response = await client.put("/fund", headers=image_headers, json={**fund, "photo": second_url})
    assert response.json()["code"] == 1
    assert (await asset(query, first_key))["reference_count"] == 1
    assert (await asset(query, second_key))["reference_count"] == 1
    assert (await client.put("/user", headers=image_headers, json={"avatar": second_url})).json()["code"] == 1
    assert_unused(await asset(query, first_key))
    active = await asset(query, second_key)
    assert active["reference_count"] == 2 and active["cleanup_after"] is None


async def test_failed_batch_delete_rolls_back_funds_and_image_counts(
    client, image_headers, query, oss_objects, oss_deletions,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    fund = await create_fund(client, image_headers, photo=url)
    before = await asset(query, key)
    response = await client.delete("/fund", headers=image_headers, params={"ids": f"{fund['id']},999999999"})
    assert response.json()["code"] == 0
    assert await asset(query, key) == before
    assert (await client.get(f"/fund/{fund['id']}", headers=image_headers)).json()["code"] == 1
    assert oss_deletions == []


async def test_csv_import_counts_each_row_once_and_rejects_missing_assets_atomically(
    client, image_headers, query, oss_objects,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    content = csv_content([
        ["2026-10-21 12:00:00", "餐饮", "1.00", "重复图片", url + "," + url],
        ["2026-10-21 13:00:00", "餐饮", "2.00", "另一条账单", url],
    ])
    response = await import_csv(client, image_headers, content)
    assert response.json() == {"code": 1, "msg": None, "data": {"imported": 2}}
    assert (await asset(query, key))["reference_count"] == 2
    missing = "oss://managehub-test/" + key.rsplit("/", 1)[0] + "/" + "f" * 32 + ".jpg"
    invalid = csv_content([
        ["2026-10-21 14:00:00", "餐饮", "3.00", "有效行也应撤销", url],
        ["2026-10-21 15:00:00", "餐饮", "4.00", "资产不存在", missing],
    ])
    assert_error(await import_csv(client, image_headers, invalid), 404)
    assert len(await query("SELECT id FROM funds")) == 2
    assert (await asset(query, key))["reference_count"] == 2


async def test_new_binding_requires_an_existing_asset_and_blocks_deleting_assets(
    client, image_headers, query, oss_objects,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    missing = "oss://managehub-test/" + key.rsplit("/", 1)[0] + "/" + "e" * 32 + ".png"
    assert_error(await client.post("/fund", headers=image_headers, json=payload(photo=missing)), 404)
    await query("UPDATE image_assets SET deleting = TRUE WHERE object_key = %s", (key,))
    assert_error(await client.post("/fund", headers=image_headers, json=payload(photo=url)), 404)
    assert_error(await client.put("/user", headers=image_headers, json={"avatar": url}), 404)
    assert await query("SELECT id FROM funds") == []
    assert (await asset(query, key))["reference_count"] == 0


async def test_unused_grace_period_is_reset_when_a_rebound_asset_is_released(
    client, image_headers, settings, query, oss_objects, oss_deletions,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    await make_due(query, key)
    fund = await create_fund(client, image_headers, photo=url)
    assert (await asset(query, key))["cleanup_after"] is None
    assert await cleanup_expired_images(settings) == 0
    assert (await client.delete("/fund", headers=image_headers, params={"ids": str(fund["id"])})).json()["code"] == 1
    assert_unused(await asset(query, key))
    assert await cleanup_expired_images(settings) == 0 and oss_deletions == []


async def test_cleanup_failure_keeps_a_durable_claim_and_retries_later(
    client, image_headers, settings, query, oss_objects, oss_deletions, monkeypatch, caplog,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    await make_due(query, key)

    def unavailable(config, key):
        raise RuntimeError(f"private-deletion-error {config.oss_access_key_id} {config.oss_access_key_secret}")

    monkeypatch.setattr("core.oss.delete_image", unavailable)
    assert await cleanup_expired_images(settings) == 0
    failed = await asset(query, key)
    assert failed["deleting"] and failed["reference_count"] == 0
    assert utcnow() + timedelta(minutes=9) <= failed["cleanup_after"] <= utcnow() + timedelta(minutes=11)
    assert_error(await client.post("/fund", headers=image_headers, json=payload(photo=url)), 404)
    assert await cleanup_expired_images(settings) == 0
    assert "private-deletion-error" not in caplog.text
    assert settings.oss_access_key_id not in caplog.text and settings.oss_access_key_secret not in caplog.text

    def recovered(config, key):
        oss_deletions.append({"bucket": config.oss_bucket, "key": key})

    monkeypatch.setattr("core.oss.delete_image", recovered)
    await make_due(query, key)
    assert await cleanup_expired_images(settings) == 1
    assert await query("SELECT * FROM image_assets") == []
    assert oss_deletions == [{"bucket": settings.oss_bucket, "key": key}]


async def test_claim_is_committed_before_delete_and_competing_cleanup_or_attach_cannot_win(
    client, image_headers, settings, query, oss_objects, monkeypatch,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    await make_due(query, key)
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()
    deleted = []

    def held_delete(config, target):
        deleted.append(target)
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr("core.oss.delete_image", held_delete)
    task = asyncio.create_task(cleanup_expired_images(settings))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert (await asset(query, key))["deleting"]
        rejected = await asyncio.wait_for(client.post("/fund", headers=image_headers, json=payload(photo=url)), timeout=2)
        assert_error(rejected, 404)
        assert await asyncio.wait_for(cleanup_expired_images(settings), timeout=2) == 0
        assert deleted == [key]
    finally:
        release.set()
        cleaned = await asyncio.wait_for(task, timeout=3)
    assert cleaned == 1 and deleted == [key]
    assert await query("SELECT * FROM image_assets") == []
    assert await query("SELECT id FROM funds") == []


async def test_successful_oss_delete_with_failed_database_commit_cannot_be_rebound(
    client, image_headers, settings, query, oss_objects, oss_deletions,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    await make_due(query, key)

    def fail_final_commit(session):
        if any(isinstance(row, ImageAsset) for row in session.deleted):
            raise RuntimeError("simulated database failure after cloud deletion")

    event.listen(Session, "before_commit", fail_final_commit)
    try:
        assert await cleanup_expired_images(settings) == 0
    finally:
        event.remove(Session, "before_commit", fail_final_commit)
    assert oss_deletions == [{"bucket": settings.oss_bucket, "key": key}]
    assert (await asset(query, key))["deleting"]
    assert_error(await client.post("/fund", headers=image_headers, json=payload(photo=url)), 404)
    assert_error(await client.post("/upload/refresh", headers=image_headers, json={"url": url}), 404)
    await make_due(query, key)
    assert await cleanup_expired_images(settings) == 1
    assert len(oss_deletions) == 2
    assert await query("SELECT * FROM image_assets") == []


async def test_failed_business_commit_does_not_leak_an_image_reference(
    client, app, image_headers, query, oss_objects,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    before = await asset(query, key)

    def fail_commit(session):
        raise RuntimeError("simulated business commit failure")

    event.listen(Session, "before_commit", fail_commit)
    try:
        async with browser_client(app, raise_app_exceptions=False) as failing_client:
            assert_error(await failing_client.post("/fund", headers=image_headers, json=payload(photo=url)), 500)
    finally:
        event.remove(Session, "before_commit", fail_commit)
    assert await asset(query, key) == before
    assert await query("SELECT id FROM funds") == []


async def test_simultaneous_attachments_do_not_lose_references(client, image_headers, query, oss_objects):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    responses = await asyncio.gather(*[
        client.post("/fund", headers=image_headers, json=payload(photo=url, remark=f"并发{i}")) for i in range(3)
    ])
    assert all(response.status_code == 200 and response.json()["code"] == 1 for response in responses), [response.text for response in responses]
    assert len(await query("SELECT id FROM funds")) == 3
    state = await asset(query, key)
    assert state["reference_count"] == 3 and state["cleanup_after"] is None


async def test_same_key_in_a_different_bucket_is_never_cleaned_by_current_configuration(
    client, image_headers, settings, query, oss_objects, oss_deletions,
):
    await upload(client, image_headers)
    key = oss_objects[0]["key"]
    user_id = int(key.split("/")[1])
    await query(
        "INSERT INTO image_assets (bucket, object_key, user_id, reference_count, cleanup_after, deleting, created_at) "
        "VALUES (%s, %s, %s, 0, %s, FALSE, %s)",
        ("historical-bucket", key, user_id, utcnow() - timedelta(days=1), utcnow()),
    )
    assert await cleanup_expired_images(settings) == 0 and oss_deletions == []
    assert len(await query("SELECT * FROM image_assets WHERE object_key = %s", (key,))) == 2


async def test_migration_backfills_unique_entity_references_and_is_idempotent(
    client, image_headers, settings, query, oss_objects, oss_deletions,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    canonical = "oss://managehub-test/" + key
    first = await create_fund(client, image_headers)
    second = await create_fund(client, image_headers)
    # 模拟升级前已存在的签名地址、永久地址与重复图片。
    await query("DELETE FROM image_assets")
    await query("UPDATE funds SET photo = %s WHERE id = %s", (canonical + "," + url, first["id"]))
    await query("UPDATE funds SET photo = %s WHERE id = %s", (url, second["id"]))
    await query("UPDATE users SET avatar = %s WHERE id = %s", (canonical, int(key.split("/")[1])))
    before_users = await query("SELECT * FROM users")
    before_funds = await query("SELECT * FROM funds ORDER BY id")
    for _ in range(2):
        result = await migrate_image_assets(settings)
        assert isinstance(result, dict)
        state = await asset(query, key)
        assert state["reference_count"] == 3 and state["cleanup_after"] is None and not state["deleting"]
        assert await query("SELECT * FROM users") == before_users
        assert await query("SELECT * FROM funds ORDER BY id") == before_funds
    assert len(oss_objects) == 1 and oss_deletions == []


async def test_optional_migration_scan_registers_only_managed_objects_of_existing_users(
    client, image_headers, settings, query, oss_objects, oss_deletions, monkeypatch,
):
    url = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    user_id = int(key.split("/")[1])
    fund = await create_fund(client, image_headers)
    await query("UPDATE funds SET photo = %s WHERE id = %s", (url, fund["id"]))
    await query("DELETE FROM image_assets")
    orphan = f"images/{user_id}/" + "c" * 32 + ".jpg"
    unknown_owner = f"images/{user_id + 1000}/" + "d" * 32 + ".png"
    scans = []

    def inventory(config):
        scans.append(config.oss_bucket)
        return [key, orphan, unknown_owner, "uploads/legacy.png"]

    monkeypatch.setattr("core.oss.list_image_keys", inventory)
    result = await migrate_image_assets(settings, scan_oss=True)
    assert result["created"] == 2 and result["scanned"] == 4 and result["skipped"] == 2
    assert (await asset(query, key))["reference_count"] == 1
    assert_unused(await asset(query, orphan))
    assert len(await query("SELECT * FROM image_assets")) == 2
    # 幂等盘点不能每天把已有闲置图片的清理时间往后推。
    await make_due(query, orphan)
    deadline = (await asset(query, orphan))["cleanup_after"]
    repeated = await migrate_image_assets(settings, scan_oss=True)
    assert repeated["created"] == 0 and repeated["updated"] == 0
    assert (await asset(query, orphan))["cleanup_after"] == deadline
    assert scans == [settings.oss_bucket] * 2
    assert oss_deletions == [] and len(oss_objects) == 1


async def test_migration_dry_run_does_not_create_a_missing_table_or_change_business_data(
    client, image_headers, settings, query, oss_objects,
):
    await upload(client, image_headers)
    key = oss_objects[0]["key"]
    fund = await create_fund(client, image_headers)
    await query("UPDATE funds SET photo = %s WHERE id = %s", ("oss://managehub-test/" + key, fund["id"]))
    before_users = await query("SELECT * FROM users")
    before_funds = await query("SELECT * FROM funds ORDER BY id")
    await query("DROP TABLE image_assets")
    try:
        preview = await migrate_image_assets(settings, dry_run=True)
        assert preview["created"] == 1 and preview["references"] == 1
        async with database.engine.connect() as connection:
            assert not await connection.run_sync(lambda sync: inspect(sync).has_table("image_assets"))
        applied = await migrate_image_assets(settings)
        assert applied["created"] == 1 and applied["references"] == 1
        assert (await asset(query, key))["reference_count"] == 1
        assert await query("SELECT * FROM users") == before_users
        assert await query("SELECT * FROM funds ORDER BY id") == before_funds
    finally:
        # 被测迁移失败也不能把后续测试留在缺表状态。
        async with database.engine.begin() as connection:
            await connection.run_sync(lambda sync: ImageAsset.__table__.create(sync, checkfirst=True))


def delete_sdk_double(monkeypatch, *, failure=None, status=204):
    captured = {"closed": False, "calls": 0}

    class Transport:
        def __init__(self, **options):
            pass

        def close(self):
            captured["closed"] = True

    class Client:
        def __init__(self, config):
            captured["config"] = config

        def delete_object(self, request):
            captured["request"] = request
            captured["calls"] += 1
            if failure:
                raise failure
            return SimpleNamespace(status_code=status)

    monkeypatch.setattr("alibabacloud_oss_v2.Client", Client)
    monkeypatch.setattr("alibabacloud_oss_v2.transport.RequestsHttpClient", Transport)
    return captured


def test_sdk_delete_uses_exact_bucket_key_and_is_idempotent(settings, monkeypatch):
    captured = delete_sdk_double(monkeypatch)
    key = "images/1/" + "a" * 32 + ".png"
    sdk_delete_image(settings, key)
    sdk_delete_image(settings, key)
    assert captured["request"].bucket == settings.oss_bucket and captured["request"].key == key
    assert captured["calls"] == 2 and captured["closed"]


@pytest.mark.parametrize("failure,status", [(RuntimeError("SDK unavailable"), 204), (None, 500)])
def test_sdk_delete_closes_transport_on_failure(settings, monkeypatch, failure, status):
    captured = delete_sdk_double(monkeypatch, failure=failure, status=status)
    with pytest.raises(RuntimeError):
        sdk_delete_image(settings, "images/1/" + "b" * 32 + ".jpg")
    assert captured["closed"]


@pytest.mark.parametrize("key", [
    "", "/images/1/" + "a" * 32 + ".png", "uploads/old.png", "images/0/" + "a" * 32 + ".png",
    "images/1/../../private.png", "images/1/" + "A" * 32 + ".png", "images/1/" + "a" * 32 + ".gif",
    "images/01/" + "a" * 32 + ".png", "images/1/" + "a" * 32 + ".png?secret=value",
])
def test_sdk_delete_rejects_unmanaged_keys_before_constructing_client(settings, monkeypatch, key):
    captured = delete_sdk_double(monkeypatch)
    with pytest.raises(ValueError):
        sdk_delete_image(settings, key)
    assert captured["calls"] == 0 and "config" not in captured

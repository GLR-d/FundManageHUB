"""私有图片续签只允许当前账号登记的资产；所有签名均为本地测试替身。"""

import asyncio
from dataclasses import replace
from threading import Event
from urllib.parse import urlsplit

import pytest

from test_fund import authenticate
from test_upload_oss import assert_error, upload


@pytest.fixture
async def image_headers(client):
    return await authenticate(client)


async def refresh(client, headers, url):
    return await client.post("/upload/refresh", headers=headers, json={"url": url})


async def test_refresh_accepts_saved_or_signed_reference_without_changing_asset(
    client, image_headers, query, oss_objects, oss_deletions,
):
    uploaded = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    before = await query("SELECT * FROM image_assets")
    urls = [uploaded, "oss://managehub-test/" + key]
    for url in urls:
        response = await refresh(client, image_headers, url)
        assert response.status_code == 200, response.text
        assert response.json()["code"] == 1 and response.json()["msg"] is None
        renewed = response.json()["data"]
        assert isinstance(renewed, str) and renewed != uploaded
        assert urlsplit(renewed).path == "/" + key
        assert urlsplit(renewed).query
        assert await query("SELECT * FROM image_assets") == before
    assert len(oss_objects) == 1 and oss_deletions == []


async def test_refresh_requires_login_before_signing(client, oss_signatures):
    assert_error(await refresh(client, {}, "https://images.example.test/images/1/" + "a" * 32 + ".png"), 401)
    assert oss_signatures == []


async def test_another_account_cannot_refresh_someone_elses_image(
    client, image_headers, oss_signatures,
):
    uploaded = (await upload(client, image_headers)).json()["data"]
    other_headers = await authenticate(client, "bob")
    before = list(oss_signatures)
    assert_error(await refresh(client, other_headers, uploaded), 404)
    assert oss_signatures == before


async def test_nonexistent_and_deleting_images_are_not_signed(
    client, image_headers, query, oss_objects, oss_signatures,
):
    uploaded = (await upload(client, image_headers)).json()["data"]
    key = oss_objects[0]["key"]
    await query("UPDATE image_assets SET deleting = TRUE WHERE object_key = %s", (key,))
    before = list(oss_signatures)
    assert_error(await refresh(client, image_headers, uploaded), 404)
    missing = key.rsplit("/", 1)[0] + "/" + "a" * 32 + ".jpg"
    assert_error(await refresh(client, image_headers, "oss://managehub-test/" + missing), 404)
    assert oss_signatures == before


@pytest.mark.parametrize("url", [
    "/api/uploads/legacy.png",
    "https://external.example.test/a.png",
    "https://images.example.test.evil.test/images/1/" + "a" * 32 + ".png",
    "https://images.example.test/other/1/" + "a" * 32 + ".png",
    "oss://another-bucket/images/1/" + "a" * 32 + ".png",
])
async def test_unmanaged_references_are_not_refreshed(client, image_headers, oss_signatures, url):
    before = list(oss_signatures)
    assert_error(await refresh(client, image_headers, url), 404)
    assert oss_signatures == before


@pytest.mark.parametrize("body", [{}, {"url": None}, {"url": 123}, {"url": "x" * 8193}, {"url": "test", "user_id": 1}])
async def test_refresh_body_has_a_strict_contract(client, image_headers, oss_signatures, body):
    before = list(oss_signatures)
    assert_error(await client.post("/upload/refresh", headers=image_headers, json=body), 422)
    assert oss_signatures == before


@pytest.mark.parametrize("field", ["oss_endpoint", "oss_region", "oss_bucket", "oss_access_key_id", "oss_access_key_secret"])
async def test_missing_configuration_returns_503(
    client, app, settings, image_headers, oss_signatures, field,
):
    uploaded = (await upload(client, image_headers)).json()["data"]
    before = list(oss_signatures)
    app.state.settings = replace(settings, **{field: ""})
    assert_error(await refresh(client, image_headers, uploaded), 503)
    assert oss_signatures == before


async def test_refresh_failure_returns_only_the_generic_error(
    client, image_headers, settings, monkeypatch, caplog,
):
    uploaded = (await upload(client, image_headers)).json()["data"]

    def unavailable(config, key):
        raise RuntimeError(f"private-signing-error {config.oss_access_key_id} {config.oss_access_key_secret}")

    monkeypatch.setattr("utils.oss.sign_image_url", unavailable)
    body = assert_error(await refresh(client, image_headers, uploaded), 502)
    combined = str(body) + caplog.text
    assert "private-signing-error" not in combined
    assert settings.oss_access_key_id not in combined
    assert settings.oss_access_key_secret not in combined


async def test_slow_signing_does_not_block_health(client, image_headers, monkeypatch):
    uploaded = (await upload(client, image_headers)).json()["data"]
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()

    def held_sign(settings, key):
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5), "续签必须在工作线程中执行"
        return "https://images.example.test/" + key + "?renewed-signature"

    monkeypatch.setattr("utils.oss.sign_image_url", held_sign)
    task = asyncio.create_task(refresh(client, image_headers, uploaded))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert not task.done()
        health = await asyncio.wait_for(client.get("/health"), timeout=2)
        assert health.json()["code"] == 1
        assert not task.done()
    finally:
        release.set()
        response = await asyncio.wait_for(task, timeout=3)
    assert response.json()["code"] == 1

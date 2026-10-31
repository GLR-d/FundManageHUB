"""验证图片通过 OSS 上传，不向本地目录写入；所有云端请求均被测试夹具隔离。"""

import asyncio
import csv
import re
from dataclasses import replace
from datetime import timedelta
from io import StringIO
from threading import Event
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from utils.oss import put_image as sdk_put_image, sign_image_url as sdk_sign_image_url
from test_auth import login
from test_fund import authenticate, create_fund, image_bytes


@pytest.fixture
async def upload_headers(client):
    return await authenticate(client)


async def upload(client, headers, content=None, filename="receipt.png", content_type="image/png"):
    return await client.post(
        "/upload", headers=headers,
        files={"file": (filename, image_bytes() if content is None else content, content_type)},
    )


def assert_error(response, status):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"code", "msg", "data"}
    assert body["code"] == 0 and body["data"] is None
    assert isinstance(body["msg"], str) and body["msg"]
    return body


async def test_each_upload_uses_a_new_key_and_never_trusts_the_original_filename(
    client, upload_headers, oss_objects,
):
    for filename in ("../../receipt.php", "C:\\private\\receipt.jpg", "same.png", "same.png"):
        response = await upload(client, upload_headers, filename=filename, content_type="application/octet-stream")
        assert response.json()["code"] == 1, response.text
        assert re.fullmatch(r"https://images\.example\.test/images/[0-9]+/[0-9a-f]{32}\.png\?test-signature=[0-9]+", response.json()["data"])
    assert len(oss_objects) == 4
    assert len({item["key"] for item in oss_objects}) == 4
    assert all(item["content_type"] == "image/png" for item in oss_objects)


@pytest.mark.parametrize("content", [b"", b"not an image", image_bytes("GIF"), image_bytes()[:20]])
async def test_invalid_images_never_reach_oss(client, upload_headers, oss_objects, content):
    response = await upload(client, upload_headers, content)
    assert response.json()["code"] == 0, response.text
    assert oss_objects == []


async def test_exact_one_megabyte_is_accepted_and_one_extra_byte_is_rejected(
    client, upload_headers, oss_objects,
):
    original = image_bytes()
    content = original + b"\0" * (1024 * 1024 - len(original))
    accepted = await upload(client, upload_headers, content)
    assert accepted.json()["code"] == 1, accepted.text
    assert oss_objects[0]["content"] == content
    rejected = await upload(client, upload_headers, content + b"x")
    assert rejected.json()["code"] == 0, rejected.text
    assert len(oss_objects) == 1


@pytest.mark.parametrize("field", [
    "oss_endpoint", "oss_region", "oss_bucket", "oss_access_key_id", "oss_access_key_secret",
])
async def test_missing_oss_configuration_only_disables_upload(
    client, app, settings, upload_headers, oss_objects, field,
):
    app.state.settings = replace(settings, **{field: ""})
    assert (await client.get("/health")).json()["code"] == 1
    assert_error(await upload(client, upload_headers), 503)
    assert oss_objects == []


@pytest.mark.parametrize("value", [
    "http://images.example.test", "https://user:password@images.example.test", "https://images.example.test?secret=value",
    "https://images.example.test/#fragment", "not-a-url", "https://images.example.test/static/",
])
async def test_invalid_public_address_is_rejected_before_upload(
    client, app, settings, upload_headers, oss_objects, value,
):
    app.state.settings = replace(settings, oss_public_base_url=value)
    assert_error(await upload(client, upload_headers), 503)
    assert oss_objects == []


async def test_private_bucket_address_is_used_when_public_base_is_empty(
    client, app, settings, upload_headers, oss_objects,
):
    app.state.settings = replace(settings, oss_public_base_url="")
    response = await upload(client, upload_headers)
    assert response.json()["code"] == 1, response.text
    assert response.json()["data"].startswith("https://managehub-test.oss-cn-hangzhou.aliyuncs.com/" + oss_objects[0]["key"])
    assert urlsplit(response.json()["data"]).query


async def test_oss_failure_returns_generic_error_without_credentials(
    client, upload_headers, settings, oss_objects, monkeypatch, caplog,
):
    def unavailable(config, key, content, content_type):
        raise RuntimeError(f"sdk-private-details {config.oss_access_key_id} {config.oss_access_key_secret}")

    monkeypatch.setattr("utils.oss.put_image", unavailable)
    result = assert_error(await upload(client, upload_headers), 502)
    combined = str(result) + caplog.text
    assert "sdk-private-details" not in combined
    assert settings.oss_access_key_id not in combined
    assert settings.oss_access_key_secret not in combined
    assert oss_objects == []


async def test_upload_requires_login_before_any_oss_request(client, oss_objects):
    assert_error(await upload(client, {}), 401)
    assert oss_objects == []


async def test_private_bill_images_are_stored_without_signatures_and_resigned_for_each_response(
    client, upload_headers, oss_objects, query,
):
    signed_upload = (await upload(client, upload_headers)).json()["data"]
    key = oss_objects[0]["key"]
    created = await create_fund(client, upload_headers, photo=signed_upload)
    stored = "oss://managehub-test/" + key
    assert (await query("SELECT photo FROM funds WHERE id = %s", (created["id"],)))[0]["photo"] == stored
    assert urlsplit(created["photo"]).path == "/" + key
    assert created["photo"] != signed_upload

    detail = (await client.get(f"/fund/{created['id']}", headers=upload_headers)).json()["data"]
    assert detail["photo"] != created["photo"] and urlsplit(detail["photo"]).query
    updated = (await client.put("/fund", headers=upload_headers, json=detail)).json()["data"]
    assert updated["photo"] != detail["photo"]
    assert (await query("SELECT photo FROM funds WHERE id = %s", (created["id"],)))[0]["photo"] == stored

    for path, parameters in (("/fund", {}), ("/fund/search", {"searchType": 3, "searchValue": "午餐"})):
        page = (await client.get(path, headers=upload_headers, params=parameters)).json()["data"]
        listed = next(iter(page["items"].values()))[0]
        assert urlsplit(listed["photo"]).path == "/" + key
        assert listed["photo"] != detail["photo"] and urlsplit(listed["photo"]).query


async def test_private_avatar_is_stored_canonically_and_resigned_for_profile_and_login(
    client, upload_headers, oss_objects, query,
):
    signed_upload = (await upload(client, upload_headers)).json()["data"]
    key = oss_objects[0]["key"]
    response = await client.put("/user", headers=upload_headers, json={"avatar": signed_upload})
    assert response.json()["code"] == 1, response.text
    changed = response.json()["data"]
    assert urlsplit(changed["avatar"]).path == "/" + key and urlsplit(changed["avatar"]).query
    assert (await query("SELECT avatar FROM users WHERE id = %s", (changed["id"],)))[0]["avatar"] == "oss://managehub-test/" + key
    current = (await client.get("/user", headers=upload_headers)).json()["data"]
    assert current["avatar"] != changed["avatar"] and urlsplit(current["avatar"]).query
    logged_in = (await login(client)).json()["data"]
    assert logged_in["avatar"] != current["avatar"] and urlsplit(logged_in["avatar"]).path == "/" + key


async def test_missing_oss_credentials_preserve_avatar_and_allow_other_profile_changes(
    client, app, settings, upload_headers, oss_objects, query,
):
    signed_upload = (await upload(client, upload_headers)).json()["data"]
    changed = await client.put("/user", headers=upload_headers, json={"avatar": signed_upload})
    assert changed.json()["code"] == 1, changed.text
    user_id = changed.json()["data"]["id"]
    stored_avatar = "oss://managehub-test/" + oss_objects[0]["key"]

    app.state.settings = replace(settings, oss_access_key_id="")
    profile = await client.get("/user", headers=upload_headers)
    assert profile.json()["code"] == 1, profile.text
    assert profile.json()["data"]["avatar"] == stored_avatar
    updated = await client.put(
        "/user", headers=upload_headers,
        json={"name": "配置故障也能改昵称", "avatar": profile.json()["data"]["avatar"]},
    )
    assert updated.json()["code"] == 1, updated.text
    assert updated.json()["data"]["name"] == "配置故障也能改昵称"
    assert updated.json()["data"]["avatar"] == stored_avatar
    assert (await query("SELECT name, avatar FROM users WHERE id = %s", (user_id,))) == [
        {"name": "配置故障也能改昵称", "avatar": stored_avatar},
    ]
    assert (await client.get("/health")).json()["code"] == 1
    assert_error(await upload(client, upload_headers), 503)
    assert len(oss_objects) == 1


async def test_local_external_and_other_users_images_are_never_resigned(
    client, upload_headers, oss_signatures, query,
):
    alice = (await client.get("/user", headers=upload_headers)).json()["data"]
    other_user = alice["id"] + 1000
    images = [
        "/api/uploads/legacy.png", "https://external.example.test/a.png?keep=value",
        "https://images.example.test.evil.test/images/" + str(alice["id"]) + "/" + "d" * 32 + ".png",
        f"oss://managehub-test/images/{other_user}/" + "e" * 32 + ".png",
        f"https://images.example.test/images/{other_user}/" + "f" * 32 + ".jpg?unchanged=signature",
    ]
    photo = ",".join(images)
    before = len(oss_signatures)
    fund = await create_fund(client, upload_headers, photo=photo)
    assert fund["photo"] == photo
    assert (await query("SELECT photo FROM funds WHERE id = %s", (fund["id"],)))[0]["photo"] == photo
    assert (await client.get(f"/fund/{fund['id']}", headers=upload_headers)).json()["data"]["photo"] == photo
    assert len(oss_signatures) == before


async def test_csv_import_strips_private_image_signatures_and_export_contains_permanent_reference(
    client, upload_headers, oss_objects, query,
):
    signed_upload = (await upload(client, upload_headers)).json()["data"]
    key = oss_objects[0]["key"]
    buffer = StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["时间", "类型", "金额", "备注", "图片"])
    writer.writerow(["2026-10-21 12:00:00", "餐饮", "10.00", "导入私有图片", signed_upload])
    imported = await client.post(
        "/fund/import", headers=upload_headers,
        files={"file": ("bill.csv", buffer.getvalue().encode("utf-8-sig"), "text/csv")},
    )
    assert imported.json() == {"code": 1, "msg": None, "data": {"imported": 1}}
    stored = "oss://managehub-test/" + key
    assert (await query("SELECT photo FROM funds")) == [{"photo": stored}]
    exported = await client.get("/fund/export", headers=upload_headers)
    rows = list(csv.reader(StringIO(exported.content.decode("utf-8-sig"), newline="")))
    assert rows[1][4] == stored and "test-signature" not in exported.text


async def test_slow_oss_upload_does_not_block_health_requests(client, upload_headers, monkeypatch):
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()

    def held_upload(settings, key, content, content_type):
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5), "OSS 上传占用了请求事件循环"

    monkeypatch.setattr("utils.oss.put_image", held_upload)
    pending = asyncio.create_task(upload(client, upload_headers))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert not pending.done()
        response = await asyncio.wait_for(client.get("/health"), timeout=2)
        assert response.json()["code"] == 1
        assert not pending.done(), "健康检查应在 OSS 上传完成前返回"
    finally:
        release.set()
        result = await asyncio.wait_for(pending, timeout=3)
    assert result.json()["code"] == 1


def sdk_doubles(monkeypatch, *, failure=None):
    """直接测 SDK 适配边界，但用假 Client/transport 阻止任何网络访问。"""
    captured = {"closed": False}

    class Transport:
        def __init__(self, **options):
            captured["transport_options"] = options

        def close(self):
            captured["closed"] = True

    class Client:
        def __init__(self, config):
            captured["config"] = config

        def put_object(self, request):
            captured["request"] = request
            if failure:
                raise failure
            return SimpleNamespace(status_code=200)

        def presign(self, request, *, expires):
            captured["request"] = request
            captured["expires"] = expires
            if failure:
                raise failure
            return SimpleNamespace(url="https://signed.example.test/image.png?temporary-signature")

    monkeypatch.setattr("alibabacloud_oss_v2.Client", Client)
    monkeypatch.setattr("alibabacloud_oss_v2.transport.RequestsHttpClient", Transport)
    return captured


def test_sdk_upload_sends_bytes_and_content_type_without_changing_acl(settings, monkeypatch):
    captured = sdk_doubles(monkeypatch)
    content = image_bytes()
    key = "images/1/" + "a" * 32 + ".png"
    sdk_put_image(settings, key, content, "image/png")
    request = captured["request"]
    assert request.bucket == settings.oss_bucket and request.key == key
    assert request.body == content and request.content_type == "image/png"
    assert getattr(request, "acl", None) is None
    assert captured["config"].endpoint == settings.oss_endpoint
    assert captured["closed"] is True


def test_sdk_upload_accepts_an_endpoint_without_protocol(settings, monkeypatch):
    config = replace(settings, oss_endpoint="oss-cn-hangzhou.aliyuncs.com/")
    captured = sdk_doubles(monkeypatch)
    sdk_put_image(config, "images/1/" + "a" * 32 + ".png", b"bytes", "image/png")
    assert captured["config"].endpoint == "https://oss-cn-hangzhou.aliyuncs.com"
    assert captured["closed"] is True


def test_sdk_transport_is_closed_when_client_initialization_fails(settings, monkeypatch):
    captured = sdk_doubles(monkeypatch)

    def unavailable(config):
        raise RuntimeError("test client initialization failed")

    monkeypatch.setattr("alibabacloud_oss_v2.Client", unavailable)
    with pytest.raises(RuntimeError, match="test client initialization failed"):
        sdk_put_image(settings, "images/1/" + "a" * 32 + ".png", b"bytes", "image/png")
    assert captured["closed"] is True


@pytest.mark.parametrize("value", [
    "images.example.test", "http://images.example.test", "https://user:secret@images.example.test",
    "https://images.example.test/path", "https://images.example.test?query=1",
    "https://images.example.test/#fragment", "https://images.example.test:444",
    "https://images.example.test,evil.test", "https://images.example.test/\n",
])
def test_sdk_signing_rejects_invalid_public_origins_before_creating_a_client(settings, monkeypatch, value):
    captured = sdk_doubles(monkeypatch)
    with pytest.raises(ValueError, match="OSS_PUBLIC_BASE_URL"):
        sdk_sign_image_url(replace(settings, oss_public_base_url=value), "images/1/" + "a" * 32 + ".png")
    assert "config" not in captured and "transport_options" not in captured


@pytest.mark.parametrize("operation", [sdk_put_image, sdk_sign_image_url])
def test_sdk_transport_is_closed_after_failures(settings, monkeypatch, operation):
    captured = sdk_doubles(monkeypatch, failure=RuntimeError("test SDK unavailable"))
    arguments = (settings, "images/1/" + "b" * 32 + ".png")
    with pytest.raises(RuntimeError, match="test SDK unavailable"):
        operation(*arguments, b"bytes", "image/png") if operation is sdk_put_image else operation(*arguments)
    assert captured["closed"] is True


@pytest.mark.parametrize("custom_domain", [False, True])
def test_private_image_signing_has_one_hour_validity_and_supports_a_custom_domain(
    settings, monkeypatch, custom_domain,
):
    config = replace(settings, oss_public_base_url="https://images.example.test" if custom_domain else "")
    captured = sdk_doubles(monkeypatch)
    key = "images/1/" + "c" * 32 + ".jpg"
    assert sdk_sign_image_url(config, key) == "https://signed.example.test/image.png?temporary-signature"
    assert captured["request"].bucket == config.oss_bucket and captured["request"].key == key
    assert captured["expires"] == timedelta(hours=1)
    assert captured["config"].endpoint == (config.oss_public_base_url or config.oss_endpoint)
    assert captured["config"].use_cname is custom_domain
    assert captured["closed"] is True


def test_settings_representation_does_not_expose_oss_access_keys(settings):
    representation = repr(settings)
    assert settings.oss_access_key_id not in representation
    assert settings.oss_access_key_secret not in representation

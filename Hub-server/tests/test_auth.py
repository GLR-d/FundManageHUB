"""使用真实 MySQL 验证前端请求格式、登录与会话安全。"""

import asyncio
import base64
import secrets
import re
from datetime import timedelta, timezone

import pytest

from client_helpers import app_client, browser_client

from core import mail
from core.errors import BusinessError
from core.jwt_tokens import decode_access_token
from core.messages import Messages
from core.security import CAPTCHA_COOKIE, hash_secret, utcnow, verify_password

PASSWORD = "test-password-123"


def account_email(username="alice"):
    # username 只作为旧测试的短标签；真实接口只接收 email。
    return username.strip().lower() if "@" in username else f"{username.strip().lower()}@example.test"


async def registration_code(client, email):
    before = len(mail._test_outbox)
    response = await client.post("/register/email/request", json={"email": email})
    if response.status_code != 200 or response.json()["code"] != 1:
        return response, None
    if len(mail._test_outbox) == before:
        return response, None  # 已注册邮箱使用相同申请响应，不再发送邮件。
    assert len(mail._test_outbox) == before + 1, "注册验证码必须发送到测试邮件箱"
    message = mail._test_outbox.pop()
    assert message["recipient"] == email.strip().lower()
    return response, re.search(r"(?<!\d)\d{6}(?!\d)", message["body"]).group()


async def register(client, username="alice", **changes):
    payload = {"email": account_email(username), "name": "测试用户", "password": PASSWORD, **changes}
    response, code = await registration_code(client, payload["email"])
    if response.status_code != 200 or response.json()["code"] != 1:
        return response
    return await client.post("/register", json={**payload, "code": code or "000000"})


async def captcha(client, *, verified=True):
    response = await client.get("/login/captcha")
    assert response.status_code == 200
    data = response.json()["data"]
    if verified:
        result = await client.post("/login/verify", json={"uuid": data["uuid"], "code": " abcde "})
        assert result.json()["code"] == 1, result.text
    return data


async def login(client, username="alice", password=PASSWORD):
    await captcha(client)
    return await client.post("/login", json={"email": account_email(username), "password": password, "captcha": " abcde "})


def headers(token):
    return {"token": token}


async def logged_in(client):
    assert (await register(client)).json()["code"] == 1
    response = await login(client)
    assert response.json()["code"] == 1, response.text
    return response.json()["data"]


async def test_register_stores_hash_and_returns_public_user(client, query):
    response = await register(client)
    assert response.status_code == 200
    assert response.json()["code"] == 1
    user = response.json()["data"]
    assert user["email"] == account_email() and user["email_verified"] is True
    assert "username" not in user
    assert user["phone"] == user["avatar"] == ""
    assert user["created_at"].endswith("Z")
    assert "password" not in response.text
    stored = (await query("SELECT * FROM users"))[0]
    assert stored["password_hash"] != PASSWORD
    assert verify_password(PASSWORD, stored["password_hash"])


async def test_registration_preserves_password_surrounding_spaces(client, query):
    password = f" {PASSWORD} "
    assert (await register(client, password=password)).json()["code"] == 1
    stored = (await query("SELECT password_hash FROM users"))[0]
    assert verify_password(password, stored["password_hash"])
    assert not verify_password(password.strip(), stored["password_hash"])
    assert (await login(client, password=password.strip())).json()["code"] == 0
    assert (await login(client, password=password)).json()["code"] == 1


async def test_duplicate_email_is_case_insensitive(client, query):
    assert (await register(client)).json()["code"] == 1
    assert (await register(client, username=" Alice ", name="其他人")).json()["code"] == 0
    assert len(await query("SELECT id FROM users")) == 1


@pytest.mark.parametrize("changes", [
    {"name": "x" * 51}, {"email": " "}, {"email": "not-an-email"},
    {"password": "short"}, {"password": "        "}, {"is_active": False},
])
async def test_invalid_registration_does_not_write_or_echo_password(client, query, changes):
    response = await register(client, **changes)
    assert response.status_code == 422
    assert response.json()["code"] == 0
    assert PASSWORD not in response.text
    assert (await query("SELECT id FROM users")) == []


async def test_email_and_nickname_are_trimmed_without_changing_email_alias(client, query):
    name = "名" * 50
    assert (await register(client, email=" Alice.Tag+Hub@Example.Test ", name=f" {name} ")).json()["code"] == 1
    stored = (await query("SELECT email, name FROM users"))[0]
    assert stored == {"email": "alice.tag+hub@example.test", "name": name}
    assert (await register(client, username="bob")).json()["code"] == 1


@pytest.mark.parametrize("name", [None, "", "   "])
async def test_registration_can_use_default_nickname(client, name):
    _, code = await registration_code(client, account_email())
    payload = {"email": account_email(), "code": code, "password": PASSWORD}
    if name is not None:
        payload["name"] = name
    response = await client.post("/register", json=payload)
    assert response.json()["code"] == 1 and response.json()["data"]["name"] == "用户"


async def test_captcha_is_png_and_cookie_is_httponly(client):
    response = await client.get("/login/captcha")
    image = response.json()["data"]["image"]
    assert image.startswith("data:image/png;base64,")
    assert base64.b64decode(image.split(",", 1)[1]).startswith(b"\x89PNG\r\n\x1a\n")
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Path=/" in cookie and "SameSite=lax" in cookie
    assert response.headers["cache-control"] == "no-store"


async def test_captcha_wrong_attempt_limit(client, query):
    data = await captcha(client, verified=False)
    for _ in range(5):
        assert (await client.post("/login/verify", json={"uuid": data["uuid"], "code": "XXXXX"})).json()["code"] == 0
    assert (await client.post("/login/verify", json={"uuid": data["uuid"], "code": "ABCDE"})).json()["code"] == 0
    row = (await query("SELECT * FROM auth_captchas WHERE uuid = %s", (data["uuid"],)))[0]
    assert row["attempt_count"] == 5 and row["verified_at"] is None


async def test_expired_captcha_cannot_verify(client, query):
    data = await captcha(client, verified=False)
    await query("UPDATE auth_captchas SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE uuid = %s", (data["uuid"],))
    result = await client.post("/login/verify", json={"uuid": data["uuid"], "code": "ABCDE"})
    assert result.json()["code"] == 0


async def test_captcha_is_bound_to_requesting_browser(client, settings, query):
    data = await captcha(client, verified=False)
    async with app_client(settings) as other:
        assert (await other.post("/login/verify", json={"uuid": data["uuid"], "code": "ABCDE"})).json()["code"] == 0
        other.cookies.set(CAPTCHA_COOKIE, data["uuid"] + "." + secrets.token_urlsafe(32))
        assert (await other.post("/login/verify", json={"uuid": data["uuid"], "code": "ABCDE"})).json()["code"] == 0
    assert (await query("SELECT attempt_count FROM auth_captchas"))[0]["attempt_count"] == 0
    assert (await client.post("/login/verify", json={"uuid": data["uuid"], "code": "abcde"})).json()["code"] == 1


async def test_login_requires_prior_captcha_verification(client):
    await register(client)
    await captcha(client, verified=False)
    response = await client.post("/login", json={"email": account_email(), "password": PASSWORD, "captcha": "ABCDE"})
    assert response.json()["code"] == 0


@pytest.mark.parametrize("status_code", [401, 429])
async def test_login_business_error_keeps_status_and_clears_captcha_cookie(client, monkeypatch, status_code):
    async def fail_login(self, data, browser_cookie):
        raise BusinessError(Messages.LOGIN_FAILED, status_code)

    monkeypatch.setattr("router.login.LoginService.login", fail_login)
    await captcha(client, verified=False)
    response = await client.post(
        "/login", json={"email": account_email(), "password": PASSWORD, "captcha": "ABCDE"},
    )
    assert response.status_code == status_code
    assert response.json() == {"code": 0, "msg": Messages.LOGIN_FAILED, "data": None}
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert response.headers["cache-control"] == "no-store"
    assert client.cookies.get(CAPTCHA_COOKIE) is None


async def test_successful_login_returns_signed_jwt_and_stores_only_hash(client, query, settings):
    user = await logged_in(client)
    token = user["token"]
    session = (await query("SELECT * FROM auth_sessions"))[0]
    assert session["token_hash"] == hash_secret(token) and session["token_hash"] != token
    claims = decode_access_token(token, settings)
    assert claims["sub"] == str(user["id"])
    assert claims["exp"] - claims["iat"] == settings.session_ttl
    assert int(session["expires_at"].replace(tzinfo=timezone.utc).timestamp()) == claims["exp"]
    assert "password_hash" not in user
    profile = await client.get("/user", headers=headers(token))
    assert profile.status_code == 200 and profile.json()["data"]["id"] == user["id"]
    assert "password" not in profile.text


@pytest.mark.parametrize("header", ["token", "Authorization"])
async def test_logout_revokes_only_current_session_and_allows_login_again(client, query, header):
    user = await logged_in(client)
    token = user["token"]
    second_token = (await login(client)).json()["data"]["token"]
    await register(client, username="bob")
    other_user = (await login(client, username="bob")).json()["data"]
    request_headers = {header: f"Bearer {token}" if header == "Authorization" else token}

    response = await client.post("/login/logout", headers=request_headers)
    assert response.status_code == 200
    assert response.json() == {"code": 1, "msg": None, "data": None}
    remaining_hashes = {row["token_hash"] for row in await query("SELECT token_hash FROM auth_sessions")}
    assert remaining_hashes == {hash_secret(second_token), hash_secret(other_user["token"])}
    assert (await client.get("/user", headers=request_headers)).status_code == 401
    assert (await client.post("/login/logout", headers=request_headers)).status_code == 401
    for valid_token, user_id in ((second_token, user["id"]), (other_user["token"], other_user["id"])):
        profile = await client.get("/user", headers=headers(valid_token))
        assert profile.status_code == 200 and profile.json()["data"]["id"] == user_id

    relogin = await login(client)
    assert relogin.json()["code"] == 1
    new_token = relogin.json()["data"]["token"]
    assert new_token != token
    assert (await client.get("/user", headers=headers(new_token))).status_code == 200


@pytest.mark.parametrize("request_headers", [{}, {"token": "forged-token"}])
async def test_logout_requires_valid_session_and_keeps_existing_sessions(client, query, request_headers):
    user = await logged_in(client)
    response = await client.post("/login/logout", headers=request_headers)
    assert response.status_code == 401 and response.json()["code"] == 0
    assert response.headers["www-authenticate"] == "Bearer"
    assert [row["token_hash"] for row in await query("SELECT token_hash FROM auth_sessions")] == [hash_secret(user["token"])]
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 200


async def test_used_captcha_cannot_be_replayed(client, query):
    await register(client)
    data = await captcha(client)
    original_cookie = client.cookies.get(CAPTCHA_COOKIE)
    payload = {"email": account_email(), "password": PASSWORD, "captcha": "ABCDE"}
    assert (await client.post("/login", json=payload)).json()["code"] == 1
    client.cookies.clear()
    client.cookies.set(CAPTCHA_COOKIE, original_cookie)
    assert (await client.post("/login", json=payload)).json()["code"] == 0
    assert (await query("SELECT uuid FROM auth_captchas WHERE uuid = %s", (data["uuid"],))) == []


async def test_password_failures_lock_account_and_expired_lock_can_recover(client, query):
    user = await logged_in(client)

    async def attempt(password):
        return await login(client, password=password)

    for count in range(1, 6):
        assert (await attempt("wrong-password")).json()["code"] == 0
        stored = (await query("SELECT * FROM users"))[0]
        assert stored["login_failures"] == count
        assert (stored["locked_until"] is not None) == (count == 5)
    locked_until = stored["locked_until"]
    assert (await attempt(PASSWORD)).json()["code"] == 0
    stored = (await query("SELECT * FROM users"))[0]
    assert stored["login_failures"] == 5 and stored["locked_until"] == locked_until

    await query("UPDATE users SET locked_until = UTC_TIMESTAMP() - INTERVAL 1 SECOND")
    assert (await attempt("wrong-password")).json()["code"] == 0
    stored = (await query("SELECT * FROM users"))[0]
    assert stored["login_failures"] == 1 and stored["locked_until"] is None

    assert (await attempt(PASSWORD)).json()["code"] == 1
    stored = (await query("SELECT * FROM users"))[0]
    assert stored["login_failures"] == 0 and stored["locked_until"] is None


async def test_unknown_or_disabled_account_cannot_login(client, query):
    assert (await login(client, username="missing")).json()["code"] == 0
    await register(client)
    await query("UPDATE users SET is_active = FALSE")
    assert (await login(client)).json()["code"] == 0


@pytest.mark.parametrize("kind", ["missing", "forged", "expired", "disabled"])
async def test_invalid_sessions_return_401(client, query, kind):
    user = await logged_in(client)
    token = user["token"]
    if kind == "missing":
        request_headers = {}
    elif kind == "forged":
        request_headers = headers(secrets.token_urlsafe(32))
    else:
        request_headers = headers(token)
        if kind == "expired":
            await query("UPDATE auth_sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND")
        else:
            await query("UPDATE users SET is_active = FALSE")
    response = await client.get("/user", headers=request_headers)
    assert response.status_code == 401 and response.json()["code"] == 0


async def test_profile_updates_only_authenticated_user(client, query):
    user = await logged_in(client)
    await register(client, username="bob")
    data = {"name": "新昵称", "avatar": "/uploads/avatar.png", "phone": "13800138000"}
    response = await client.put("/user", headers=headers(user["token"]), json={field: f" {value} " for field, value in data.items()})
    assert response.json()["code"] == 1
    for field, value in data.items():
        assert response.json()["data"][field] == value
    assert (await query("SELECT name FROM users WHERE email = 'bob@example.test'"))[0]["name"] == "测试用户"
    assert (await client.put("/user", headers=headers(user["token"]), json={"id": 999, "name": "Other"})).status_code == 422


@pytest.mark.parametrize("phone", ["13800138000", " +86 138-0013-8000 ", "1234567", "1" * 20])
async def test_profile_phone_accepts_digits_and_keeps_display_format(client, query, phone):
    user = await logged_in(client)
    response = await client.put("/user", headers=headers(user["token"]), json={"phone": phone})
    assert response.status_code == 200 and response.json()["code"] == 1
    assert response.json()["data"]["phone"] == phone.strip()
    assert (await query("SELECT phone FROM users WHERE id = %s", (user["id"],)))[0]["phone"] == phone.strip()


@pytest.mark.parametrize("phone", [
    "-------", "1------", "123456", "+123-45", "138+00138000", "-+13800138000",
    "1380013800a", "１３８００１３８０００", "1" * 21,
])
async def test_invalid_profile_phone_keeps_stored_number(client, query, phone):
    user = await logged_in(client)
    original_phone = "13800138000"
    await client.put("/user", headers=headers(user["token"]), json={"phone": original_phone})
    response = await client.put("/user", headers=headers(user["token"]), json={"phone": phone})
    assert response.status_code == 422 and response.json()["code"] == 0
    assert (await query("SELECT phone FROM users WHERE id = %s", (user["id"],)))[0]["phone"] == original_phone


async def test_profile_phone_can_be_cleared_with_blank_string(client, query):
    user = await logged_in(client)
    await client.put("/user", headers=headers(user["token"]), json={"phone": "13800138000"})
    response = await client.put("/user", headers=headers(user["token"]), json={"phone": " "})
    assert response.status_code == 200 and response.json()["code"] == 1
    assert response.json()["data"]["phone"] == ""
    assert (await query("SELECT phone FROM users WHERE id = %s", (user["id"],)))[0]["phone"] == ""


@pytest.mark.parametrize("data", [
    {}, {"name": None}, {"avatar": "javascript:alert(1)"}, {"phone": "bad"},
    {"email": "not-email"}, {"password": "new-password-123", "name": "combined"},
])
async def test_invalid_profile_update_is_rejected(client, data):
    user = await logged_in(client)
    assert (await client.put("/user", headers=headers(user["token"]), json=data)).status_code == 422


async def test_legacy_password_routes_cannot_bypass_email_verification(client, query):
    user = await logged_in(client)
    token = user["token"]
    original = (await query("SELECT password_hash FROM users"))[0]["password_hash"]
    assert (await client.post("/user", headers=headers(token), json={"password": PASSWORD})).status_code == 405
    for payload in ({"password": "new-password-123"}, {"password": "new-password-123", "email": account_email(), "code": "123456"}):
        assert (await client.put("/user", headers=headers(token), json=payload)).status_code == 422
    assert (await client.put("/user/password", headers=headers(token), json={"password": "new-password-123"})).status_code == 422
    result = await client.put("/user/password", headers=headers(token), json={"email": account_email(), "code": "123456", "password": "new-password-123"})
    assert result.json()["code"] == 0
    assert (await query("SELECT password_hash FROM users"))[0]["password_hash"] == original
    assert (await client.get("/user", headers=headers(token))).status_code == 200


async def test_session_is_persistent_across_app_instances(client, settings):
    user = await logged_in(client)
    async with app_client(settings) as restarted:
        response = await restarted.get("/user", headers=headers(user["token"]))
        assert response.json()["data"]["id"] == user["id"]


async def test_concurrent_duplicate_registration_only_saves_one_user(client, app, query):
    _, code = await registration_code(client, account_email())
    payload = {"email": account_email(), "code": code, "password": PASSWORD}
    async def attempt(_):
        async with browser_client(app) as worker:
            return (await worker.post("/register", json=payload)).json()["code"]
    assert sorted(await asyncio.gather(*(attempt(index) for index in range(2)))) == [0, 1]
    assert len((await query("SELECT id FROM users"))) == 1


async def test_concurrent_captcha_replay_only_creates_one_session(client, app, query):
    await register(client)
    await captcha(client)
    original_cookie = client.cookies.get(CAPTCHA_COOKIE)

    async def attempt(_):
        async with browser_client(app) as worker:
            worker.cookies.set(CAPTCHA_COOKIE, original_cookie)
            return (await worker.post("/login", json={"email": account_email(), "password": PASSWORD, "captcha": "ABCDE"})).json()["code"]
    assert sorted(await asyncio.gather(*(attempt(index) for index in range(2)))) == [0, 1]
    assert len((await query("SELECT token_hash FROM auth_sessions"))) == 1


async def test_health_and_openapi_are_available(client):
    assert (await client.get("/health")).json()["code"] == 1
    assert (await client.get("/docs")).status_code == 200
    schema = (await client.get("/openapi.json")).json()
    assert set(schema["paths"]) == {
        "/health", "/register", "/register/email/request", "/login", "/login/captcha", "/login/verify", "/login/logout", "/user",
        "/fund", "/fund/search", "/fund/{fund_id}", "/fund/export", "/fund/import", "/fund/import/template",
        "/upload", "/upload/refresh", "/dashboard/statistics",
        "/chat/stream", "/chat/conversations", "/chat/conversations/{conversation_id}",
        "/chat/conversations/import", "/user/email/request", "/user/email/verify", "/user/password/request", "/user/password",
        "/login/password/forgot", "/login/password/reset",
        "/user/password/verify", "/user/email/current/request", "/user/email/current/verify", "/user/monthly-limit",
    }
    assert schema["components"]["securitySchemes"]["APIKeyHeader"]["name"] == "token"
    assert schema["paths"]["/login/logout"]["post"]["security"] == [
        {"HTTPBearer": []}, {"APIKeyHeader": []},
    ]


async def test_registration_requires_email_code_and_keeps_unverified_requests_out_of_users(client, query):
    response = await client.post("/register", json={"email": account_email(), "password": PASSWORD})
    assert response.status_code == 422
    response = await client.post("/register", json={"email": account_email(), "code": "123456", "password": PASSWORD})
    assert response.json()["code"] == 0
    assert await query("SELECT id FROM users") == []
    response, code = await registration_code(client, account_email())
    assert response.json()["code"] == 1 and code is not None
    assert await query("SELECT id FROM users") == []
    stored = (await query("SELECT * FROM auth_email_codes"))[0]
    assert stored["user_id"] is None and stored["purpose"] == "register"
    assert stored["code_hash"] != code and stored["code_hash"] != hash_secret(code)
    assert stored["expires_at"] - stored["created_at"] == timedelta(seconds=60)
    response = await client.post("/register", json={"email": account_email(), "code": code, "password": PASSWORD})
    assert response.json()["code"] == 1
    assert await query("SELECT hash_key FROM auth_email_codes") == []


@pytest.mark.parametrize("age, expected", [(59, 1), (60, 0)])
async def test_registration_code_expires_after_one_minute(client, query, monkeypatch, age, expected):
    now = utcnow().replace(microsecond=0)
    monkeypatch.setattr("service.email.utcnow", lambda: now)
    _, code = await registration_code(client, account_email())
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=age))
    response = await client.post("/register", json={"email": account_email(), "code": code, "password": PASSWORD})
    assert response.json()["code"] == expected
    assert len(await query("SELECT id FROM users")) == expected


@pytest.mark.parametrize("bad_attempts, expected", [(4, 1), (5, 0)])
async def test_registration_code_wrong_attempt_limit(client, query, bad_attempts, expected):
    _, code = await registration_code(client, account_email())
    wrong = code[:-1] + str((int(code[-1]) + 1) % 10)
    payload = {"email": account_email(), "password": PASSWORD}
    for _ in range(bad_attempts):
        assert (await client.post("/register", json={**payload, "code": wrong})).json()["code"] == 0
    response = await client.post("/register", json={**payload, "code": code})
    assert response.json()["code"] == expected
    assert len(await query("SELECT id FROM users")) == expected


async def test_registration_resend_requires_sixty_seconds_and_invalidates_old_code(client, monkeypatch):
    now = utcnow().replace(microsecond=0)
    monkeypatch.setattr("service.email.utcnow", lambda: now)
    codes = iter(("123456", "654321"))
    monkeypatch.setattr("service.email.generate_email_code", lambda: next(codes))
    _, first = await registration_code(client, account_email())
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=59))
    response = await client.post("/register/email/request", json={"email": account_email()})
    assert response.status_code == 429
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=60))
    _, second = await registration_code(client, account_email())
    payload = {"email": account_email(), "password": PASSWORD}
    assert first != second
    assert (await client.post("/register", json={**payload, "code": first})).json()["code"] == 0
    assert (await client.post("/register", json={**payload, "code": second})).json()["code"] == 1


async def test_registration_code_is_not_a_reset_code_or_other_email_code(client, query):
    _, code = await registration_code(client, account_email())
    assert (await client.post("/login/password/reset", json={"email": account_email(), "code": code, "password": PASSWORD})).json()["code"] == 0
    assert (await client.post("/register", json={"email": "other@example.test", "code": code, "password": PASSWORD})).json()["code"] == 0
    assert await query("SELECT id FROM users") == []
    assert (await client.post("/register", json={"email": account_email(), "code": code, "password": PASSWORD})).json()["code"] == 1


async def test_unknown_and_registered_registration_send_have_same_response(client, query):
    assert (await register(client)).json()["code"] == 1
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    known = await client.post("/register/email/request", json={"email": account_email()})
    unknown = await client.post("/register/email/request", json={"email": "unknown@example.test"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json() == {"code": 1, "msg": None, "data": None}
    assert len(mail._test_outbox) == 1 and mail._test_outbox[0]["recipient"] == "unknown@example.test"


async def test_unverified_email_cannot_log_in_and_username_payload_is_rejected(client, query):
    assert (await register(client)).json()["code"] == 1
    await query("UPDATE users SET email_verified_at = NULL")
    assert (await login(client)).json()["code"] == 0
    response = await client.post("/login", json={"username": "alice", "password": PASSWORD, "captcha": "ABCDE"})
    assert response.status_code == 422
    response = await client.post("/register", json={"username": "alice", "name": "Alice", "password": PASSWORD})
    assert response.status_code == 422

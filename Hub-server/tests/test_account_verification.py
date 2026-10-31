"""两阶段账号修改：真实数据库、隔离 SMTP 和会话绑定的一次性授权。"""

import asyncio
from datetime import timedelta

import pytest

from client_helpers import browser_client
from utils.security import utcnow, verify_password
from test_auth import PASSWORD, headers, login, logged_in, register
from test_email_recovery import BIND_EMAIL, EMAIL, SUCCESS, email_code, verified_user


async def current_proof(client, user, mail_outbox, kind="password"):
    prefix = "/user/password" if kind == "password" else "/user/email/current"
    sent = await client.post(prefix + "/request", headers=headers(user["token"]), json={"email": EMAIL})
    assert sent.json() == SUCCESS
    code = email_code(mail_outbox[-1])
    verified = await client.post(prefix + "/verify", headers=headers(user["token"]), json={"email": EMAIL, "code": code})
    assert verified.json()["code"] == 1
    assert verified.headers["cache-control"] == "no-store"
    return verified.json()["data"], code


async def test_password_first_step_consumes_code_without_modifying_password_or_session(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    grant, code = await current_proof(client, user, mail_outbox)
    assert grant["expiresIn"] == 300 and len(grant["verificationToken"]) >= 32
    rows = await query("SELECT * FROM auth_email_codes")
    assert len(rows) == 1 and rows[0]["purpose"] == "password_grant"
    assert grant["verificationToken"] not in str(rows) and code not in str(rows)
    assert rows[0]["expires_at"] - rows[0]["created_at"] == timedelta(seconds=300)
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 200
    assert verify_password(PASSWORD, (await query("SELECT password_hash FROM users"))[0]["password_hash"])
    repeated = await client.post("/user/password/verify", headers=headers(user["token"]), json={"email": EMAIL, "code": code})
    assert repeated.json()["code"] == 0
    password = " new-password-123 "
    changed = await client.put("/user/password", headers=headers(user["token"]), json={"verificationToken": grant["verificationToken"], "password": password})
    assert changed.json() == SUCCESS
    assert verify_password(password, (await query("SELECT password_hash FROM users"))[0]["password_hash"])
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []
    assert (await query("SELECT token_hash FROM auth_sessions")) == []


async def test_binding_routes_require_old_email_proof_before_sending_or_consuming_target_code(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    for path, data in [
        ("/user/email/request", {"email": BIND_EMAIL}),
        ("/user/email/verify", {"email": BIND_EMAIL, "code": "123456"}),
    ]:
        response = await client.post(path, headers=headers(user["token"]), json=data)
        assert response.status_code == 428
        assert response.json()["msg"] == "邮箱验证已失效，请重新验证"
    assert mail_outbox == []
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []
    assert (await query("SELECT email FROM users"))[0]["email"] == EMAIL


async def test_email_change_verifies_both_addresses_and_consumes_the_grant_once(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    other = (await login(client)).json()["data"]
    grant, _ = await current_proof(client, user, mail_outbox, "email")
    assert mail_outbox[-1]["recipient"] == EMAIL
    token = grant["verificationToken"]
    assert (await query("SELECT email FROM users"))[0]["email"] == EMAIL
    sent = await client.post("/user/email/request", headers=headers(user["token"]), json={"email": BIND_EMAIL, "verificationToken": token})
    assert sent.json() == SUCCESS
    assert mail_outbox[-1]["recipient"] == BIND_EMAIL
    code = email_code(mail_outbox[-1])
    refused = await client.post("/user/email/verify", headers=headers(user["token"]), json={"email": BIND_EMAIL, "code": code, "verificationToken": "x" * 43})
    assert refused.status_code == 428
    result = await client.post("/user/email/verify", headers=headers(user["token"]), json={"email": BIND_EMAIL, "code": code, "verificationToken": token})
    assert result.json()["data"]["email"] == BIND_EMAIL
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 200
    assert (await client.get("/user", headers=headers(other["token"]))).status_code == 401
    repeated = await client.post("/user/email/verify", headers=headers(user["token"]), json={"email": BIND_EMAIL, "code": code, "verificationToken": token})
    assert repeated.status_code == 428


async def test_grants_are_isolated_by_purpose_user_and_exact_login_session(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    other = (await login(client)).json()["data"]
    assert (await register(client, username="bob")).json()["code"] == 1
    bob = (await login(client, username="bob")).json()["data"]
    grant, _ = await current_proof(client, user, mail_outbox)
    token = grant["verificationToken"]
    for identity in (other, bob):
        result = await client.put("/user/password", headers=headers(identity["token"]), json={"verificationToken": token, "password": "new-password-123"})
        assert result.status_code == 428
    wrong_purpose = await client.post("/user/email/request", headers=headers(user["token"]), json={"verificationToken": token, "email": BIND_EMAIL})
    assert wrong_purpose.status_code == 428
    wrong_secret = await client.put("/user/password", headers=headers(user["token"]), json={"verificationToken": "x" * 43, "password": "new-password-123"})
    assert wrong_secret.status_code == 428
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 200
    assert verify_password(PASSWORD, (await query("SELECT password_hash FROM users WHERE id = %s", (user["id"],)))[0]["password_hash"])


@pytest.mark.parametrize("age, expected_status", [(299, 200), (300, 428)])
async def test_grant_expires_at_exactly_five_minutes(client, query, mail_outbox, monkeypatch, age, expected_status):
    now = utcnow().replace(microsecond=0)
    monkeypatch.setattr("service.email.utcnow", lambda: now)
    user = await verified_user(client, query, mail_outbox)
    grant, _ = await current_proof(client, user, mail_outbox)
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=age))
    response = await client.put("/user/password", headers=headers(user["token"]), json={"verificationToken": grant["verificationToken"], "password": "new-password-123"})
    assert response.status_code == expected_status


@pytest.mark.parametrize("change", ["password", "email", "resend"])
async def test_grants_cannot_survive_account_changes_or_resending_first_step(client, query, mail_outbox, change):
    user = await verified_user(client, query, mail_outbox)
    grant, _ = await current_proof(client, user, mail_outbox)
    if change == "password":
        await query("UPDATE users SET password_hash = CONCAT(password_hash, 'changed')")
    elif change == "email":
        await query("UPDATE users SET email = 'different@example.test'")
    else:
        await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
        assert (await client.post("/user/password/request", headers=headers(user["token"]), json={"email": EMAIL})).json() == SUCCESS
    response = await client.put("/user/password", headers=headers(user["token"]), json={"verificationToken": grant["verificationToken"], "password": "new-password-123"})
    assert response.status_code == 428


async def test_current_email_proof_enforces_wrong_attempt_limit_and_target_address(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    for address in (BIND_EMAIL, "unknown@example.test"):
        result = await client.post("/user/email/current/request", headers=headers(user["token"]), json={"email": address})
        assert result.json()["code"] == 0
    assert mail_outbox == []
    sent = await client.post("/user/email/current/request", headers=headers(user["token"]), json={"email": EMAIL})
    assert sent.json() == SUCCESS
    code = email_code(mail_outbox[-1])
    wrong = code[:-1] + str((int(code[-1]) + 1) % 10)
    for _ in range(5):
        assert (await client.post("/user/email/current/verify", headers=headers(user["token"]), json={"email": EMAIL, "code": wrong})).json()["code"] == 0
    assert (await client.post("/user/email/current/verify", headers=headers(user["token"]), json={"email": EMAIL, "code": code})).json()["code"] == 0
    assert (await query("SELECT attempt_count FROM auth_email_codes"))[0]["attempt_count"] == 5


async def test_first_step_verification_and_final_password_change_are_each_once_under_concurrency(client, app, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    assert (await client.post("/user/password/request", headers=headers(user["token"]), json={"email": EMAIL})).json() == SUCCESS
    code = email_code(mail_outbox[-1])
    async def prove():
        async with browser_client(app) as browser:
            return (await browser.post("/user/password/verify", headers=headers(user["token"]), json={"email": EMAIL, "code": code})).json()
    results = await asyncio.gather(prove(), prove())
    assert sorted(result["code"] for result in results) == [0, 1]
    token = next(result["data"]["verificationToken"] for result in results if result["code"] == 1)
    async def change():
        async with browser_client(app) as browser:
            return (await browser.put("/user/password", headers=headers(user["token"]), json={"verificationToken": token, "password": "new-password-123"})).json()["code"]
    assert sorted(await asyncio.gather(change(), change())) == [0, 1]
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []

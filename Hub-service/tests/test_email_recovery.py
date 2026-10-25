"""真实 MySQL 验证邮箱换绑与密码找回，所有邮件均进入测试 outbox。"""

import asyncio
import logging
import re
import smtplib
import ssl
from dataclasses import replace
from datetime import timedelta
from itertools import count

import pytest
from pydantic import ValidationError
from sqlalchemy import update

from models.auth import AuthEmailRateLimit
from schemas.auth_request import EmailRequest

from client_helpers import app_client, browser_client
from core import database, mail
from core.mail import send_email as send_email_with_real_transport
from core.security import hash_secret, utcnow, verify_password
from repository.email import EmailRepository
from test_auth import PASSWORD, account_email, headers, logged_in, login, register

SUCCESS = {"code": 1, "msg": None, "data": None}
EMAIL = "alice@example.test"
BIND_EMAIL = "updated@example.test"


@pytest.fixture(autouse=True)
def predictable_email_code(monkeypatch):
    codes = count(100000)
    monkeypatch.setattr("service.email.generate_email_code", lambda: str(next(codes)))


def email_code(message):
    codes = re.findall(r"(?<!\d)\d{6}(?!\d)", message["body"])
    assert len(codes) == 1
    assert "http://" not in message["body"] and "https://" not in message["body"]
    return codes[0]


async def prepare_binding_grant(client, user):
    """旧绑定用例显式完成第一步；安全门槛用例直接调用路由，不使用此帮助函数。"""
    profile = await client.get("/user", headers=headers(user["token"]))
    if profile.status_code != 200:
        return ""
    address = profile.json()["data"]["email"]
    # 注册后第一步验证的冷却仅在随机测试库中推进；生产接口仍共享真实冷却。
    async with database.engine.begin() as connection:
        await connection.execute(update(AuthEmailRateLimit).where(
            AuthEmailRateLimit.hash_key == hash_secret("email-address\0" + address),
        ).values(window_start=utcnow() - timedelta(hours=1)))
    outbox = mail._test_outbox
    before = len(outbox)
    sent = await client.post("/user/email/current/request", headers=headers(user["token"]), json={"email": address})
    assert sent.json() == SUCCESS
    proof = await client.post("/user/email/current/verify", headers=headers(user["token"]), json={"email": address, "code": email_code(outbox[-1])})
    assert proof.json()["code"] == 1
    # 原目标邮箱用例只观察第二步邮件，第一步邮件由独立安全测试完整覆盖。
    del outbox[before:]
    return proof.json()["data"]["verificationToken"]


async def request_binding(client, user, *, email=BIND_EMAIL):
    try:
        EmailRequest(email=email)
    except ValidationError:
        return await client.post("/user/email/request", headers=headers(user["token"]), json={"email": email})
    if "_email_grant" not in user:
        user["_email_grant"] = await prepare_binding_grant(client, user)
    return await client.post("/user/email/request", headers=headers(user["token"]), json={"email": email, "verificationToken": user["_email_grant"]})


async def verify_binding(client, user, code, *, email=BIND_EMAIL):
    data = {"email": email, "code": code}
    if user.get("_email_grant"):
        data["verificationToken"] = user["_email_grant"]
    response = await client.post("/user/email/verify", headers=headers(user["token"]), json=data)
    if response.json()["code"] == 1:
        user.pop("_email_grant", None)
    return response


async def verified_user(client, query, mail_outbox):
    user = await logged_in(client)
    assert user["email"] == EMAIL and user["email_verified"] is True
    # 注册、换绑和找回共用每邮箱的冷却，独立场景从冷却结束后开始。
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    mail_outbox.clear()
    return user


async def request_reset(client, mail_outbox, *, email=EMAIL):
    before = len(mail_outbox)
    result = await client.post("/login/password/forgot", json={"email": email})
    assert result.status_code == 200 and result.json() == SUCCESS
    assert len(mail_outbox) == before + 1
    return email_code(mail_outbox[-1])


async def reset_password(client, code, *, email=EMAIL, password="new-password-123"):
    return await client.post("/login/password/reset", json={"email": email, "code": code, "password": password})


async def request_change_code(client, user, mail_outbox, *, email=EMAIL):
    before = len(mail_outbox)
    response = await client.post("/user/password/request", headers=headers(user["token"]), json={"email": email})
    assert response.status_code == 200 and response.json() == SUCCESS
    assert len(mail_outbox) == before + 1
    return email_code(mail_outbox[-1])


async def change_password(client, user, code, *, email=EMAIL, password="new-password-123"):
    return await client.put("/user/password", headers=headers(user["token"]), json={"email": email, "code": code, "password": password})


async def send_code_for_purpose(client, user, mail_outbox, purpose):
    if purpose == "bind":
        assert (await request_binding(client, user)).json() == SUCCESS
        return email_code(mail_outbox[-1])
    if purpose == "reset":
        return await request_reset(client, mail_outbox)
    return await request_change_code(client, user, mail_outbox)


async def consume_code_for_purpose(client, user, code, purpose):
    if purpose == "bind":
        return await verify_binding(client, user, code)
    if purpose == "reset":
        return await reset_password(client, code)
    return await change_password(client, user, code)


async def test_binding_requires_login_and_valid_email_but_no_password(client, query, mail_outbox):
    user = await logged_in(client)
    assert (await client.post("/user/email/request", json={"email": BIND_EMAIL})).status_code == 401
    assert (await client.post("/user/email/verify", json={"email": BIND_EMAIL, "code": "123456"})).status_code == 401
    assert (await request_binding(client, user, email="not-an-email")).status_code == 422
    assert mail_outbox == [] and (await query("SELECT hash_key FROM auth_email_codes")) == []
    assert (await request_binding(client, user)).json() == SUCCESS
    assert (await query("SELECT login_failures FROM users"))[0]["login_failures"] == 0
    schema = (await client.get("/openapi.json")).json()
    assert "/login/email/verify" not in schema["paths"]
    assert "post" not in schema["paths"]["/user"]


async def test_binding_confirms_canonical_email_once_and_stores_only_keyed_hash(client, query, mail_outbox):
    user = await logged_in(client)
    assert (await request_binding(client, user, email=" Updated@Example.Test ")).json() == SUCCESS
    profile = (await client.get("/user", headers=headers(user["token"]))).json()["data"]
    assert profile["email"] == EMAIL and profile["email_verified"] is True
    message = mail_outbox[-1]
    assert message["recipient"] == BIND_EMAIL
    code = email_code(message)
    stored = (await query("SELECT * FROM auth_email_codes WHERE purpose = 'bind'"))[0]
    assert stored["purpose"] == "bind" and stored["email"] == BIND_EMAIL and stored["user_id"] == user["id"]
    assert len(stored["code_hash"]) == 64 and stored["code_hash"] != hash_secret(code)
    assert code not in str(stored)
    assert stored["expires_at"] - stored["created_at"] == timedelta(seconds=60)
    result = (await verify_binding(client, user, code)).json()
    assert result["code"] == 1 and result["msg"] is None
    assert result["data"]["email"] == BIND_EMAIL and result["data"]["email_verified"] is True
    assert "username" not in result["data"]
    saved = (await query("SELECT email, email_verified_at FROM users"))[0]
    assert saved["email"] == BIND_EMAIL and saved["email_verified_at"] is not None
    assert (await verify_binding(client, user, code)).json()["code"] == 0


async def test_binding_changes_login_email_and_revokes_only_other_sessions(client, query, mail_outbox):
    user = await logged_in(client)
    other_token = (await login(client)).json()["data"]["token"]
    assert (await request_binding(client, user)).json() == SUCCESS
    assert (await verify_binding(client, user, email_code(mail_outbox[-1]))).json()["code"] == 1
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 200
    assert (await client.get("/user", headers=headers(other_token))).status_code == 401
    assert (await login(client)).json()["code"] == 0
    assert (await login(client, username=BIND_EMAIL)).json()["code"] == 1


async def test_binding_grant_is_session_bound_and_another_session_must_verify_ownership(client, mail_outbox):
    user = await logged_in(client)
    other_token = (await login(client)).json()["data"]["token"]
    assert (await request_binding(client, user)).json() == SUCCESS
    other = {**user, "token": other_token}
    code = email_code(mail_outbox[-1])
    refused = await verify_binding(client, other, code)
    assert refused.status_code == 428
    other["_email_grant"] = await prepare_binding_grant(client, other)
    assert (await verify_binding(client, other, code)).json()["code"] == 1
    assert (await client.get("/user", headers=headers(other_token))).status_code == 200
    assert (await client.get("/user", headers=headers(user["token"]))).status_code == 401


async def test_codes_are_isolated_by_purpose_user_and_email(client, query, mail_outbox):
    alice = await logged_in(client)
    assert (await request_binding(client, alice)).json() == SUCCESS
    code = email_code(mail_outbox[-1])
    assert (await register(client, username="bob")).json()["code"] == 1
    bob = (await login(client, username="bob")).json()["data"]
    assert (await verify_binding(client, bob, code)).json()["code"] == 0
    assert (await verify_binding(client, alice, code, email="different@example.test")).json()["code"] == 0
    assert (await reset_password(client, code, email=BIND_EMAIL)).json()["code"] == 0
    assert (await client.post("/register", json={"email": BIND_EMAIL, "code": code, "password": PASSWORD})).json()["code"] == 0
    assert (await verify_binding(client, alice, code)).json()["code"] == 1
    assert (await query("SELECT email FROM users WHERE id = %s", (bob["id"],)))[0]["email"] == account_email("bob")


async def test_forgot_does_not_disclose_unknown_unverified_or_disabled_addresses(client, query, mail_outbox):
    await logged_in(client)
    await query("UPDATE users SET email_verified_at = NULL")
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    responses = [await client.post("/login/password/forgot", json={"email": address}) for address in ("missing@example.test", EMAIL)]
    await query("UPDATE users SET email = 'disabled@example.test', email_verified_at = UTC_TIMESTAMP(), is_active = FALSE")
    responses.append(await client.post("/login/password/forgot", json={"email": "disabled@example.test"}))
    assert all(response.status_code == 200 and response.json() == SUCCESS for response in responses)
    assert mail_outbox == [] and (await query("SELECT hash_key FROM auth_email_codes")) == []


async def test_reset_preserves_password_spaces_and_revokes_all_sessions(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    other_token = (await login(client)).json()["data"]["token"]
    code = await request_reset(client, mail_outbox, email=" ALICE@EXAMPLE.TEST ")
    stored = (await query("SELECT code_hash FROM auth_email_codes WHERE purpose = 'reset'"))[0]
    assert stored["code_hash"] != hash_secret(code) and stored["code_hash"] != code
    await query("UPDATE users SET login_failures = 4, locked_until = UTC_TIMESTAMP() + INTERVAL 5 MINUTE")
    password = " new-password-123 "
    response = await reset_password(client, code, password=password)
    assert response.status_code == 200 and response.json() == SUCCESS
    saved = (await query("SELECT password_hash, login_failures, locked_until FROM users"))[0]
    assert verify_password(password, saved["password_hash"]) and not verify_password(password.strip(), saved["password_hash"])
    assert saved["login_failures"] == 0 and saved["locked_until"] is None
    assert (await query("SELECT token_hash FROM auth_sessions")) == []
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []
    for token in (user["token"], other_token):
        assert (await client.get("/user", headers=headers(token))).status_code == 401
    assert (await login(client, password=PASSWORD)).json()["code"] == 0
    assert (await login(client, password=password)).json()["code"] == 1
    assert (await reset_password(client, code)).json()["code"] == 0


@pytest.mark.parametrize("purpose", ["bind", "reset", "change_password"])
@pytest.mark.parametrize("age, expected", [(59, 1), (60, 0)])
async def test_code_validity_ends_at_exactly_one_minute(client, query, mail_outbox, monkeypatch, purpose, age, expected):
    now = utcnow().replace(microsecond=0)
    monkeypatch.setattr("service.email.utcnow", lambda: now)
    user = await verified_user(client, query, mail_outbox)
    code = await send_code_for_purpose(client, user, mail_outbox, purpose)
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=age))
    response = await consume_code_for_purpose(client, user, code, purpose)
    assert response.json()["code"] == expected


@pytest.mark.parametrize("purpose", ["bind", "reset", "change_password"])
async def test_resend_is_blocked_for_59_seconds_then_replaces_old_code(client, query, mail_outbox, monkeypatch, purpose):
    now = utcnow().replace(microsecond=0)
    monkeypatch.setattr("service.email.utcnow", lambda: now)
    user = await verified_user(client, query, mail_outbox)
    first = await send_code_for_purpose(client, user, mail_outbox, purpose)
    path = {"bind": "/user/email/request", "reset": "/login/password/forgot", "change_password": "/user/password/request"}[purpose]
    data = {"email": BIND_EMAIL if purpose == "bind" else EMAIL}
    if purpose == "bind":
        data["verificationToken"] = user["_email_grant"]
    auth = {} if purpose == "reset" else headers(user["token"])
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=59))
    assert (await client.post(path, headers=auth, json=data)).status_code == 429
    assert len(mail_outbox) == 1
    monkeypatch.setattr("service.email.utcnow", lambda: now + timedelta(seconds=60))
    assert (await client.post(path, headers=auth, json=data)).json() == SUCCESS
    assert len(mail_outbox) == 2
    second = email_code(mail_outbox[-1])
    assert first != second
    assert (await consume_code_for_purpose(client, user, first, purpose)).json()["code"] == 0
    assert (await consume_code_for_purpose(client, user, second, purpose)).json()["code"] == 1


@pytest.mark.parametrize("purpose", ["bind", "reset", "change_password"])
@pytest.mark.parametrize("bad_attempts, expected", [(4, 1), (5, 0)])
async def test_email_code_allows_at_most_five_wrong_attempts(client, query, mail_outbox, purpose, bad_attempts, expected):
    user = await verified_user(client, query, mail_outbox)
    code = await send_code_for_purpose(client, user, mail_outbox, purpose)
    wrong = code[:-1] + str((int(code[-1]) + 1) % 10)
    for _ in range(bad_attempts):
        assert (await consume_code_for_purpose(client, user, wrong, purpose)).json()["code"] == 0
    assert (await consume_code_for_purpose(client, user, code, purpose)).json()["code"] == expected


@pytest.mark.parametrize("change", ["password", "email"])
async def test_account_changes_invalidate_pending_codes(client, query, mail_outbox, change):
    user = await verified_user(client, query, mail_outbox)
    code = await request_reset(client, mail_outbox)
    if change == "password":
        await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
        change_code = await request_change_code(client, user, mail_outbox)
        assert (await change_password(client, user, change_code, password="different-password-123")).json() == SUCCESS
    else:
        assert (await request_binding(client, user)).json() == SUCCESS
        assert (await verify_binding(client, user, email_code(mail_outbox[-1]))).json()["code"] == 1
    assert (await query("SELECT hash_key FROM auth_email_codes")) == []
    assert (await reset_password(client, code)).json()["code"] == 0


async def test_plain_profile_update_cannot_replace_or_clear_login_email(client, query):
    user = await logged_in(client)
    for email in ("changed@example.test", "", None):
        result = await client.put("/user", headers=headers(user["token"]), json={"email": email})
        assert result.status_code == 422
    row = (await query("SELECT email, email_verified_at FROM users"))[0]
    assert row["email"] == EMAIL and row["email_verified_at"] is not None


async def test_email_change_back_does_not_revive_old_binding_code(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    assert (await request_binding(client, user)).json() == SUCCESS
    old_code = email_code(mail_outbox[-1])
    for address in ("another@example.test", EMAIL):
        await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
        assert (await request_binding(client, user, email=address)).json() == SUCCESS
        assert (await verify_binding(client, user, email_code(mail_outbox[-1]), email=address)).json()["code"] == 1
    assert (await verify_binding(client, user, old_code)).json()["code"] == 0


async def test_reset_code_can_only_be_consumed_once_under_concurrency(client, app, query, mail_outbox):
    await verified_user(client, query, mail_outbox)
    code = await request_reset(client, mail_outbox)

    async def consume():
        async with browser_client(app) as browser:
            return (await reset_password(browser, code)).json()["code"]

    assert sorted(await asyncio.gather(consume(), consume())) == [0, 1]


async def test_parallel_send_requests_share_server_cooldown(client, app, query, mail_outbox):
    await verified_user(client, query, mail_outbox)

    async def send():
        async with browser_client(app) as browser:
            return await browser.post("/login/password/forgot", json={"email": EMAIL})

    responses = await asyncio.gather(send(), send())
    assert sorted(response.status_code for response in responses) == [200, 429]
    assert len(mail_outbox) == 1


async def test_concurrent_binding_cannot_assign_one_email_to_two_users(client, app, query, mail_outbox):
    alice = await logged_in(client)
    assert (await register(client, username="bob")).json()["code"] == 1
    bob = (await login(client, username="bob")).json()["data"]
    assert (await request_binding(client, alice)).json() == SUCCESS
    first = email_code(mail_outbox[-1])
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    assert (await request_binding(client, bob)).json() == SUCCESS
    second = email_code(mail_outbox[-1])

    async def consume(user, code):
        async with browser_client(app) as browser:
            return (await verify_binding(browser, user, code)).json()["code"]

    assert sorted(await asyncio.gather(consume(alice, first), consume(bob, second))) == [0, 1]
    owners = await query("SELECT id FROM users WHERE email = %s", (BIND_EMAIL,))
    assert len(owners) == 1
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    loser = bob if owners[0]["id"] == alice["id"] else alice
    assert (await request_binding(client, loser)).json()["code"] == 0
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    code = await request_reset(client, mail_outbox, email=BIND_EMAIL)
    assert (await reset_password(client, code, email=BIND_EMAIL)).json() == SUCCESS
    saved = (await query("SELECT password_hash FROM users WHERE id = %s", (loser["id"],)))[0]
    assert verify_password(PASSWORD, saved["password_hash"])


async def test_ip_rate_limit_blocks_mail_flood(client, mail_outbox):
    responses = [await client.post("/login/password/forgot", json={"email": f"missing-{index}@example.test"}) for index in range(11)]
    assert all(response.json() == SUCCESS for response in responses[:10])
    assert responses[-1].status_code == 429 and responses[-1].json()["code"] == 0
    assert mail_outbox == []


async def test_concurrent_first_email_requests_do_not_deadlock(app, monkeypatch):
    original = EmailRepository.clean_old_limits
    ready = asyncio.Event()
    arrivals = 0

    async def synchronized_cleanup(self, now):
        nonlocal arrivals
        await original(self, now)
        arrivals += 1
        if arrivals == 2:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=5)

    monkeypatch.setattr(EmailRepository, "clean_old_limits", synchronized_cleanup)

    async def send(index):
        async with browser_client(app) as browser:
            return await browser.post("/login/password/forgot", json={"email": f"missing-{index}@example.test"})

    responses = await asyncio.gather(send(1), send(2))
    assert all(response.status_code == 200 and response.json() == SUCCESS for response in responses)


async def test_missing_smtp_keeps_health_available_and_email_request_unavailable(settings):
    async with app_client(replace(settings, smtp_password="")) as browser:
        assert (await browser.get("/health")).status_code == 200
        response = await browser.post("/login/password/forgot", json={"email": "missing@example.test"})
        assert response.status_code == 503 and response.json()["code"] == 0
        assert "smtp" not in response.text.lower()


@pytest.mark.parametrize("use_ssl", [True, False])
async def test_smtp_uses_verified_tls_timeout_authorization_and_expected_message(settings, monkeypatch, use_ssl):
    settings = replace(settings, smtp_use_ssl=use_ssl, smtp_port=465 if use_ssl else 587)
    events = []
    sent = []

    class FakeSMTP:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            events.append("closed")

        def ehlo(self):
            events.append("ehlo")

        def starttls(self, *, context):
            assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
            events.append("starttls")

        def login(self, username, password):
            assert username == settings.smtp_username and password == settings.smtp_password
            events.append("login")

        def send_message(self, message):
            sent.append(message)
            events.append("send")

    def connect(host, port, **kwargs):
        assert host == settings.smtp_host and port == settings.smtp_port and kwargs["timeout"] == 10
        if use_ssl:
            assert kwargs["context"].check_hostname and kwargs["context"].verify_mode == ssl.CERT_REQUIRED
        else:
            assert "context" not in kwargs
        return FakeSMTP()

    monkeypatch.setattr(mail.smtplib, "SMTP_SSL" if use_ssl else "SMTP", connect)
    mail._send_email(settings, EMAIL, "重置密码", "验证码：123456，1分钟内有效")
    assert events == (["login", "send", "closed"] if use_ssl else ["ehlo", "starttls", "ehlo", "login", "send", "closed"])
    assert str(sent[0]["From"]) == settings.mail_from and str(sent[0]["To"]) == EMAIL
    assert str(sent[0]["Subject"]) == "重置密码" and sent[0].get_content().strip() == "验证码：123456，1分钟内有效"


async def test_background_smtp_failure_logs_no_credentials_or_code(settings, monkeypatch, caplog):
    secret = "private-password-and-email-code-123456"

    def fail(*args):
        raise smtplib.SMTPAuthenticationError(535, secret.encode())

    monkeypatch.setattr(mail, "_send_email", fail)
    with caplog.at_level(logging.ERROR, logger="core.mail"):
        await send_email_with_real_transport(settings, EMAIL, "重置密码", secret)
    assert "SMTPAuthenticationError" in caplog.text
    assert secret not in caplog.text and settings.smtp_password not in caplog.text and EMAIL not in caplog.text

async def test_password_change_sends_only_to_current_verified_email(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    assert (await client.post('/user/password/request', json={'email': EMAIL})).status_code == 401
    assert (await client.put('/user/password', json={'email': EMAIL, 'code': '123456', 'password': 'new-password-123'})).status_code == 401
    for address in ('different@example.test', 'missing@example.test'):
        result = await client.post('/user/password/request', headers=headers(user['token']), json={'email': address})
        assert result.json()['code'] == 0
    assert mail_outbox == [] and (await query('SELECT hash_key FROM auth_email_codes')) == []
    code = await request_change_code(client, user, mail_outbox, email=' ALICE@EXAMPLE.TEST ')
    assert mail_outbox[-1]['recipient'] == EMAIL
    stored = (await query("SELECT * FROM auth_email_codes WHERE purpose = 'change_password'"))[0]
    assert stored['user_id'] == user['id'] and stored['email'] == EMAIL
    assert stored['code_hash'] != hash_secret(code) and code not in str(stored)
    assert stored['expires_at'] - stored['created_at'] == timedelta(seconds=60)
    assert (await change_password(client, user, code, email='other@example.test')).json()['code'] == 0
    assert verify_password(PASSWORD, (await query('SELECT password_hash FROM users'))[0]['password_hash'])
    assert (await change_password(client, user, code, email=' ALICE@EXAMPLE.TEST ')).json() == SUCCESS


async def test_email_password_change_preserves_spaces_and_revokes_all_sessions(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    second_token = (await login(client)).json()['data']['token']
    code = await request_change_code(client, user, mail_outbox)
    await query('UPDATE users SET login_failures = 4, locked_until = UTC_TIMESTAMP() + INTERVAL 5 MINUTE')
    password = ' new-password-123 '
    assert (await change_password(client, user, code, password=password)).json() == SUCCESS
    saved = (await query('SELECT password_hash, login_failures, locked_until FROM users'))[0]
    assert verify_password(password, saved['password_hash'])
    assert not verify_password(password.strip(), saved['password_hash'])
    assert saved['login_failures'] == 0 and saved['locked_until'] is None
    assert (await query('SELECT token_hash FROM auth_sessions')) == []
    assert (await query('SELECT hash_key FROM auth_email_codes')) == []
    for token in (user['token'], second_token):
        assert (await client.get('/user', headers=headers(token))).status_code == 401
    assert (await login(client, password=PASSWORD)).json()['code'] == 0
    current = (await login(client, password=password)).json()['data']
    assert (await change_password(client, current, code, password='another-password-123')).json()['code'] == 0


@pytest.mark.parametrize('state', ['unverified', 'disabled', 'revoked'])
async def test_password_change_rechecks_account_and_login_state(client, query, mail_outbox, state):
    user = await verified_user(client, query, mail_outbox)
    code = await request_change_code(client, user, mail_outbox)
    original = (await query('SELECT password_hash FROM users'))[0]['password_hash']
    if state == 'unverified':
        await query('UPDATE users SET email_verified_at = NULL')
    elif state == 'disabled':
        await query('UPDATE users SET is_active = FALSE')
    else:
        assert (await client.post('/login/logout', headers=headers(user['token']))).json() == SUCCESS
    request = await client.post('/user/password/request', headers=headers(user['token']), json={'email': EMAIL})
    response = await change_password(client, user, code)
    if state == 'unverified':
        assert request.json()['code'] == response.json()['code'] == 0
    else:
        assert request.status_code == response.status_code == 401
    assert len(mail_outbox) == 1
    assert (await query('SELECT password_hash FROM users'))[0]['password_hash'] == original


async def test_password_change_cannot_use_forgot_or_binding_codes(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    reset_code = await request_reset(client, mail_outbox)
    assert (await change_password(client, user, reset_code)).json()['code'] == 0
    assert (await request_binding(client, user)).json() == SUCCESS
    bind_code = email_code(mail_outbox[-1])
    assert (await change_password(client, user, bind_code)).json()['code'] == 0
    await query('UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR')
    change_code = await request_change_code(client, user, mail_outbox)
    assert (await reset_password(client, change_code)).json()['code'] == 0
    assert (await verify_binding(client, user, change_code, email=EMAIL)).json()['code'] == 0
    assert (await change_password(client, user, change_code)).json() == SUCCESS
    assert (await reset_password(client, reset_code)).json()['code'] == 0


async def test_password_change_code_is_scoped_to_its_account_and_not_registration(client, query, mail_outbox):
    from test_auth import registration_code

    alice = await verified_user(client, query, mail_outbox)
    alice_code = await request_change_code(client, alice, mail_outbox)
    assert (await register(client, username='bob')).json()['code'] == 1
    bob = (await login(client, username='bob')).json()['data']
    for address in (EMAIL, account_email('bob')):
        assert (await change_password(client, bob, alice_code, email=address)).json()['code'] == 0
    request = await client.post('/user/password/request', headers=headers(bob['token']), json={'email': EMAIL})
    assert request.json()['code'] == 0
    _, register_code = await registration_code(client, 'future@example.test')
    assert (await change_password(client, alice, register_code)).json()['code'] == 0
    assert (await change_password(client, alice, alice_code)).json() == SUCCESS
    stored = (await query('SELECT password_hash FROM users WHERE id = %s', (bob['id'],)))[0]
    assert verify_password(PASSWORD, stored['password_hash'])
    assert (await client.get('/user', headers=headers(bob['token']))).status_code == 200


async def test_email_change_invalidates_pending_password_change_code_even_when_changed_back(client, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    old_code = await request_change_code(client, user, mail_outbox)
    for address in (BIND_EMAIL, EMAIL):
        await query('UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR')
        assert (await request_binding(client, user, email=address)).json() == SUCCESS
        assert (await verify_binding(client, user, email_code(mail_outbox[-1]), email=address)).json()['code'] == 1
    assert (await query('SELECT hash_key FROM auth_email_codes')) == []
    assert (await change_password(client, user, old_code)).json()['code'] == 0
    assert verify_password(PASSWORD, (await query('SELECT password_hash FROM users'))[0]['password_hash'])


async def test_password_change_consumption_is_atomic_under_concurrency(client, app, query, mail_outbox):
    user = await verified_user(client, query, mail_outbox)
    code = await request_change_code(client, user, mail_outbox)

    async def consume():
        async with browser_client(app) as browser:
            return (await change_password(browser, user, code)).json()['code']

    assert sorted(await asyncio.gather(consume(), consume())) == [0, 1]
    assert (await query('SELECT hash_key FROM auth_email_codes')) == []
    assert (await query('SELECT token_hash FROM auth_sessions')) == []
    assert verify_password('new-password-123', (await query('SELECT password_hash FROM users'))[0]['password_hash'])

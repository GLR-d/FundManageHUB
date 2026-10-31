"""验证 JWT 攻击场景、全局拦截、请求身份和前端兼容性。"""

import asyncio

import jwt
import pytest
from fastapi import Request
from sqlalchemy.exc import OperationalError

from utils.jwt_tokens import decode_access_token
from utils.security import hash_secret
from test_auth import logged_in, login, register


async def test_bearer_and_legacy_header_both_work(client):
    user = await logged_in(client)
    token = user["token"]
    for headers in (
        {"token": token}, {"Authorization": f"Bearer {token}"},
        {"token": token, "Authorization": f"bearer {token}"},
    ):
        response = await client.get("/user", headers=headers)
        assert response.status_code == 200
        assert response.json()["data"]["id"] == user["id"]


@pytest.mark.parametrize("kind", [
    "expired", "future_nbf", "future_iat", "wrong_issuer", "wrong_audience",
    "missing_sub", "missing_jti", "missing_iat", "missing_nbf", "missing_exp",
    "missing_iss", "missing_aud", "other_user", "numeric_sub", "negative_sub",
    "empty_jti", "string_exp", "wrong_key", "wrong_algorithm", "unsigned",
])
async def test_invalid_jwt_rejected_even_when_database_session_exists(client, settings, query, kind):
    user = await logged_in(client)
    claims = decode_access_token(user["token"], settings)
    algorithm, key = "HS256", settings.jwt_secret_key
    if kind == "expired":
        claims["exp"] = claims["iat"] - 1
    elif kind == "future_nbf":
        claims["nbf"] += 3600
    elif kind == "future_iat":
        claims["iat"] += 3600
    elif kind == "wrong_issuer":
        claims["iss"] = "other-service"
    elif kind == "wrong_audience":
        claims["aud"] = "other-api"
    elif kind.startswith("missing_"):
        del claims[kind.removeprefix("missing_")]
    elif kind == "other_user":
        claims["sub"] = str(user["id"] + 1)
    elif kind == "numeric_sub":
        claims["sub"] = user["id"]
    elif kind == "negative_sub":
        claims["sub"] = "-1"
    elif kind == "empty_jti":
        claims["jti"] = ""
    elif kind == "string_exp":
        claims["exp"] = str(claims["exp"])
    elif kind == "wrong_key":
        key = "another-unrelated-signing-secret-1234567890"
    elif kind == "wrong_algorithm":
        algorithm = "HS384"
    elif kind == "unsigned":
        algorithm, key = "none", None
    token = jwt.encode(claims, key, algorithm=algorithm)
    await query("UPDATE auth_sessions SET token_hash = %s", (hash_secret(token),))
    response = await client.get("/user", headers={"token": token})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json() == {"code": 0, "msg": "登录已过期，请重新登录", "data": None}
    assert token not in response.text


async def test_tampering_with_payload_without_resigning_is_rejected(client, query):
    token = (await logged_in(client))["token"]
    header, _, signature = token.split(".")
    other_token = (await login(client)).json()["data"]["token"]
    token = f"{header}.{other_token.split('.')[1]}.{signature}"
    await query("UPDATE auth_sessions SET token_hash = %s WHERE token_hash = %s", (hash_secret(token), hash_secret(other_token)))
    assert (await client.get("/user", headers={"token": token})).status_code == 401


async def test_each_login_has_unique_jwt(client, settings):
    first = (await logged_in(client))["token"]
    second = (await login(client)).json()["data"]["token"]
    assert decode_access_token(first, settings)["jti"] != decode_access_token(second, settings)["jti"]
    assert (await client.get("/user", headers={"token": first})).status_code == 200
    assert (await client.get("/user", headers={"token": second})).status_code == 200


@pytest.mark.parametrize("kind", ["basic", "empty_bearer", "conflict", "duplicate", "too_long", "opaque"])
async def test_invalid_or_ambiguous_headers_rejected(client, kind):
    token = (await logged_in(client))["token"]
    request_headers = {
        "basic": {"Authorization": "Basic secret"},
        "empty_bearer": {"Authorization": "Bearer"},
        "conflict": {"token": token, "Authorization": "Bearer another-token"},
        "duplicate": [("token", token), ("token", token)],
        "too_long": {"token": "x" * 4097},
        "opaque": {"token": "old-random-token-is-no-longer-accepted"},
    }[kind]
    assert (await client.get("/user", headers=request_headers)).status_code == 401


async def test_public_routes_allow_stale_token_and_trailing_slash(client):
    client.headers["token"] = "invalid-old-token"
    assert (await client.get("/health")).status_code == 200
    assert (await client.get("/docs")).status_code == 200
    assert (await client.get("/redoc")).status_code == 200
    assert (await client.get("/openapi.json")).status_code == 200
    assert (await register(client)).json()["code"] == 1
    assert (await login(client)).json()["code"] == 1
    assert (await client.get("/login/captcha/")).status_code == 200


@pytest.mark.parametrize("path", [
    "/login-admin", "/register-extra", "/uploads-private", "/uploads", "/uploads/old-receipt.png", "/user/",
])
async def test_similar_prefixes_and_protected_trailing_slash_cannot_bypass_auth(client, path):
    assert (await client.get(path)).status_code == 401


async def test_new_route_without_auth_dependency_is_protected_and_receives_identity(client, app):
    @app.get("/new-business-route")
    async def business(request: Request):
        return {"user_id": request.state.identity.user_id}

    assert (await client.get("/new-business-route")).status_code == 401
    user = await logged_in(client)
    response = await client.get("/new-business-route", headers={"token": user["token"]})
    assert response.json() == {"user_id": user["id"]}
    assert (await client.post("/fund", json={})).status_code == 401


async def test_preflight_does_not_require_login(client):
    # 中间件放行 OPTIONS；当前项目未添加 CORS，路由层返回正常的 405。
    assert (await client.options("/user")).status_code == 405


async def test_middleware_database_failure_keeps_result_and_hides_details(client, monkeypatch):
    token = (await logged_in(client))["token"]

    def unavailable(*args, **kwargs):
        raise OperationalError(None, None, RuntimeError("private database connection details"))

    monkeypatch.setattr("config.database.async_session", unavailable)
    response = await client.get("/user", headers={"token": token})
    assert response.status_code == 503
    assert response.json() == {"code": 0, "msg": "数据库暂时不可用，请稍后重试", "data": None}
    assert "private" not in response.text


async def test_concurrent_requests_keep_separate_identities(client):
    alice = await logged_in(client)
    assert (await register(client, username="bob")).json()["code"] == 1
    bob = (await login(client, username="bob")).json()["data"]

    async def profile(user):
        return (await client.get("/user", headers={"token": user["token"]})).json()["data"]["id"]

    users = [alice, bob] * 3
    assert await asyncio.gather(*(profile(user) for user in users)) == [user["id"] for user in users]


async def test_openapi_exposes_both_auth_schemes_and_public_routes(client):
    schema = (await client.get("/openapi.json")).json()
    assert schema["components"]["securitySchemes"]["HTTPBearer"]["bearerFormat"] == "JWT"
    for path, method in (("/user", "put"), ("/fund", "post"), ("/upload", "post"), ("/upload/refresh", "post"), ("/dashboard/statistics", "get"), ("/user/email/request", "post"), ("/user/email/verify", "post"), ("/user/password/request", "post"), ("/user/password/verify", "post"), ("/user/email/current/request", "post"), ("/user/email/current/verify", "post"), ("/user/password", "put"), ("/login/logout", "post"), ("/chat/conversations", "get"), ("/chat/conversations", "post"), ("/chat/conversations/import", "post"), ("/chat/conversations/{conversation_id}", "get"), ("/chat/conversations/{conversation_id}", "patch"), ("/chat/conversations/{conversation_id}", "delete")):
        assert schema["paths"][path][method]["security"] == [{"HTTPBearer": []}, {"APIKeyHeader": []}]
    for path, method in (("/login", "post"), ("/register", "post"), ("/register/email/request", "post"), ("/health", "get"), ("/login/password/forgot", "post"), ("/login/password/reset", "post")):
        assert schema["paths"][path][method]["security"] == []

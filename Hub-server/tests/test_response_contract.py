"""验证统一响应在真实接口、异常与文档中的表现。"""

import re
from urllib.parse import urlsplit

import pytest
from fastapi import HTTPException
from client_helpers import app_client
from sqlalchemy.exc import OperationalError

from main import create_app
from test_auth import account_email, logged_in, register
from test_fund import image_bytes, payload


def without_temporary_image_signature(record):
    """仅忽略测试 OSS 图片会刷新的签名，其他账单字段仍完整比较。"""
    image = urlsplit(record["photo"])
    assert image.scheme == "https" and image.hostname == "images.example.test"
    assert re.fullmatch(r"/images/[0-9]+/[0-9a-f]{32}\.(?:jpg|png)", image.path)
    assert re.fullmatch(r"test-signature=[0-9]+", image.query)
    return {**record, "photo": image._replace(query="").geturl()}


async def test_all_implemented_endpoints_return_null_success_message_and_keep_payloads(client, query, mail_outbox):
    responses = []
    registration = await register(client)
    responses.append(registration)
    captcha = await client.get("/login/captcha")
    responses.append(captcha)
    responses.append((await client.post(
        "/login/verify", json={"uuid": captcha.json()["data"]["uuid"], "code": "ABCDE"},
    )))
    login = await client.post(
        "/login", json={"email": account_email(), "password": "test-password-123", "captcha": "ABCDE"},
    )
    responses.append(login)
    headers = {"token": login.json()["data"]["token"]}
    responses.append((await client.get("/user", headers=headers)))
    responses.append(await client.get("/user/monthly-limit", headers=headers))
    responses.append(await client.put("/user/monthly-limit", headers=headers, json={"amount": "2000"}))
    updated = await client.put("/user", headers=headers, json={"name": "新昵称"})
    responses.append(updated)

    upload = await client.post(
        "/upload", headers=headers, files={"file": ("receipt.png", image_bytes(), "image/png")},
    )
    responses.append(upload)
    created = await client.post("/fund", headers=headers, json=payload(photo=upload.json()["data"]))
    responses.append(created)
    fund = created.json()["data"]
    listed = await client.get("/fund", headers=headers)
    responses.append(listed)
    detail = await client.get(f"/fund/{fund['id']}", headers=headers)
    responses.append(detail)
    updated_fund = await client.put("/fund", headers=headers, json={**fund, "amount": "0.31"})
    responses.append(updated_fund)
    searched = await client.get(
        "/fund/search", headers=headers, params={"searchType": 3, "searchValue": "午餐"},
    )
    responses.append(searched)
    statistics = await client.get("/dashboard/statistics", headers=headers, params={"month": "2026-10"})
    responses.append(statistics)
    deleted = await client.delete("/fund", headers=headers, params={"ids": str(fund["id"])})
    responses.append(deleted)
    await query("UPDATE auth_email_rate_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 1 HOUR")
    responses.append(await client.post("/user/password/request", headers=headers, json={"email": account_email()}))
    code = re.search(r"(?<!\d)\d{6}(?!\d)", mail_outbox[-1]["body"]).group()
    password_updated = await client.put("/user/password", headers=headers, json={"email": account_email(), "code": code, "password": "new-password-123"})
    responses.append(password_updated)
    responses.append((await client.get("/health")))

    for response in responses:
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"code", "msg", "data"}
        assert body["code"] == 1 and body["msg"] is None

    assert registration.json()["data"]["created_at"].endswith("Z")
    assert updated.json()["data"]["name"] == "新昵称"
    assert upload.json()["data"].startswith("https://images.example.test/images/")
    assert [without_temporary_image_signature(row) for row in listed.json()["data"]["items"]["2026-10-14"]] == [without_temporary_image_signature(fund)]
    assert without_temporary_image_signature(detail.json()["data"]) == without_temporary_image_signature(fund)
    assert updated_fund.json()["data"]["amount"] == "0.31"
    assert [without_temporary_image_signature(row) for row in searched.json()["data"]["items"]["2026-10-14"]] == [without_temporary_image_signature(updated_fund.json()["data"])]
    assert statistics.json()["data"]["expense"] == "0.31"
    assert statistics.json()["data"]["monthlyExpenses"][-1] == {"month": "2026-10", "amount": "0.31"}
    assert statistics.json()["data"]["categoryExpenses"] == [{"type": "1", "amount": "0.31"}]
    assert statistics.json()["data"]["dailyExpenses"][13] == {"date": "2026-10-14", "amount": "0.31"}
    assert deleted.json()["data"] is None
    assert password_updated.json()["data"] is None
    assert "password_hash" not in login.text
    assert "HttpOnly" in captcha.headers["set-cookie"]
    assert "Max-Age=0" in login.headers["set-cookie"]
    assert login.headers["cache-control"] == "no-store"


async def test_openapi_declares_result_for_all_implemented_endpoints(client):
    schema = (await client.get("/openapi.json")).json()
    assert not any(name.startswith("ApiResponse") for name in schema["components"]["schemas"])
    # SSE 与 CSV 下载声明各自的成功类型，普通 JSON 业务接口统一使用 Result。
    csv_paths = {"/fund/export", "/fund/import/template"}
    operations = [
        operation
        for path, methods in schema["paths"].items() if path not in csv_paths | {"/chat/stream"}
        for operation in methods.values()
    ]
    assert sum(len(methods) for methods in schema["paths"].values()) == 39
    assert len(operations) == 36
    for operation in operations:
        response_schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
        assert response_schema["$ref"].startswith("#/components/schemas/Result_")
        error_content = operation["responses"]["422"]["content"]
        assert set(error_content) == {"application/json"}
        error_schema = error_content["application/json"]["schema"]
        assert error_schema["$ref"].startswith("#/components/schemas/Result_")
        error_model = schema["components"]["schemas"][error_schema["$ref"].rsplit("/", 1)[1]]
        assert set(error_model["properties"]) == {"code", "msg", "data"}
        assert error_model["properties"]["data"]["type"] == "null"

    for path in csv_paths:
        operation = schema["paths"][path]["get"]
        content = operation["responses"]["200"]["content"]
        assert set(content) == {"text/csv"}
        assert content["text/csv"]["schema"] == {"type": "string", "format": "binary"}
        assert operation["security"] == [{"HTTPBearer": []}, {"APIKeyHeader": []}]
        error = operation["responses"]["422"]["content"]
        assert set(error) == {"application/json"}
        assert error["application/json"]["schema"]["$ref"].startswith("#/components/schemas/Result_")

    # 统一 JSON 错误声明不会改变聊天的 SSE 成功响应或中间件认证声明。
    stream = schema["paths"]["/chat/stream"]["post"]
    assert set(stream["responses"]["200"]["content"]) == {"text/event-stream"}
    assert schema["paths"]["/login"]["post"]["security"] == []
    assert schema["paths"]["/fund"]["get"]["security"] == [
        {"HTTPBearer": []}, {"APIKeyHeader": []},
    ]

    # 明确的账单响应模型应在文档中展示字段，同时保持原有字符串格式。
    record_properties = schema["components"]["schemas"]["FundRecord"]["properties"]
    assert set(record_properties) == {"id", "time", "type", "amount", "remark", "photo"}
    assert record_properties["id"]["type"] == "integer"
    for field in ("time", "type", "amount", "remark", "photo"):
        assert record_properties[field]["type"] == "string"


@pytest.mark.parametrize("method,path,payload,status", [
    ("GET", "/missing-route", None, 404),
    ("PUT", "/register", {}, 405),
    ("POST", "/register", {}, 422),
    ("GET", "/user", None, 401),
])
async def test_error_envelopes_preserve_http_status(client, method, path, payload, status):
    headers = {"token": (await logged_in(client))["token"]} if status == 404 else {}
    response = await client.request(method, path, json=payload, headers=headers)
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"code", "msg", "data"}
    assert body["code"] == 0 and body["data"] is None
    assert isinstance(body["msg"], str) and body["msg"]
    if status == 405:
        assert "POST" in response.headers["allow"]


async def test_database_failure_returns_result_without_internal_details(client, monkeypatch):
    def unavailable(*args, **kwargs):
        raise OperationalError(None, None, RuntimeError("private database connection details"))

    monkeypatch.setattr("config.database.async_session", unavailable)
    response = await client.get("/health")
    assert response.status_code == 503
    assert response.json() == {"code": 0, "msg": "数据库暂时不可用，请稍后重试", "data": None}
    assert "private" not in response.text


async def test_http_exception_keeps_headers(client, app):
    @app.get("/test-http-error")
    async def fail():
        raise HTTPException(status_code=403, detail="禁止访问", headers={"X-Error": "retained"})

    response = await client.get("/test-http-error", headers={"token": (await logged_in(client))["token"]})
    assert response.status_code == 403
    assert response.headers["x-error"] == "retained"
    assert response.json() == {"code": 0, "msg": "禁止访问", "data": None}


async def test_unexpected_error_returns_result_without_internal_details(settings):
    app = create_app(settings)

    @app.get("/test-unexpected-error")
    async def fail():
        raise RuntimeError("private internal details")

    async with app_client(app=app, raise_app_exceptions=False) as client:
        response = await client.get("/test-unexpected-error", headers={"token": (await logged_in(client))["token"]})
    assert response.status_code == 500
    assert response.json() == {"code": 0, "msg": "服务器内部错误，请稍后重试", "data": None}
    assert "private" not in response.text

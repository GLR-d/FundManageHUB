"""验证异步改造的实际作用：慢任务不阻塞请求，取消请求会归还连接。"""

import asyncio
from threading import Event

import pytest

from core import database
from core.database import DatabaseSession
from core.security import hash_password
from repository.register import RegisterRepository
from test_auth import PASSWORD, logged_in, register


async def test_password_hash_worker_does_not_block_other_requests(client, monkeypatch):
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()
    password_hash = hash_password(PASSWORD)

    def held_hash(password):
        loop.call_soon_threadsafe(started.set)
        # 超时仅用于防止失败时测试挂起；通过事件控制任务，不依赖睡眠猜时序。
        assert release.wait(timeout=5), "密码计算占用了事件循环"
        return password_hash

    monkeypatch.setattr("service.register.hash_password", held_hash)
    pending = asyncio.create_task(register(client))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert not pending.done()
        response = await asyncio.wait_for(client.get("/health"), timeout=2)
        assert response.json()["code"] == 1
        assert not pending.done(), "健康检查应在密码计算结束前完成"
    finally:
        release.set()
        registration = await asyncio.wait_for(pending, timeout=3)
    assert registration.json()["code"] == 1


async def test_cancelled_request_rolls_back_and_returns_connection(client, app, settings, query):
    user = await logged_in(client)
    inserted = asyncio.Event()
    waiting = asyncio.Event()

    @app.post("/test-cancelled-transaction")
    async def uncommitted_write(session: DatabaseSession):
        await RegisterRepository(session).create("cancelled@example.test", "取消请求", "unused-test-hash")
        inserted.set()
        await waiting.wait()
        await session.commit()

    pending = asyncio.create_task(client.post(
        "/test-cancelled-transaction", headers={"token": user["token"]},
    ))
    try:
        await asyncio.wait_for(inserted.wait(), timeout=3)
    finally:
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending

    assert await query("SELECT id FROM users WHERE email = %s", ("cancelled@example.test",)) == []
    assert database.engine.pool.checkedout() == 0
    assert (await client.get("/health")).json()["code"] == 1

async def test_email_password_change_hash_worker_does_not_block_other_requests(client, query, mail_outbox, monkeypatch):
    from test_email_recovery import change_password, request_change_code, verified_user

    user = await verified_user(client, query, mail_outbox)
    code = await request_change_code(client, user, mail_outbox)
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()
    password_hash = hash_password('new-password-123')

    def held_hash(password):
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5), '密码计算占用了事件循环'
        return password_hash

    monkeypatch.setattr('service.email.hash_password', held_hash)
    pending = asyncio.create_task(change_password(client, user, code))
    try:
        await asyncio.wait_for(started.wait(), timeout=2)
        assert not pending.done()
        response = await asyncio.wait_for(client.get('/health'), timeout=2)
        assert response.json()['code'] == 1
        assert not pending.done(), '健康检查应在密码计算结束前完成'
    finally:
        release.set()
        result = await asyncio.wait_for(pending, timeout=3)
    assert result.json() == {'code': 1, 'msg': None, 'data': None}

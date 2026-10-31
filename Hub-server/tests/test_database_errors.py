"""数据库故障在路由和认证中间件中使用相同的分类、日志与响应。"""

import logging

import pytest
from sqlalchemy.exc import DBAPIError, IntegrityError, OperationalError, ProgrammingError, SQLAlchemyError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from core.messages import Messages
from test_auth import logged_in


def statement_error(error_class, error_code, **kwargs):
    return error_class(
        "SELECT value FROM test WHERE credential = :credential",
        {"credential": "private-bound-value"},
        RuntimeError(error_code, "private database details"),
        hide_parameters=True,
        **kwargs,
    )


@pytest.mark.parametrize("path", ["/health", "/user"], ids=["router", "middleware"])
@pytest.mark.parametrize("make_error,status_code", [
    pytest.param(lambda: statement_error(OperationalError, 2003), 503, id="connection-failed"),
    pytest.param(lambda: statement_error(OperationalError, 1205), 503, id="lock-timeout"),
    pytest.param(lambda: statement_error(DBAPIError, 2013, connection_invalidated=True), 503, id="connection-invalidated"),
    pytest.param(lambda: PoolTimeoutError("private pool details"), 503, id="pool-timeout"),
    pytest.param(lambda: statement_error(OperationalError, 1054), 500, id="unknown-column"),
    pytest.param(lambda: statement_error(ProgrammingError, 1064), 500, id="invalid-query"),
    pytest.param(lambda: statement_error(IntegrityError, 1062), 500, id="unexpected-constraint"),
    pytest.param(lambda: SQLAlchemyError("private ORM details"), 500, id="unexpected-orm"),
])
async def test_database_errors_are_classified_logged_and_hidden(
    client, monkeypatch, caplog, path, make_error, status_code,
):
    headers = {"token": (await logged_in(client))["token"]} if path == "/user" else {}
    error = make_error()

    def fail_session(*args, **kwargs):
        raise error

    monkeypatch.setattr("config.database.async_session", fail_session)
    with caplog.at_level(logging.ERROR):
        response = await client.get(path, headers=headers)

    message = Messages.DATABASE_UNAVAILABLE if status_code == 503 else Messages.INTERNAL_SERVER_ERROR
    assert response.status_code == status_code
    assert response.json() == {"code": 0, "msg": message, "data": None}
    assert "private" not in response.text

    records = [record for record in caplog.records if record.exc_info and record.exc_info[1] is error]
    assert len(records) == 1
    assert records[0].exc_info[2] is not None
    assert "private-bound-value" not in caplog.text

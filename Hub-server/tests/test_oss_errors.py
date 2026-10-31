"""OSS 诊断仅保留错误码和追踪编号，不输出异常中的链接或凭据。"""

import alibabacloud_oss_v2 as oss
import pytest
from requests.exceptions import ProxyError

from core.exception_handlers import BusinessError
from utils.oss import describe_error
from service.upload import UploadService


def service_error(**overrides):
    fields = {
        "status_code": 403,
        "code": "InvalidAccessKeyId",
        "request_id": "0123456789ABCDEF01234567",
        "ec": "0002-00000902",
        "message": "private-message access-key-secret",
        "timestamp": "2026-10-22T00:00:00Z",
        "request_target": "PUT https://example.test/image?Signature=private-signature",
        "snapshot": b"private-response-body",
        "headers": {"Authorization": "private-authorization"},
        "error_fileds": {"AccessKeyId": "LTAI-private-key"},
    }
    fields.update(overrides)
    return oss.exceptions.ServiceError(**fields)


def wrapped(error):
    return oss.exceptions.OperationError(name="PutObject", error=error)


def assert_no_private_details(value):
    for private in (
        "private-message", "access-key-secret", "https://", "Signature",
        "private-signature", "private-response-body", "Authorization",
        "private-authorization", "LTAI-private-key", "password",
    ):
        assert private not in value


def test_operation_error_preserves_only_safe_service_diagnostics():
    summary = describe_error(wrapped(service_error()))
    assert summary == (
        "OperationError -> ServiceError (status=403, code=InvalidAccessKeyId, "
        "request_id=0123456789ABCDEF01234567, ec=0002-00000902)"
    )
    assert_no_private_details(summary)


def test_network_error_is_unwrapped_without_logging_proxy_credentials():
    error = wrapped(oss.exceptions.RequestError(error=ProxyError("https://username:password@example.test")))
    assert describe_error(error) == "OperationError -> RequestError -> ProxyError"
    assert_no_private_details(describe_error(error))


def test_plain_errors_do_not_format_their_message_or_args():
    class NoTextError(Exception):
        def __str__(self):
            raise AssertionError("Exception text must never be read")

        def __repr__(self):
            raise AssertionError("Exception repr must never be read")

    assert describe_error(NoTextError("password")) == "NoTextError"


def test_unwrap_cycle_and_very_deep_chains_are_bounded():
    error = wrapped(RuntimeError("password"))
    error._error = error
    assert describe_error(error) == "OperationError"
    error = RuntimeError("password")
    for _ in range(20):
        error = wrapped(error)
    assert describe_error(error).split(" -> ") == ["OperationError"] * 8


def test_standard_causes_are_followed_without_exposing_text():
    error = RuntimeError("password")
    error.__cause__ = service_error()
    assert describe_error(error).startswith("RuntimeError -> ServiceError (status=403, code=InvalidAccessKeyId")
    assert_no_private_details(describe_error(error))


@pytest.mark.parametrize("value", [
    "https://example.test/?Signature=private-signature", "bad\npassword", "bad\rpassword",
    "bad value", "bad=value", "bad,field", "x" * 129, "错误字段",
])
def test_untrusted_diagnostic_fields_are_rejected_whole(value):
    error = wrapped(service_error(status_code=value, code=value, request_id=value, ec=value))
    assert describe_error(error) == "OperationError -> ServiceError"


@pytest.mark.parametrize("status", [True, 0, 99, 600, "403"])
def test_invalid_http_status_values_are_not_logged(status):
    assert "status=" not in describe_error(service_error(status_code=status))


def test_broken_unwrap_uses_standard_cause_and_does_not_hide_the_original_failure():
    class BrokenOperation(oss.exceptions.OperationError):
        def unwrap(self):
            raise RuntimeError("password")

    error = BrokenOperation(name="PutObject", error=RuntimeError("password"))
    error.__cause__ = service_error()
    assert describe_error(error).startswith("BrokenOperation -> ServiceError (status=403")


def test_upload_logs_diagnostic_fields_but_returns_the_generic_business_error(settings, monkeypatch, caplog):
    monkeypatch.setattr("utils.oss.sign_image_url", lambda *args: "https://example.test/?Signature=private-signature")

    def unavailable(*args):
        raise wrapped(service_error())

    monkeypatch.setattr("utils.oss.put_image", unavailable)
    with pytest.raises(BusinessError) as captured:
        UploadService(None, settings, 1)._save_image("images/1/" + "a" * 32 + ".png", b"image", "image/png")
    assert captured.value.status_code == 502
    assert "code=InvalidAccessKeyId" in caplog.text
    assert "status=403" in caplog.text
    assert_no_private_details(caplog.text + str(captured.value))

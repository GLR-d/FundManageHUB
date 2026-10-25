"""旧对象盘点使用真实 SDK 请求模型与假 Client，验证分页且禁止真实网络。"""

from types import SimpleNamespace

import pytest

from core.oss import list_image_keys as sdk_list_image_keys


def page(keys=(), *, truncated=False, token=None, status=200):
    return SimpleNamespace(
        status_code=status,
        contents=None if keys is None else [SimpleNamespace(key=key) for key in keys],
        is_truncated=truncated,
        next_continuation_token=token,
    )


def inventory_sdk_double(monkeypatch, pages):
    captured = {"requests": [], "closed": False}
    remaining = iter(pages)

    class Transport:
        def __init__(self, **options):
            captured["transport_options"] = options

        def close(self):
            captured["closed"] = True

    class Client:
        def __init__(self, config):
            captured["config"] = config

        def list_objects_v2(self, request):
            captured["requests"].append(request)
            result = next(remaining)
            if isinstance(result, Exception):
                raise result
            return result

    monkeypatch.setattr("alibabacloud_oss_v2.Client", Client)
    monkeypatch.setattr("alibabacloud_oss_v2.transport.RequestsHttpClient", Transport)
    return captured


def test_inventory_paginates_with_sdk_models_and_filters_every_page(settings, monkeypatch):
    first_key = "images/1/" + "a" * 32 + ".png"
    last_key = "images/23/" + "b" * 32 + ".jpg"
    invalid = [
        None, "", "uploads/legacy.png", "/" + first_key,
        "images/0/" + "c" * 32 + ".png", "images/01/" + "c" * 32 + ".png",
        "images/1/" + "C" * 32 + ".png", "images/1/" + "c" * 32 + ".gif",
        "images/1/../private.png", first_key + "?signature=unexpected",
    ]
    captured = inventory_sdk_double(monkeypatch, [
        page([first_key, *invalid], truncated=True, token="opaque-page-2"),
        page(None, truncated=True, token="opaque-page-3"),
        page([last_key, "unrelated.png"]),
    ])
    assert sdk_list_image_keys(settings) == [first_key, last_key]
    requests = captured["requests"]
    assert len(requests) == 3
    assert [request.continuation_token for request in requests] == [None, "opaque-page-2", "opaque-page-3"]
    for request in requests:
        assert request.bucket == settings.oss_bucket
        assert request.prefix == "images/" and request.max_keys == 1000
    assert captured["config"].region == settings.oss_region
    assert captured["config"].endpoint == settings.oss_endpoint
    assert captured["config"].use_cname == settings.oss_use_cname
    assert captured["closed"]


@pytest.mark.parametrize("keys", [[], None])
def test_empty_inventory_is_a_success_and_closes_transport(settings, monkeypatch, keys):
    captured = inventory_sdk_double(monkeypatch, [page(keys)])
    assert sdk_list_image_keys(settings) == []
    assert len(captured["requests"]) == 1 and captured["closed"]


@pytest.mark.parametrize("failure", [RuntimeError("SDK inventory unavailable"), page(status=403), page(status=500)])
def test_inventory_failure_never_returns_partial_results_and_closes_transport(settings, monkeypatch, failure):
    captured = inventory_sdk_double(monkeypatch, [
        page(["images/1/" + "a" * 32 + ".png"], truncated=True, token="page-2"),
        failure,
    ])
    with pytest.raises(RuntimeError):
        sdk_list_image_keys(settings)
    assert len(captured["requests"]) == 2 and captured["closed"]


@pytest.mark.parametrize("pages", [
    [page([], truncated=True)],
    [page([], truncated=True, token="same"), page([], truncated=True, token="same")],
])
def test_inventory_rejects_missing_or_repeated_pagination_tokens(settings, monkeypatch, pages):
    captured = inventory_sdk_double(monkeypatch, pages)
    with pytest.raises(RuntimeError):
        sdk_list_image_keys(settings)
    assert len(captured["requests"]) == len(pages) and captured["closed"]

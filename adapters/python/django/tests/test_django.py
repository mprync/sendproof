import json

import pytest
from django.db import connection
from django.test import Client

from testbench_django import conf
from testbench_django.discovery import preview_operations
from django.urls import get_resolver

ROLLBACK = {"HTTP_PREFER": "tx=rollback"}


@pytest.fixture(autouse=True)
def clean():
    import urls_under_test as u

    u.SENT.clear()
    u.COMMITTED.clear()
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM items")
    yield


def rows():
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM items ORDER BY id")
        return [r[0] for r in cursor.fetchall()]


def client(**options):
    http = Client(**options)
    http.cookies["user"] = "alex"
    return http


def post(http, path, body=None, **headers):
    return http.post(path, data=json.dumps(body or {}), content_type="application/json", **headers)


def test_discovery_lists_marked_function_and_class_views():
    operations = preview_operations(get_resolver().url_patterns)
    assert ("POST", "/items") in operations and ("PATCH", "/items/{id}") in operations
    assert ("POST", "/things") in operations and ("GET", "/things") not in operations
    assert not any(path.endswith("/remove") for _, path in operations)


def test_preview_rolls_back_captures_changes_and_suppresses_effects():
    import urls_under_test as u

    response = post(client(), "/bench/_preview/items", {"id": "a", "name": "A"}, **ROLLBACK)
    body = response.json()
    assert response.status_code == 200 and body["status"] == 201 and body["rolledBack"] is True
    assert body["changes"] == [{"operation": "insert", "table": "items", "key": {"id": "a"}, "before": None,
                                "after": {"id": "a", "name": "A"}}]
    assert body["effects"][0]["description"] == "Created" and "delivered" not in body["effects"][0]
    assert u.SENT == [] and u.COMMITTED == [] and rows() == []  # on_commit hooks are discarded too
    assert "preference-applied" in {k.lower() for k in response.headers}
    post(client(), "/items", {"id": "a", "name": "A"})
    assert rows() == ["a"] and u.SENT == ["a"] and u.COMMITTED == ["a"]


def test_update_has_before_and_after_snapshots_and_rolls_back():
    post(client(), "/items", {"id": "u", "name": "Old"})
    response = client().patch("/bench/_preview/items/u", data=json.dumps({"name": "New"}),
                              content_type="application/json", **ROLLBACK)
    change = response.json()["changes"][0]
    assert change["operation"] == "update" and change["before"]["name"] == "Old" and change["after"]["name"] == "New"
    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM items WHERE id = 'u'")
        assert cursor.fetchone() == ("Old",)


def test_unhandled_exception_is_an_unconfirmed_500_and_rolls_back():
    response = post(client(raise_request_exception=False), "/bench/_preview/boom", **ROLLBACK)
    assert response.status_code == 500 and "rolledBack" not in response.content.decode()
    assert rows() == []


def test_denial_unmarked_and_unknown_targets_never_confirm():
    http = client()
    assert post(http, "/bench/_preview/denied", **ROLLBACK).status_code == 403
    assert post(http, "/bench/_preview/items/x/remove", **ROLLBACK).status_code == 409
    assert post(http, "/bench/_preview/missing", **ROLLBACK).status_code == 404
    assert http.get("/bench/_preview/things", **ROLLBACK).status_code == 409  # GET is not previewable


def test_drf_apiview_handler_previews():
    response = post(client(), "/bench/_preview/things", {"id": "d"}, **ROLLBACK)
    assert response.status_code == 200 and response.json()["status"] == 201
    assert response.json()["changes"][0]["after"]["name"] == "drf" and rows() == []


def test_observed_send_commits_and_trace_is_owner_scoped():
    http = client()
    sent = post(http, "/items", {"id": "t", "name": "T"}, HTTP_PREFER="trace")
    trace_id = sent.headers["X-TestBench-Trace"]
    assert rows() == ["t"]
    trace = http.get(f"/bench/_api/traces/{trace_id}")
    assert trace.status_code == 200 and trace.json()["effects"][0]["delivered"] is True
    assert trace.json()["changes"][0]["operation"] == "insert"
    assert Client().get(f"/bench/_api/traces/{trace_id}").status_code == 404


def test_disabled_environment_is_inert(monkeypatch):
    from django.conf import settings

    conf.reset()
    monkeypatch.setattr(settings, "TESTBENCH", {**settings.TESTBENCH, "ENVIRONMENT": "Production"})
    try:
        http = client()
        assert http.get("/bench/_api/capabilities").status_code == 404
        assert post(http, "/items", {"id": "p", "name": "P"}, **ROLLBACK).status_code == 201  # ordinary route
    finally:
        conf.reset()

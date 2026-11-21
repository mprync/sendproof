"""Security regressions for the Django adapter: preview dispatch, sessions and rollback."""

import json

import pytest
from django.db import connection
from django.test import Client, override_settings

from testbench_django.middleware import reset_chain

ROLLBACK = {"HTTP_PREFER": "tx=rollback"}
MIDDLEWARE = [
    "django.contrib.sessions.middleware.SessionMiddleware",
    "urls_under_test.AdminOnlyMiddleware",
    "testbench_django.middleware.TestBenchMiddleware",
]


@pytest.fixture(autouse=True)
def full_stack():
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM items")
    reset_chain()
    with override_settings(MIDDLEWARE=MIDDLEWARE, SESSION_ENGINE="django.contrib.sessions.backends.signed_cookies"):
        yield
    reset_chain()


def rows():
    with connection.cursor() as cursor:
        cursor.execute("SELECT id FROM items ORDER BY id")
        return [r[0] for r in cursor.fetchall()]


def post(http, path, **headers):
    return http.post(path, data=json.dumps({}), content_type="application/json", **headers)


def test_path_based_middleware_before_test_bench_guards_the_preview_target():
    http = Client()
    denied = post(http, "/bench/_preview/admin/items", **ROLLBACK)
    assert denied.status_code == 403 and "rolledBack" not in denied.content.decode()
    allowed = post(http, "/bench/_preview/admin/items", HTTP_X_ADMIN="yes", **ROLLBACK)
    assert allowed.status_code == 200 and allowed.json()["status"] == 201
    assert rows() == []


def test_preview_session_changes_are_not_saved_or_sent_as_a_cookie():
    http = Client()
    response = post(http, "/bench/_preview/sign-in", **ROLLBACK)
    assert response.status_code == 200 and response.json()["status"] == 200
    assert "sessionid" not in response.cookies
    assert "set-cookie" not in response.json()["headers"]


def test_raw_commit_in_a_preview_fails_closed():
    response = post(Client(raise_request_exception=False), "/bench/_preview/escape", **ROLLBACK)
    assert response.status_code == 500 and "rolledBack" not in response.content.decode()
    assert rows() == []


def test_database_session_rows_and_statements_never_expose_the_session():
    with override_settings(SESSION_ENGINE="django.contrib.sessions.backends.db"):
        response = post(Client(), "/bench/_preview/sign-in", **ROLLBACK)
    body = response.json()
    assert response.status_code == 200 and body["status"] == 200
    sessions = [change for change in body["changes"] if change["table"] == "django_session"]
    assert sessions, "the inner SessionMiddleware saves the new session inside the preview"
    for change in sessions:
        assert change["key"] == {"session_key": "[REDACTED]"}
        assert change["after"]["session_key"] == "[REDACTED]" and change["after"]["session_data"] == "[REDACTED]"
    statements = [entry["sql"] for entry in body["logs"] if entry.get("sql") and "django_session" in entry["sql"]["text"]]
    assert statements
    for sql in statements:
        assert all(p["value"] in ("[REDACTED]", None) for p in sql["parameters"]), sql
    from django.contrib.sessions.models import Session

    assert not Session.objects.exists()  # rolled back with the preview

import json

import pytest

from testbench_core import BenchOptions, Identity, limits, protocol
from testbench_core.capture import Capture
from testbench_core.jsonsafe import body_from_bytes
from testbench_core.scope import RequestScope, activate, current_scope, deactivate
from testbench_core.assets import UiAssets, UiBundleError
from testbench_core.trace_store import TraceStore
from testbench_core.workbench import Workbench, trace_owner
import testbench_core


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_environment_is_off_by_default(monkeypatch):
    monkeypatch.delenv("TESTBENCH_ENVIRONMENT", raising=False)
    assert BenchOptions().environment == "Production"
    assert not BenchOptions().enabled
    assert BenchOptions(environment="development").enabled
    monkeypatch.setenv("TESTBENCH_ENVIRONMENT", "Development")
    assert BenchOptions().enabled


@pytest.mark.parametrize("url", ["//evil", "http://x", "a/b", "/a/../b", "/a\\b", "/a#b", "/a b"])
def test_urls_must_be_local(url):
    with pytest.raises(ValueError):
        BenchOptions(openapi_url=url)


def test_preview_suppresses_effects_and_observed_send_marks_delivery():
    preview = Capture(rollback=True)
    assert preview.record_effect("email", "Created item", {"to": ["a"]}) is True
    assert preview.finish().effects == [{"kind": "email", "description": "Created item", "data": {"to": ["a"]}}]
    observed = Capture(rollback=False)
    assert observed.record_effect("email", "Created item") is False
    assert observed.finish().effects[0]["delivered"] is True


def test_capture_caps_effects_and_logs():
    capture = Capture(rollback=True)
    for number in range(limits.EFFECTS + 5):
        assert capture.record_effect("job", f"job {number}") is True
    for number in range(limits.LOGS + 5):
        capture.record_log("Information", f"line {number}")
    snapshot = capture.finish()
    assert len(snapshot.effects) == limits.EFFECTS and snapshot.effects_truncated
    assert len(snapshot.logs) == limits.LOGS and snapshot.logs_truncated


def test_unserializable_effect_data_is_dropped_but_still_suppressed():
    capture = Capture(rollback=True)
    cyclic: dict = {}
    cyclic["self"] = cyclic
    assert capture.record_effect("http", "call", cyclic) is True
    snapshot = capture.finish()
    assert snapshot.effects[0]["data"] is None and snapshot.effects_truncated


def test_sql_entries_use_the_sql_level_and_count_toward_db_time():
    capture = Capture(rollback=True)
    capture.record_sql("SELECT ?", [("p0", "1", "Int64")], rows_affected=1, duration_ms=2.5)
    timing = capture.timing()
    assert timing.query_count == 1 and timing.db == 2.5
    log = capture.finish().logs[0]
    assert log["level"] == "Sql" and log["sql"]["parameters"][0]["name"] == "p0" and log["sql"]["rowsAffected"] == 1
    assert 'desc="1 queries"' in timing.server_timing()


def test_scope_activation_is_restored():
    scope = RequestScope(Capture(rollback=True), "Development", True)
    token = activate(scope)
    assert current_scope() is scope
    deactivate(token)
    assert current_scope() is None


def test_prefer_header_rules():
    def headers(*values):
        return lambda name: list(values) if name == "prefer" else []

    assert protocol.has_exact_preference(headers("tx=rollback"))
    assert protocol.has_exact_preference(headers(" TX=ROLLBACK "))
    assert not protocol.has_exact_preference(headers('tx="rollback"'))
    assert not protocol.has_exact_preference(headers("trace, tx=rollback"))
    assert not protocol.has_exact_preference(headers("tx=rollback", "trace"))
    assert protocol.requests_rollback(headers('return=minimal; tx="rollback"'))
    assert protocol.requests_trace(headers("trace; foo=bar"))
    assert not protocol.requests_trace(headers("tx=rollback"))


def test_same_origin_rules():
    def get(**values):
        return lambda name: [values[name]] if name in values else []

    assert protocol.is_same_origin(get(), "http", "h:1")
    assert protocol.is_same_origin(get(origin="http://h:1"), "http", "h:1")
    assert not protocol.is_same_origin(get(origin="http://other"), "http", "h:1")
    assert not protocol.is_same_origin(get(**{"sec-fetch-site": "cross-site"}), "http", "h:1")
    assert not protocol.is_same_origin(get(origin="http://h:1/path"), "http", "h:1")


@pytest.mark.parametrize("target", ["", "//x", "/a/../b", "/a\\b", "/bench", "/bench/_api/capabilities", "/a%2F..%2Fb"])
def test_invalid_preview_targets(target):
    assert not protocol.is_valid_preview_target(target)


def test_unexecuted_status_mapping():
    assert protocol.classify_unexecuted(401)[0] == 401
    assert protocol.classify_unexecuted(302)[0] == 401
    assert protocol.classify_unexecuted(500)[0] == 409
    assert protocol.classify_unexecuted(503)[0] == 503
    assert protocol.classify_unexecuted(418)[0] == 418


def test_body_decoding():
    assert body_from_bytes("application/json", b'{"a":1}') == {"a": 1}
    assert body_from_bytes("application/problem+json", b"nope") == "nope"
    assert body_from_bytes("text/plain", "é".encode()) == "é"
    assert body_from_bytes("image/png", b"\x00\x01") == "AAE="
    assert body_from_bytes("application/json", b"") is None


def test_trace_store_isolation_limits_and_ttl():
    clock = Clock()
    store = TraceStore(ttl=5, clock=clock)
    alice, bob = ("session", "alice", ""), ("session", "bob", "")
    first = store.reserve(alice)
    store.complete(first, {"changes": []})
    assert store.read(first.id, alice) == {"changes": []}
    assert store.read(first.id, bob, timeout=0) is None
    assert store.read("not-a-guid", alice, timeout=0) is None
    clock.now = 5
    assert store.read(first.id, alice, timeout=0) is None  # expired

    reservations = [store.reserve(alice) for _ in range(9)]
    assert store.read(reservations[0].id, alice, timeout=0) is None  # evicted, 8 per owner
    assert store._entries.get(reservations[8].id) is not None
    for number in range(40):
        store.reserve(("session", f"user{number}", ""))
    assert len(store._entries) <= 32


def test_trace_read_waits_for_completion_but_not_forever():
    store = TraceStore()
    owner = ("session", "a", "")
    pending = store.reserve(owner)
    assert store.read(pending.id, owner, timeout=0.05) is None


def test_trace_owner_requires_a_subject():
    assert trace_owner(None, "") is None
    assert trace_owner(Identity("a", subject=None), "") is None
    assert trace_owner(Identity("a", subject="s", authentication_type="cookie"), "/t") == ("cookie", "", "s", "/t")


def test_trace_owner_separates_issuers_of_the_same_subject():
    first = trace_owner(Identity("a", subject="s", authentication_type="jwt", issuer="https://one"), "")
    second = trace_owner(Identity("a", subject="s", authentication_type="jwt", issuer="https://two"), "")
    assert first != second
    store = TraceStore()
    reservation = store.reserve(first)
    store.complete(reservation, {"changes": []})
    assert store.read(reservation.id, second, timeout=0) is None
    assert store.read(reservation.id, first, timeout=0) == {"changes": []}


def test_capabilities_document_shape():
    class Provider(testbench_core.PreviewProvider):
        database = "inventory"

        def begin(self, scope):
            raise NotImplementedError

    options = BenchOptions(environment="Development", auth_providers=[testbench_core.AuthProvider("P", "cookie", "/auth")])
    bench = Workbench(options, Provider())
    response = bench.capabilities("/tenant", Identity("Alex", "admin", "1"), [("POST", "/items"), ("HEAD", "/x")], "/openapi.json", "Inventory")
    document = json.loads(response.body)
    assert document["protocolVersion"] == 1 and document["openApiUrl"] == "/tenant/openapi.json"
    assert document["identity"] == {"name": "Alex", "role": "admin"}
    assert document["previewOperations"] == [{"method": "POST", "path": "/items"}] and document["observedSend"] is True
    assert document["authProviders"][0]["url"] == "/tenant/auth"
    assert dict(response.headers)["cache-control"] == "no-store"
    empty = Workbench(options, None).capabilities("", None, [("POST", "/items")], "/openapi.json", "x")
    assert json.loads(empty.body)["previewOperations"] == [] and json.loads(empty.body)["identity"] is None


def test_assets_serve_only_verified_manifest_files(tmp_path):
    (tmp_path / "index.html").write_bytes(b"<title>Test Bench</title>")
    digest = __import__("hashlib").sha256(b"<title>Test Bench</title>").hexdigest()
    (tmp_path / "manifest.json").write_text(json.dumps(
        {"version": "1", "bundleHash": "x", "files": {"index.html": {"sha256": digest, "bytes": 25, "contentType": "text/html"}}}))
    assets = UiAssets(tmp_path)
    assert assets.get("index.html").content_type == "text/html"
    assert assets.get("../manifest.json") is None and assets.get("other.js") is None
    (tmp_path / "index.html").write_bytes(b"tampered, same length...!")
    with pytest.raises(UiBundleError):
        UiAssets(tmp_path).get("index.html")
    with pytest.raises(UiBundleError):
        UiAssets(tmp_path / "missing").get("index.html")


# ------------------------------------------------------------------ security regressions
def test_change_snapshots_redact_secret_columns_and_a_secret_primary_key():
    from testbench_core.provider import PreviewChange

    change = PreviewChange(
        "update", "api_tokens", {"api_token": "tok-123"},
        {"api_token": "tok-123", "password_digest": "old-digest", "reset_token": None, "name": "A"},
        {"api_token": "tok-123", "password_digest": "new-digest", "reset_token": "r-1", "name": "B"},
    )
    payload, _ = Workbench.changes_payload([change])
    assert payload[0]["key"] == {"api_token": "[REDACTED]"}
    assert payload[0]["before"] == {"api_token": "[REDACTED]", "password_digest": "[REDACTED]", "reset_token": None, "name": "A"}
    assert payload[0]["after"]["reset_token"] == "[REDACTED]" and payload[0]["after"]["name"] == "B"
    assert "tok-123" not in json.dumps(payload) and "digest" not in json.dumps(payload).replace("password_digest", "")


def test_session_identifiers_count_as_secrets():
    from testbench_core.redaction import describe_parameters, looks_secret

    for name in ("session_key", "session_data", "sessionId", "SESSION_TOKEN"):
        assert looks_secret(name), name
    assert not looks_secret("session_count") and not looks_secret("sessions")
    statement = 'SELECT "django_session"."session_data" FROM "django_session" WHERE "session_key" = %s'
    listed, _ = describe_parameters(statement, [("p0", "abc123sessionkey", "String")], True)
    assert listed == [("p0", "[REDACTED]", "String")]


def test_transaction_guard_refuses_statements_that_end_the_preview():
    from testbench_core.txguard import escapes_transaction as escapes

    for sql in ("COMMIT", "commit work", "/* x */ END", "ROLLBACK", "BEGIN", "START TRANSACTION",
                "select 1; commit", "PREPARE TRANSACTION 'x'", "RELEASE SAVEPOINT testbench_preview"):
        assert escapes(sql, "postgresql", "testbench_preview"), sql
    assert escapes("SET autocommit = 1", "mysql") and escapes("CREATE TABLE t (a int)", "mysql")
    assert escapes("BEGIN COMMIT; END;", "oracle")
    for sql in ("ROLLBACK TO SAVEPOINT s1", 'SAVEPOINT "s1_x1"', "RELEASE SAVEPOINT sa_savepoint_1",
                "INSERT INTO t VALUES ('a; commit')", "DO $$ BEGIN PERFORM 1; END $$", "UPDATE t SET end_date = 1"):
        assert escapes(sql, "postgresql", "testbench_preview") is None, sql
    assert escapes("CREATE TABLE t (a int)", "sqlite") is None
    assert escapes("CREATE TEMPORARY TABLE t (a int)", "mysql") is None
    assert escapes("BEGIN NULL; END;", "oracle") is None


def test_malformed_origin_never_matches_a_malformed_host():
    headers = {"origin": ["null"]}
    assert not protocol.is_same_origin(lambda name: headers.get(name, []), "http", "")
    assert not protocol.is_same_origin(lambda name: headers.get(name, []), "http", "bad host")


def test_database_label_must_be_a_bare_name():
    from testbench_core.options import require_display_label

    assert require_display_label("PostgreSQL 16") == "PostgreSQL 16"
    for bad in ("postgresql://u:p@h/db", "/var/data/app.sqlite", "Server=h;Password=p", "C:\\db.sqlite", "user@host", ""):
        with pytest.raises(ValueError):
            require_display_label(bad)

    class Provider(testbench_core.PreviewProvider):
        database = "postgresql://user:secret@db/app"

        def begin(self, scope):
            raise NotImplementedError

    with pytest.raises(ValueError):
        Workbench(BenchOptions(environment="Development"), Provider())


def test_encoded_dot_segments_are_not_local_urls():
    from testbench_core.options import require_local_url

    for bad in ("/docs/%2e%2e/%2E%2E/admin", "/%2F/evil.example", "/a/%5c/b"):
        with pytest.raises(ValueError):
            require_local_url(bad)
    assert require_local_url("/openapi.json?v=%2e") == "/openapi.json?v=%2e"


def test_sql_echo_loggers_and_statement_error_parameters_are_not_captured():
    import logging

    from testbench_core.capture import CaptureLogHandler

    scope = RequestScope(Capture(rollback=True), "Development", True)
    handler = CaptureLogHandler(lambda: scope)

    class StatementError(Exception):
        def __init__(self):
            super().__init__("(IntegrityError) failed [parameters: ('hunter2',)]")
            self.statement, self.params, self.orig = "INSERT ...", ("hunter2",), ValueError("UNIQUE failed")

    for name in ("sqlalchemy.engine.Engine", "django.db.backends"):
        handler.emit(logging.LogRecord(name, logging.INFO, __file__, 1, "INSERT ... ('hunter2',)", None, None))
    try:
        raise StatementError()
    except StatementError:
        import sys

        handler.emit(logging.LogRecord("app", logging.ERROR, __file__, 1, "insert failed", None, sys.exc_info()))
    logs = scope.capture.finish().logs
    assert [entry["category"] for entry in logs] == ["app"]
    assert "hunter2" not in json.dumps(logs) and logs[0]["exception"]["message"] == "ValueError: UNIQUE failed"


def test_trace_ids_carry_128_random_bits():
    store = TraceStore()
    owner = ("session", "", "a", "")
    ids = {store.reserve(owner).id for _ in range(8)}
    assert len(ids) == 8 and all(len(i) == 32 and int(i, 16) >= 0 for i in ids)

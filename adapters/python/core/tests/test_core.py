import json

import pytest

from sendproof_core import BenchOptions, Identity, limits, protocol
from sendproof_core.capture import Capture
from sendproof_core.jsonsafe import body_from_bytes
from sendproof_core.scope import RequestScope, activate, current_scope, deactivate
from sendproof_core.assets import UiAssets, UiBundleError
from sendproof_core.trace_store import TraceStore
from sendproof_core.workbench import Workbench, trace_owner
import sendproof_core


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_environment_is_off_by_default(monkeypatch):
    monkeypatch.delenv("SENDPROOF_ENVIRONMENT", raising=False)
    assert BenchOptions().environment == "Production"
    assert not BenchOptions().enabled
    assert BenchOptions(environment="development").enabled
    monkeypatch.setenv("SENDPROOF_ENVIRONMENT", "Development")
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


@pytest.mark.parametrize("target", ["", "//x", "/a/../b", "/a\\b", "/sendproof", "/sendproof/_api/capabilities", "/a%2F..%2Fb"])
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
    class Provider(sendproof_core.PreviewProvider):
        database = "inventory"

        def begin(self, scope):
            raise NotImplementedError

    options = BenchOptions(environment="Development", auth_providers=[sendproof_core.AuthProvider("P", "cookie", "/auth")])
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
    (tmp_path / "index.html").write_bytes(b"<title>Sendproof</title>")
    digest = __import__("hashlib").sha256(b"<title>Sendproof</title>").hexdigest()
    (tmp_path / "manifest.json").write_text(json.dumps(
        {"version": "1", "bundleHash": "x", "files": {"index.html": {"sha256": digest, "bytes": 24, "contentType": "text/html"}}}))
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
    from sendproof_core.provider import PreviewChange

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
    from sendproof_core.redaction import describe_parameters, looks_secret

    for name in ("session_key", "session_data", "sessionId", "SESSION_TOKEN"):
        assert looks_secret(name), name
    assert not looks_secret("session_count") and not looks_secret("sessions")
    statement = 'SELECT "django_session"."session_data" FROM "django_session" WHERE "session_key" = %s'
    listed, _ = describe_parameters(statement, [("p0", "abc123sessionkey", "String")], True)
    assert listed == [("p0", "[REDACTED]", "String")]


def test_transaction_guard_refuses_statements_that_end_the_preview():
    from sendproof_core.txguard import escapes_transaction as escapes

    for sql in ("COMMIT", "commit work", "/* x */ END", "ROLLBACK", "BEGIN", "START TRANSACTION",
                "select 1; commit", "PREPARE TRANSACTION 'x'", "RELEASE SAVEPOINT sendproof_preview"):
        assert escapes(sql, "postgresql", "sendproof_preview"), sql
    assert escapes("SET autocommit = 1", "mysql") and escapes("CREATE TABLE t (a int)", "mysql")
    assert escapes("BEGIN COMMIT; END;", "oracle")
    for sql in ("ROLLBACK TO SAVEPOINT s1", 'SAVEPOINT "s1_x1"', "RELEASE SAVEPOINT sa_savepoint_1",
                "INSERT INTO t VALUES ('a; commit')", "DO $$ BEGIN PERFORM 1; END $$", "UPDATE t SET end_date = 1"):
        assert escapes(sql, "postgresql", "sendproof_preview") is None, sql
    assert escapes("CREATE TABLE t (a int)", "sqlite") is None
    assert escapes("CREATE TEMPORARY TABLE t (a int)", "mysql") is None
    assert escapes("BEGIN NULL; END;", "oracle") is None


def test_a_deadlock_or_rolled_back_lock_timeout_ends_the_mysql_preview_transaction():
    from sendproof_core.txguard import server_ended_transaction as ended

    class DriverError(Exception):
        pass

    class Wrapped(Exception):  # SQLAlchemy keeps the driver error on .orig, Django on __cause__
        def __init__(self, orig):
            super().__init__("wrapped")
            self.orig = orig

    on, off = (lambda: True), (lambda: False)
    assert ended(DriverError(1213, "Deadlock found"), "mysql", off)
    assert ended(Wrapped(DriverError(1213, "x")), "mariadb", off)
    assert ended(DriverError(1205, "Lock wait timeout"), "mysql", on)
    assert ended(DriverError(1205, "Lock wait timeout"), "mysql", off) is None  # only the statement rolled back
    assert ended(DriverError(1062, "Duplicate"), "mysql", on) is None
    assert ended(DriverError(1213, "x"), "postgresql", on) is None  # PostgreSQL refuses later statements itself


def test_transaction_guard_refuses_every_mysql_escape_before_sending():
    """spec/data-stores.md, "Transaction-control statements from the handler", on MySQL and MariaDB."""
    from sendproof_core.txguard import escapes_transaction as escapes
    from sendproof_core.txguard import normalize_procedures

    refused = (
        "CALL sendproof_commit_probe()", "call shop.refresh()", "CALL `refresh`", "/*!50000 COMMIT */",
        "/*M!100100 CREATE TABLE t (n INT) */", "SET @@session.autocommit = 1", "SET sql_mode = '', autocommit = 1",
        "SET LOCAL autocommit=1", "CREATE TABLE sendproof_escape_1 (n INT)", "TRUNCATE t", "LOCK TABLES t WRITE",
        "UNLOCK TABLES", "GRANT SELECT ON t TO u", "RENAME TABLE a TO b", "CACHE INDEX t IN hot",
        "LOAD INDEX INTO CACHE t", "CHECK TABLE t", "STOP REPLICA", "CHANGE REPLICATION SOURCE TO SOURCE_HOST='h'",
        "SET PASSWORD = 'x'", "EXECUTE stmt", "XA START 'x'", "PREPARE s FROM 'COMMIT'", "PREPARE s FROM @sql",
        "EXECUTE IMMEDIATE 'COMMIT'", "SELECT 1 /*! ; COMMIT */",
        # A quote inside a comment, a "#" comment, or a backslash-escaped quote never hides what follows.
        "SELECT 1 # it's\n; COMMIT; SELECT 'x'", 'SELECT "a\\" "; COMMIT; SELECT "b"',
        "SELECT 1 -- it's\n; COMMIT; SELECT 'x'", "SELECT 1--1; COMMIT",
        "SELECT $a$; COMMIT; SELECT $a$",
    )
    for sql in refused:
        for dialect in ("mysql", "mariadb"):
            assert escapes(sql, dialect), (dialect, sql)
    allowed = (
        "SELECT 'CALL p(); COMMIT'", "SELECT 1 /* CALL p() */", "INSERT INTO t VALUES ('a\\'; COMMIT; --')",
        "CREATE TEMPORARY TABLE t (n INT)", "SAVEPOINT s1", "ROLLBACK TO SAVEPOINT s1", "SELECT `call` FROM t",
        "UPDATE t SET checked = 1", "SET @x = 1",
    )
    for sql in allowed:
        assert escapes(sql, "mysql") is None, sql
    # Host-declared procedures: exact names only, case-insensitive like MySQL, qualified as written.
    safe = normalize_procedures(["refresh_totals", "shop.Rebuild"])
    for sql in ("CALL refresh_totals()", "CALL REFRESH_TOTALS", "call `refresh_totals`(1)", "CALL shop.rebuild()"):
        assert escapes(sql, "mysql", safe_procedures=safe) is None, sql
    for sql in ("CALL refresh_totals_all()", "CALL other.refresh_totals()", "CALL rebuild()",
                "CALL refresh_totals(); COMMIT", "CALL `refresh totals`()"):
        assert escapes(sql, "mysql", safe_procedures=safe), sql
    for bad in ("refresh_*", "`p`", "a.b.c", "", 3):
        with pytest.raises(ValueError):
            normalize_procedures([bad])
    # Elsewhere, a standard string has no backslash escapes, so "\'" ends it and what follows is seen.
    assert escapes("SELECT 'a\\'; COMMIT; --'", "postgresql")
    assert escapes("SELECT E'a\\'; COMMIT; --'", "postgresql") is None
    assert escapes("SELECT E'a\\''; COMMIT", "postgresql")  # the escaped quote ends nothing; the next one does
    assert escapes("SELECT $$ ; COMMIT $$", "postgresql") is None
    assert escapes("SELECT $body$ ; COMMIT $body$; COMMIT", "postgresql")
    assert escapes("SELECT 1 # x\n", "postgresql") is None and escapes("SELECT 2 #- '{a}'; COMMIT", "postgresql")
    assert escapes('SELECT "a\\"; COMMIT', "postgresql")  # a PostgreSQL identifier has no backslash escapes
    assert escapes("SELECT 'a\\'; COMMIT; --'", "sqlite")
    assert escapes("CALL p()", "postgresql") is None  # CALL is refused on MySQL and MariaDB only


def test_malformed_origin_never_matches_a_malformed_host():
    headers = {"origin": ["null"]}
    assert not protocol.is_same_origin(lambda name: headers.get(name, []), "http", "")
    assert not protocol.is_same_origin(lambda name: headers.get(name, []), "http", "bad host")


def test_database_label_must_be_a_bare_name():
    from sendproof_core.options import require_display_label

    assert require_display_label("PostgreSQL 16") == "PostgreSQL 16"
    for bad in ("postgresql://u:p@h/db", "/var/data/app.sqlite", "Server=h;Password=p", "C:\\db.sqlite", "user@host", ""):
        with pytest.raises(ValueError):
            require_display_label(bad)

    class Provider(sendproof_core.PreviewProvider):
        database = "postgresql://user:secret@db/app"

        def begin(self, scope):
            raise NotImplementedError

    with pytest.raises(ValueError):
        Workbench(BenchOptions(environment="Development"), Provider())


def test_encoded_dot_segments_are_not_local_urls():
    from sendproof_core.options import require_local_url

    for bad in ("/docs/%2e%2e/%2E%2E/admin", "/%2F/evil.example", "/a/%5c/b"):
        with pytest.raises(ValueError):
            require_local_url(bad)
    assert require_local_url("/openapi.json?v=%2e") == "/openapi.json?v=%2e"


def test_sql_echo_loggers_and_statement_error_parameters_are_not_captured():
    import logging

    from sendproof_core.capture import CaptureLogHandler

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

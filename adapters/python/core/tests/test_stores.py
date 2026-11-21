"""Core of the data-store support: tables, classifiers, the write guard and the Preview pipeline.

These tests need no service. The store hooks have their own files (``test_redis_store.py``,
``test_dynamodb_store.py``, ``test_mongo_store.py``).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sendproof_core import BenchOptions, PreviewChange, PreviewProvider
from sendproof_core.capture import Capture
from sendproof_core.marker import apply_marker, is_marked, is_previewable, unavailable_info
from sendproof_core.provider import PreviewSession
from sendproof_core.redaction import REDACTED, redact_deep
from sendproof_core.stores import (
    DataStore,
    PreviewWriteBlocked,
    StoresOnlyProvider,
    classify_dynamo,
    classify_mongo,
    classify_redis,
    guard,
    partiql_verb,
    sanitize_document,
    write_reason,
)
from sendproof_core.stores import tables
from sendproof_core.stores.dynamodb_hook import sanitize_partiql
from sendproof_core.stores.guard import read_set, refuse_in_preview, store_label
from sendproof_core.sync_engine import Inner, SyncBench
from sendproof_core.workbench import Workbench, blocked_response

from store_support import active, db_entries, observed_scope, preview_scope

SPEC = Path(__file__).resolve().parents[4] / "spec" / "data-stores"
CASES = json.loads((SPEC / "classification-cases.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ tables and vectors
@pytest.mark.parametrize("store", ["redis", "mongodb", "dynamodb"])
def test_embedded_data_store_tables_match_spec(store):
    """Fails when ``stores/tables.py`` differs from spec/data-stores/: run scripts/embed_store_tables.py."""
    spec = json.loads((SPEC / f"{store}.json").read_text(encoding="utf-8"))
    assert getattr(tables, f"{store.upper()}_TABLE") == spec


@pytest.mark.parametrize("case", CASES["redis"], ids=lambda case: " ".join(case["command"]))
def test_redis_classifier_passes_every_shared_vector(case):
    name, *args = case["command"]
    assert classify_redis(name, args) == case["expect"]


@pytest.mark.parametrize("case", CASES["mongodb"], ids=lambda case: json.dumps(case["command"])[:60])
def test_mongodb_classifier_passes_every_shared_vector(case):
    kind, refused = classify_mongo(case["command"])
    assert kind == case["expect"]
    assert refused == case.get("refusedInTransaction")


@pytest.mark.parametrize("case", CASES["dynamodb"], ids=lambda case: f"{case['operation']}-{json.dumps(case['input'])[:40]}")
def test_dynamodb_classifier_passes_every_shared_vector(case):
    assert classify_dynamo(case["operation"], case["input"]) == case["expect"]


def test_redis_container_commands_may_be_one_word_or_two():
    assert classify_redis("OBJECT ENCODING", ["k"]) == "read"
    assert classify_redis(b"get", [b"k"]) == "read"
    assert classify_redis("CONFIG SET", ["a", "b"]) == "write"


def test_mongodb_pipeline_is_scanned_at_any_depth():
    nested = {"aggregate": "c", "pipeline": [{"$facet": {"a": [{"$lookup": {"pipeline": [{"$unionWith": {"coll": "x", "pipeline": [{"$out": "o"}]}}]}}]}}]}
    assert classify_mongo(nested) == ("write", "$out")
    assert classify_mongo({"aggregate": "c", "pipeline": [{"$match": {"$merge": 1}}]})[0] == "write"  # a key anywhere counts: fail closed


def test_partiql_verb_skips_whitespace_and_comments():
    assert partiql_verb("  /* a */ -- b\n select 1") == "SELECT"
    assert partiql_verb("/* never closed") == ""




def test_host_declared_reads_match_exact_names_only():
    assert classify_redis("MYMODULE.GET", ["k"]) == "write"
    assert classify_redis("MYMODULE.GET", ["k"], read_set(["MYMODULE.GET"], str.upper)) == "read"
    assert classify_redis("MYMODULE.GETX", ["k"], read_set(["MYMODULE.GET"], str.upper)) == "write"
    assert classify_mongo({"customRead": 1}, read_set(["customRead"], str.lower))[0] == "read"
    assert classify_dynamo("DescribeThing", {}, read_set(["DescribeThing"])) == "read"
    for bad in (["MY*"], ["a b"], ["get?"], [""]):
        with pytest.raises(ValueError):
            read_set(bad)
    with pytest.raises(TypeError):
        read_set("GET")  # a bare string is almost certainly a mistake


def test_store_labels_must_be_display_names():
    assert store_label("catalog") == "catalog"
    assert store_label(None) is None
    for bad in ("mongodb://user:secret@host/db", "host:6379", "a/b", "x@y", "", "k=v", "a" * 65, "tab\t"):
        with pytest.raises(ValueError):
            store_label(bad)


def test_partiql_literals_are_replaced_and_names_kept():
    text = "UPDATE \"orders\" SET note = 'it''s secret', qty = 12, price = 3.5e2 WHERE id = 'abc' AND ref = ?"
    assert sanitize_partiql(text) == 'UPDATE "orders" SET note = ?, qty = ?, price = ? WHERE id = ? AND ref = ?'
    assert sanitize_partiql('SELECT "a1" FROM "t2"') == 'SELECT "a1" FROM "t2"'
    assert sanitize_partiql("x = 'unterminated") == "x = ?"


def test_documents_are_sanitized_to_question_marks():
    command = {"update": "c", "updates": [{"q": {"_id": "k", "age": {"$gt": 3}}, "u": {"$set": {"name": "x"}}}]}
    assert sanitize_document(command) == {"update": "?", "updates": [{"q": {"_id": "?", "age": {"$gt": "?"}}, "u": {"$set": {"name": "?"}}}]}


# ------------------------------------------------------------------------------- guard
def test_guard_does_nothing_outside_a_preview():
    guard("redis", "INCR", "write")  # no scope at all
    with active(observed_scope()) as scope:
        guard("redis", "INCR", "write")  # observed Send is never blocked
        assert scope.capture.blocked is None


def test_guard_marks_the_first_block_logs_it_and_raises():
    with active(preview_scope()) as scope:
        guard("redis", "GET", "read")
        guard("redis", "AUTH", "session")
        with pytest.raises(PreviewWriteBlocked) as first:
            guard("redis", "INCR", "write")
        with pytest.raises(PreviewWriteBlocked):
            guard("dynamodb", "PutItem", "write")  # later writes to any store are refused too
        assert (first.value.store, first.value.operation) == ("redis", "INCR")
        assert scope.capture.blocked == {"store": "redis", "operation": "INCR", "detail": write_reason("redis")}
        (entry,) = db_entries(scope, "redis")
        assert entry["db"]["blocked"] is True


def test_refusing_transaction_control_records_a_fault_only_in_a_preview():
    assert refuse_in_preview("no") is None
    with active(preview_scope()) as scope:
        assert isinstance(refuse_in_preview("a handler COMMIT"), Exception)
        assert scope.capture.fault is not None


def test_a_block_is_recorded_after_the_capture_finished():
    """A write a handler sends after its response settled is still refused, never sent unguarded."""
    with active(preview_scope()) as scope:
        scope.capture.finish()
        with pytest.raises(PreviewWriteBlocked):
            guard("redis", "SET", "write")
        assert scope.capture.blocked is not None


def test_db_entries_count_toward_db_timing_and_blocked_ones_do_not():
    capture = Capture(rollback=True)
    capture.record_db("redis", "GET", target="k", statement="GET k", elapsed_ms=2.0)
    capture.record_db("redis", "SET", blocked=True)
    assert capture.timing().query_count == 1
    entries = capture.finish().logs
    assert [e["db"]["operation"] for e in entries] == ["GET", "SET"]
    assert entries[0]["message"] == "GET k" and entries[1]["message"] == "SET"


def test_the_capture_ignores_the_bindings_own_commands_after_the_handler():
    capture = Capture(rollback=True)
    capture.handler_finished()
    capture.record_db("mongodb", "find", target="documents")
    assert capture.finish().logs == []


# ----------------------------------------------------------------- redaction and changes
def test_secret_fields_are_redacted_at_any_depth():
    document = {"name": "x", "password_hash": "h", "profile": {"apiKey": "k", "city": "York", "tokens": [{"refreshToken": "t", "ok": 1}]},
                "idempotency_key": "visible", "nothing": None, "secret": None}
    redacted = redact_deep(document)
    assert redacted["password_hash"] == REDACTED
    assert redacted["profile"]["apiKey"] == REDACTED
    assert redacted["profile"]["tokens"] == [{"refreshToken": REDACTED, "ok": 1}]
    assert redacted["idempotency_key"] == "visible" and redacted["profile"]["city"] == "York"
    assert redacted["secret"] is None  # an absent secret stays distinguishable


def test_store_changes_carry_store_namespace_via_and_nested_redaction():
    change = PreviewChange("update", "documents", {"_id": "a"}, {"profile": {"city": "Leeds"}, "password_hash": "h"},
                           {"profile": {"city": "York"}, "password_hash": "h2"}, "mongodb", "catalog", "replace")
    payload, truncated = Workbench.changes_payload([change])
    assert not truncated
    assert payload == [{
        "operation": "update", "table": "documents", "key": {"_id": "a"}, "store": "mongodb", "namespace": "catalog", "via": "replace",
        "before": {"profile": {"city": "Leeds"}, "password_hash": REDACTED}, "after": {"profile": {"city": "York"}, "password_hash": REDACTED},
    }]
    sql = PreviewChange("insert", "items", {"id": "1"}, None, {"id": "1"})
    assert "store" not in Workbench.changes_payload([sql])[0][0]


# ------------------------------------------------------------ preview: false and markers
def test_preview_false_marks_an_operation_unavailable_with_a_reason():
    def handler():
        return None

    marked = apply_marker(handler, True, reason=None, stores=None)
    assert is_previewable(marked) and unavailable_info(marked) is None

    unavailable = apply_marker(False, reason="Clears the Redis session", stores=["redis"])(handler)
    assert is_marked(unavailable) and not is_previewable(unavailable)
    info = unavailable_info(unavailable)
    assert (info.reason, info.stores) == ("Clears the Redis session", ("redis",))

    by_store = apply_marker(False, stores=["redis"])(handler)
    assert unavailable_info(by_store).reason == "Preview unavailable: this operation writes to Redis"
    assert unavailable_info(apply_marker(False)(handler)).reason.startswith("Preview unavailable: ")
    assert is_previewable(apply_marker(True)(handler))
    with pytest.raises(TypeError):
        apply_marker("yes")


# -------------------------------------------------------------- the Preview pipeline
class _Writes(DataStore):
    """A hooked store whose hook is a one-line function: guard, then 'send'."""

    system = "redis"

    def __init__(self, fail_finish: bool = False, store_change: bool = False) -> None:
        self.sent: list[str] = []
        self.finished = 0
        self.began = 0
        self.fail_finish, self.store_change = fail_finish, store_change

    def describe(self):
        return {"system": "redis", "name": "cache", "mode": "guard"}

    def begin(self, scope):
        self.began += 1

    def finish(self, scope):
        self.finished += 1
        if self.store_change:
            scope.store_changes.append(PreviewChange("insert", "documents", {"_id": "a"}, None, {"_id": "a"}, "mongodb", "catalog"))
        if self.fail_finish:
            raise RuntimeError("abort failed")

    def write(self, command: str, *, hooked: bool = True) -> None:
        if hooked:
            guard("redis", command, "write")
        self.sent.append(command)


def bench(*stores: DataStore, provider: PreviewProvider | None = None) -> SyncBench:
    options = BenchOptions(environment="Development", framework="Test")
    workbench = Workbench(options, provider or StoresOnlyProvider())
    return SyncBench(options, provider or StoresOnlyProvider(), workbench, None, stores)


def run(engine: SyncBench, handler):
    def dispatch(scope):
        scope.entered = True
        status, body = handler(scope)
        return Inner(status, [("content-type", "application/json")], json.dumps(body).encode())

    return engine.preview(dispatch=dispatch, started=0.0, method="POST", path="/sendproof/_preview/x")


def test_a_blocked_preview_answers_409_even_when_the_handler_swallows_the_error():
    store = _Writes()

    def swallowing(scope):
        try:
            store.write("INCR")
        except PreviewWriteBlocked:
            return 200, {"ok": True}  # the handler hides the refusal
        return 200, {"ok": True}

    response = run(bench(store), swallowing)
    body = json.loads(response.body)
    assert response.status == 409
    assert dict(response.headers)["content-type"].startswith("application/problem+json")
    assert "preference-applied" not in {k.lower() for k, _ in response.headers}
    assert dict(response.headers)["cache-control"] == "no-store"
    assert body == {"type": "about:blank", "title": "Preview unavailable", "status": 409, "code": "preview_unavailable",
                    "detail": "Preview unavailable: this operation writes to Redis", "store": "redis", "operation": "INCR", "rolledBack": False}
    assert store.sent == [] and (store.began, store.finished) == (1, 1)


def test_a_blocked_preview_answers_409_when_the_handler_lets_the_error_escape():
    store = _Writes()

    def raising(scope):
        store.write("SET")
        return 200, {}

    assert run(bench(store), raising).status == 409


def test_the_guard_checks_fail_when_the_hook_is_removed():
    """The negative test: without the guard the same handler is confirmed, so the checks above would fail."""
    store = _Writes()
    response = run(bench(store), lambda scope: (store.write("INCR", hooked=False), (200, {"ok": True}))[1])
    assert response.status == 200 and json.loads(response.body)["rolledBack"] is True
    assert store.sent == ["INCR"]  # the write reached the store, and the Preview confirmed it


def test_a_fault_or_a_failed_abort_outranks_a_blocked_write():
    def block_then_fault(scope):
        scope.capture.refuse(RuntimeError("a handler commitTransaction"))
        guard("redis", "INCR", "write")

    assert run(bench(_Writes()), block_then_fault).status == 500

    store = _Writes(fail_finish=True)

    def blocked(scope):
        try:
            guard("redis", "INCR", "write")
        except PreviewWriteBlocked:
            pass
        return 200, {}

    assert run(bench(store), blocked).status == 500  # a failed abort: never confirmed, never a 409


def test_a_clean_preview_is_confirmed_with_store_changes_and_db_entries():
    store = _Writes(store_change=True)

    def read(scope):
        scope.capture.record_db("redis", "GET", target="k", statement="GET k")
        return 200, {"value": 1}

    response = run(bench(store), read)
    envelope = json.loads(response.body)
    assert response.status == 200 and envelope["rolledBack"] is True
    assert envelope["changes"] == [{"operation": "insert", "table": "documents", "key": {"_id": "a"}, "before": None,
                                    "after": {"_id": "a"}, "store": "mongodb", "namespace": "catalog"}]
    assert [e["db"]["operation"] for e in envelope["logs"] if e["level"] == "Db"] == ["GET"]
    assert dict(response.headers)["preference-applied"] == "tx=rollback"


def test_a_handler_exception_after_a_block_still_answers_409_and_other_exceptions_500():
    def explode(scope):
        raise RuntimeError("boom")

    assert run(bench(_Writes()), explode).status == 500

    def block_then_explode(scope):
        try:
            guard("redis", "INCR", "write")
        finally:
            raise RuntimeError("boom after the block")

    assert run(bench(_Writes()), block_then_explode).status == 409


def test_a_store_that_began_is_always_finished():
    stores = [_Writes(), _Writes()]
    run(bench(*stores), lambda scope: (200, {}))
    assert [(s.began, s.finished) for s in stores] == [(1, 1), (1, 1)]


class _SqlSession(PreviewSession):
    def __init__(self, fail: bool) -> None:
        self.fail, self.rolled_back = fail, False

    @property
    def changes(self):
        return []

    def rollback(self):
        self.rolled_back = True
        if self.fail:
            raise RuntimeError("rollback failed")

    def close(self):
        pass


class _SqlProvider(PreviewProvider):
    database = "x"

    def __init__(self, fail: bool = False) -> None:
        self.session = _SqlSession(fail)

    def begin(self, scope):
        return self.session


def test_sql_rolls_back_with_a_blocked_write_and_a_failed_rollback_outranks_it():
    provider = _SqlProvider()
    store = _Writes()
    assert run(bench(store, provider=provider), lambda scope: guard("redis", "INCR", "write")).status == 409
    assert provider.session.rolled_back is True  # SQL rolls back as usual
    failing = _SqlProvider(fail=True)
    assert run(bench(_Writes(), provider=failing), lambda scope: guard("redis", "INCR", "write")).status == 500


def test_preview_works_without_a_sql_provider_when_stores_are_registered():
    engine = bench(_Writes())
    assert engine.provider_available
    assert run(engine, lambda scope: (200, {"ok": True})).status == 200


def test_capabilities_list_stores_unavailable_operations_binding_and_database_system():
    store = _Writes()
    engine = bench(store)
    engine.workbench.options.framework = "Test"
    response = engine.workbench.capabilities(
        "", None, [("POST", "/items")], "/openapi.json", "API",
        [("DELETE", "/sessions/{id}", "Clears the Redis session", ("redis",))], engine.describe_stores(),
    )
    document = json.loads(response.body)
    assert document["dataStores"] == [{"system": "redis", "name": "cache", "mode": "guard"}]
    assert document["previewUnavailable"] == [{"method": "DELETE", "path": "/sessions/{id}", "reason": "Clears the Redis session", "stores": ["redis"]}]
    assert document["binding"] == {"language": "python", "framework": "Test"}
    assert document["database"] is None  # no SQL provider

    class Sql(_SqlProvider):
        system = "sqlite"

    sql = Workbench(engine.options, Sql())
    assert json.loads(sql.capabilities("", None, [], "/o", "A").body)["database"] == {"name": "x", "system": "sqlite"}


def test_blocked_response_names_the_store_and_operation_never_arguments():
    response = blocked_response({"store": "mongodb", "operation": "aggregate", "detail": "Preview unavailable: MongoDB can't run $out inside a transaction"})
    body = json.loads(response.body)
    assert response.status == 409 and body["code"] == "preview_unavailable" and "$out" in body["detail"]
    assert set(body) == {"type", "title", "status", "code", "detail", "store", "operation", "rolledBack"}

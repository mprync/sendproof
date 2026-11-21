"""The MongoDB Preview and write guard against a real replica set
(``docker compose -f tests/conformance/compose.yml up -d mongodb``).

Covers PyMongo, ``AsyncMongoClient`` and Motor. An independent, unhooked client reads the data back,
so a passing check proves what a Preview left, or did not leave, behind.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest

from sendproof_core.stores import PreviewWriteBlocked, mongo_store
from sendproof_core.stores.guard import PreviewTransactionControl
from store_support import (
    active, arun_preview, db_entries, fresh, needs, new_mongo, observed_scope, preview_scope, run_preview, sync_bench,
)

pytestmark = needs("mongodb")


@pytest.fixture
def database():
    """A fresh database name, dropped afterwards through an independent client."""
    name = fresh()
    yield name
    reader = new_mongo()
    reader.drop_database(name)
    reader.close()


@pytest.fixture
def reader(database):
    client = new_mongo()
    yield client[database]
    client.close()


@pytest.fixture
def hooked(database):
    client = new_mongo()
    store = mongo_store(client, name="catalog")
    yield store, store.client[database]["documents"], database
    client.close()


def seed(reader, *documents):
    reader["documents"].insert_many(list(documents))


def outcome(response):
    return response.status, json.loads(response.body)


# ----------------------------------------------------------------- topology and modes
def test_a_replica_set_runs_in_preview_mode(hooked):
    store, _, _ = hooked
    assert store.describe() == {"system": "mongodb", "name": "catalog", "mode": "preview"}


def standalone(monkeypatch):
    """Make ``hello`` answer like a standalone server (no replica set name)."""
    from pymongo.database import Database

    original = Database.command

    def command(self, command, *args, **kwargs):
        if command == {"hello": 1}:
            return {"isWritablePrimary": True, "logicalSessionTimeoutMinutes": 30, "ok": 1.0}
        return original(self, command, *args, **kwargs)

    monkeypatch.setattr(Database, "command", command)


def test_a_standalone_server_runs_in_guard_mode_and_blocks_the_first_write(monkeypatch, database, reader):
    standalone(monkeypatch)
    client = new_mongo()
    store = mongo_store(client, name="catalog")
    documents = store.client[database]["documents"]
    seed(reader, {"_id": "seeded", "name": "Seeded"})
    assert store.describe() == {"system": "mongodb", "name": "catalog", "mode": "guard",
                                "reason": "Preview unavailable: this MongoDB server doesn't support transactions"}

    def handler(scope):
        found = documents.find_one({"_id": "seeded"})  # reads run
        assert found["name"] == "Seeded" and documents.count_documents({}) == 1
        try:
            documents.update_one({"_id": "seeded"}, {"$set": {"name": "x"}})
        except PreviewWriteBlocked:
            return 200, {}  # swallowed: the mark decides
        return 200, {}

    status, body = outcome(run_preview(sync_bench(store), handler))
    assert status == 409 and body["store"] == "mongodb" and body["operation"] == "update"
    assert body["detail"] == "Preview unavailable: this operation writes to MongoDB"
    assert reader["documents"].find_one({"_id": "seeded"})["name"] == "Seeded"
    client.close()


# ----------------------------------------------------------------- preview mode: rollback
def test_a_preview_rolls_back_and_reports_nested_redacted_changes(hooked, reader):
    store, documents, _ = hooked
    seed(reader, {"_id": "seeded", "name": "Seeded", "profile": {"city": "Leeds"}, "password_hash": "hashed:old"},
         {"_id": "gone", "name": "Gone"})

    def handler(scope):
        documents.insert_one({"_id": "new", "name": "New", "profile": {"city": "York"}, "password_hash": "hashed:secret", "when": __import__("datetime").datetime(2026, 1, 2)})
        documents.update_one({"_id": "seeded"}, {"$set": {"name": "Renamed", "profile.city": "Hull"}})
        documents.delete_one({"_id": "gone"})
        documents.replace_one({"_id": "replaced"}, {"name": "Replaced"}, upsert=True)
        return 201, {"ok": True}

    engine = sync_bench(store)
    response = run_preview(engine, handler)
    envelope = json.loads(response.body)
    assert response.status == 200 and envelope["rolledBack"] is True
    by_key = {change["key"]["_id"]: change for change in envelope["changes"]}
    assert set(by_key) == {"new", "seeded", "gone", "replaced"}
    insert, update, delete, upsert = by_key["new"], by_key["seeded"], by_key["gone"], by_key["replaced"]
    assert (insert["operation"], insert["before"], insert["store"], insert["table"], insert["namespace"]) == ("insert", None, "mongodb", "documents", reader.name)
    assert insert["after"]["profile"] == {"city": "York"}  # snapshots keep their nesting
    assert insert["after"]["password_hash"] == "[REDACTED]" and insert["after"]["when"] == {"$date": "2026-01-02T00:00:00Z"}
    assert (update["operation"], update["before"]["name"], update["after"]["name"]) == ("update", "Seeded", "Renamed")
    assert (update["before"]["profile"]["city"], update["after"]["profile"]["city"]) == ("Leeds", "Hull")
    assert update["before"]["password_hash"] == update["after"]["password_hash"] == "[REDACTED]"
    assert (delete["operation"], delete["after"]) == ("delete", None) and "via" not in delete
    assert (upsert["operation"], upsert.get("via")) == ("insert", "upsert")
    assert "hashed:secret" not in response.body.decode()
    # nothing was committed
    assert reader["documents"].find_one({"_id": "new"}) is None and reader["documents"].find_one({"_id": "replaced"}) is None
    assert reader["documents"].find_one({"_id": "seeded"})["name"] == "Seeded" and reader["documents"].find_one({"_id": "gone"})


def test_whole_document_replacements_and_find_and_modify_are_labelled(hooked, reader):
    store, documents, _ = hooked
    seed(reader, {"_id": "a", "name": "A"}, {"_id": "b", "name": "B"})

    def handler(scope):
        documents.replace_one({"_id": "a"}, {"name": "A2"})
        documents.find_one_and_update({"_id": "b"}, {"$set": {"name": "B2"}})
        documents.find_one_and_update({"_id": "c"}, {"$set": {"name": "C"}}, upsert=True)
        return 200, {}

    changes = {c["key"]["_id"]: c for c in json.loads(run_preview(sync_bench(store), handler).body)["changes"]}
    assert changes["a"]["via"] == "replace" and changes["b"].get("via") is None and changes["c"]["via"] == "upsert"
    assert changes["c"]["operation"] == "insert"


def test_db_entries_keep_names_and_operators_and_never_values(hooked, reader):
    store, documents, _ = hooked
    seed(reader, {"_id": "seeded", "name": "Seeded"})
    secret = "very-secret-value"

    def handler(scope):
        documents.insert_one({"_id": "n", "token": secret})
        documents.update_one({"_id": "seeded"}, {"$set": {"name": secret}})
        list(documents.find({"name": secret}))
        return 200, {}

    envelope = json.loads(run_preview(sync_bench(store), handler).body)
    entries = [e["db"] for e in envelope["logs"] if e["level"] == "Db"]
    assert [e["operation"] for e in entries] == ["insert", "update", "find"]
    assert entries[0]["statement"] == json.dumps({"insert": "?", "ordered": "?", "documents": [{"_id": "?", "token": "?"}]})
    assert entries[1]["statement"] == json.dumps({"update": "?", "ordered": "?", "updates": [{"q": {"_id": "?"}, "u": {"$set": {"name": "?"}}, "multi": "?", "upsert": "?"}]})
    assert all(e["target"] == "documents" and e["namespace"] == reader.name for e in entries)
    assert secret not in json.dumps(envelope["logs"])  # (a change record shows the document itself, by design)
    assert "token" not in [k for c in envelope["changes"] for k in (c["after"] or {}) if (c["after"] or {})[k] == secret]  # redacted by name
    # the binding's own capture reads after the handler are not the handler's commands
    assert len(entries) == 3


def test_session_and_sensitive_commands_are_never_logged(hooked):
    store, documents, _ = hooked
    with active(observed_scope()) as scope:
        documents.find_one({"_id": "x"})
        entries = db_entries(scope, "mongodb")
    assert [e["db"]["operation"] for e in entries] == ["find"]
    assert not any(e["db"]["operation"].lower() in ("hello", "ismaster", "saslstart", "authenticate", "endsessions") for e in entries)


# ------------------------------------------------------------- refused in a transaction
def test_what_a_transaction_cannot_run_is_blocked_with_a_reason_before_sending(hooked, reader):
    store, documents, database = hooked
    seed(reader, {"_id": "seeded", "name": "Seeded"})
    client = documents.database.client
    for refuse, operation, mentions in (
        (lambda: documents.aggregate([{"$match": {}}, {"$out": "archive"}]), "aggregate", "$out"),
        (lambda: documents.aggregate([{"$merge": {"into": "archive"}}]), "aggregate", "$merge"),
        (lambda: documents.estimated_document_count(), "count", "count"),
        (lambda: documents.database.create_collection("explicit"), "create", "create"),
        (lambda: documents.database.list_collection_names(), "listCollections", "listCollections"),
        (lambda: documents.drop(), "drop", "drop"),
    ):
        scope = preview_scope()
        with active(scope):
            store.begin(scope)
            try:
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    refuse()
                if mentions:
                    assert mentions in blocked.value.detail
                    assert blocked.value.detail == f"Preview unavailable: MongoDB can't run {mentions} inside a transaction"
                assert blocked.value.operation == operation
            finally:
                store.finish(scope)
    assert reader["documents"].find_one({"_id": "seeded"}) and "archive" not in reader.list_collection_names() and "explicit" not in reader.list_collection_names()


def test_an_aggregate_out_through_the_handler_answers_409_with_the_reason(hooked, reader):
    store, documents, _ = hooked
    status, body = outcome(run_preview(sync_bench(store), lambda scope: (200, list(documents.aggregate([{"$match": {}}, {"$out": "documents_archive"}])))))
    assert (status, body["store"], body["operation"]) == (409, "mongodb", "aggregate") and "$out" in body["detail"]
    assert "documents_archive" not in reader.list_collection_names()


def test_the_servers_own_refusal_code_263_is_a_block_whatever_the_handler_does(hooked, reader):
    """A rule the guard cannot see (a capped collection) is refused by the server with code 263."""
    store, documents, database = hooked
    reader.create_collection("capped", capped=True, size=4096)

    def handler(scope):
        try:
            store.client[database]["capped"].insert_one({"_id": 1})
        except Exception:  # noqa: BLE001 - the handler hides the server's error
            pass
        return 200, {}

    status, body = outcome(run_preview(sync_bench(store), handler))
    assert status == 409 and body["store"] == "mongodb" and body["operation"] == "insert"
    assert reader["capped"].count_documents({}) == 0


# -------------------------------------------------------------- the session and its calls
def test_a_write_sent_without_the_preview_session_fails_the_preview_with_500(hooked, reader, database):
    """The tripwire: an unhooked client's write cannot be undone, so no rollback is ever claimed for it."""
    store, documents, _ = hooked
    escaped = new_mongo()

    def handler(scope):
        escaped[database]["documents"].insert_one({"_id": "escaped"})
        return 201, {}

    response = run_preview(sync_bench(store), handler)
    assert response.status == 500 and "preference-applied" not in {k.lower() for k, _ in response.headers}
    assert reader["documents"].find_one({"_id": "escaped"})  # it did reach the server: the Preview must not claim otherwise
    escaped.close()


def test_a_foreign_session_is_refused_and_fails_the_preview(hooked, reader):
    store, documents, _ = hooked
    other = new_mongo()

    def handler(scope):
        with other.start_session() as session:
            with pytest.raises(PreviewTransactionControl):
                documents.insert_one({"_id": "foreign"}, session=session)
        return 201, {}

    assert run_preview(sync_bench(store), handler).status == 500
    assert reader["documents"].find_one({"_id": "foreign"}) is None
    other.close()


def test_a_handler_commit_or_abort_never_reaches_the_server_and_fails_the_preview(hooked, reader):
    store, documents, database = hooked

    def commit(scope):
        with store.client.start_session() as session:
            documents.insert_one({"_id": "c"}, session=session)
            with pytest.raises(PreviewTransactionControl):
                session.commit_transaction()
        return 201, {}

    def abort(scope):
        session = store.client.start_session()
        try:
            session.abort_transaction()
        except PreviewTransactionControl:
            pass  # swallowed
        return 200, {}

    def raw(scope):
        with pytest.raises(PreviewTransactionControl):
            store.client[database].command({"commitTransaction": 1})
        with pytest.raises(PreviewTransactionControl):
            store.client[database].command("abortTransaction")
        return 200, {}

    for handler in (commit, abort, raw):
        assert run_preview(sync_bench(store), handler).status == 500
    assert reader["documents"].find_one({"_id": "c"}) is None


def test_a_commit_sent_around_the_hook_is_caught_by_monitoring_even_after_it_reached_the_server(hooked, reader, database):
    """Like Mongoose's connection.db: the raw client sends commitTransaction with the Preview session."""
    store, documents, _ = hooked
    raw = new_mongo()

    def handler(scope):
        documents.insert_one({"_id": "maybe-committed"})  # no _id to read back would hide it otherwise
        state = store.engine.state()
        raw.admin.command({"commitTransaction": 1}, session=state.session)  # reaches the server
        return 201, {}

    response = run_preview(sync_bench(store), handler)
    assert response.status == 500 and "preference-applied" not in {k.lower() for k, _ in response.headers}
    reader["documents"].delete_many({})  # it may well have committed: that is why it can never be confirmed
    raw.close()


def test_with_transaction_and_start_transaction_join_the_preview_transaction(hooked, reader):
    store, documents, _ = hooked

    def handler(scope):
        with store.client.start_session() as session:
            session.with_transaction(lambda s: documents.insert_one({"_id": "joined"}, session=s))
            with session.start_transaction():
                documents.insert_one({"_id": "joined2"}, session=session)
        documents.insert_one({"_id": "implicit"})  # the ambient session is injected without being passed
        return 201, {}

    envelope = json.loads(run_preview(sync_bench(store), handler).body)
    assert {c["key"]["_id"] for c in envelope["changes"]} == {"joined", "joined2", "implicit"}
    assert reader["documents"].count_documents({}) == 0


def test_a_method_the_guard_does_not_know_is_refused_in_a_preview(hooked):
    store, documents, _ = hooked
    scope = preview_scope()
    with active(scope):
        store.begin(scope)
        with pytest.raises(PreviewWriteBlocked) as blocked:
            documents._command(None, {"ping": 1})  # a real driver method the tables do not list
        assert blocked.value.operation == "_command"
        store.finish(scope)
    assert documents.name == "documents"  # properties pass through
    assert documents.database.name and documents.database.client is store.client  # and wrap back to guarded handles


def test_calls_outside_a_preview_pass_straight_through_and_observed_send_commits(hooked, reader):
    store, documents, _ = hooked
    documents.insert_one({"_id": "plain"})
    with active(observed_scope()) as scope:
        documents.insert_one({"_id": "sent", "name": "x"})
        assert [e["db"]["operation"] for e in db_entries(scope, "mongodb")] == ["insert"]
    assert reader["documents"].count_documents({"_id": {"$in": ["plain", "sent"]}}) == 2


# ----------------------------------------------------------------- the reviewed fixes
def test_before_images_come_from_the_transaction_start_not_from_later_commits_by_others(hooked, reader):
    """The majority-committed view showed a concurrent commit as a Preview change."""
    store, documents, _ = hooked
    seed(reader, {"_id": "x", "name": "X"})

    def another_request():
        # A thread starts with no scope, as another request would: its writes are not the Preview's.
        reader["documents"].insert_one({"_id": "y", "name": "inserted by another request"})
        reader["documents"].update_one({"_id": "x2"}, {"$set": {"n": 1}}, upsert=True)

    def handler(scope):
        documents.find_one({"_id": "x"})  # the first reply fixes the transaction's snapshot time
        thread = threading.Thread(target=another_request)
        thread.start()
        thread.join()
        documents.update_many({}, {"$set": {"touched": True}})
        return 200, {}

    envelope = json.loads(run_preview(sync_bench(store), handler).body)
    assert [(c["key"]["_id"], c["operation"]) for c in envelope["changes"]] == [("x", "update")]
    assert reader["documents"].find_one({"_id": "y"}) is not None and reader["documents"].find_one({"_id": "x"}).get("touched") is None


def test_a_preview_keeps_the_mode_it_began_in(monkeypatch, hooked, reader):
    """A mutable shared mode let a Preview that began without a session treat its writes as joining one."""
    from pymongo.database import Database
    from pymongo.errors import ConnectionFailure

    store, documents, _ = hooked
    original = Database.command
    state = {"fail": True}

    def command(self, command, *args, **kwargs):
        if command == {"hello": 1} and state["fail"]:
            raise ConnectionFailure("simulated: the server could not be reached")
        return original(self, command, *args, **kwargs)

    monkeypatch.setattr(Database, "command", command)

    def handler(scope):
        state["fail"] = False
        assert store.engine.detect()[0] == "preview"  # a later detection succeeds...
        documents.insert_one({"_id": "late"})  # ...but this Preview began in guard mode
        return 201, {}

    status, body = outcome(run_preview(sync_bench(store), handler))
    assert status == 409 and body["detail"] == "Preview unavailable: this operation writes to MongoDB"
    assert reader["documents"].find_one({"_id": "late"}) is None


def test_a_preview_that_outlives_its_time_limit_is_aborted_and_never_confirmed(database, reader):
    client = new_mongo()
    store = mongo_store(client, preview_timeout=0.4)
    documents = store.client[database]["documents"]

    def handler(scope):
        documents.insert_one({"_id": "first"})
        time.sleep(0.9)  # a handler stuck past the limit
        with pytest.raises(PreviewTransactionControl):
            documents.insert_one({"_id": "second"})
        return 201, {}

    response = run_preview(sync_bench(store), handler)
    assert response.status == 500 and "preference-applied" not in {k.lower() for k, _ in response.headers}
    assert reader["documents"].count_documents({}) == 0
    client.close()
    with pytest.raises(ValueError):
        mongo_store(new_mongo(), preview_timeout=0)


def test_concurrent_previews_and_sends_never_share_a_session(hooked, reader):
    store, documents, _ = hooked
    results: dict[str, object] = {}

    def preview(name: str, fail: bool):
        def handler(scope):
            documents.insert_one({"_id": name})
            time.sleep(0.05)
            documents.update_one({"_id": name}, {"$set": {"n": 1}})
            if fail:
                raise RuntimeError("the handler throws")
            return 201, {}

        results[name] = run_preview(sync_bench(store), handler)

    def send(name: str):
        with active(observed_scope()):
            documents.insert_one({"_id": name})
        results[name] = None

    threads = [threading.Thread(target=preview, args=(f"p{i}", i % 3 == 0)) for i in range(6)] + \
        [threading.Thread(target=send, args=(f"s{i}",)) for i in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert [results[f"p{i}"].status for i in range(6)] == [500, 200, 200, 500, 200, 200]
    for i in range(6):
        changes = json.loads(results[f"p{i}"].body).get("changes") if results[f"p{i}"].status == 200 else []
        assert changes in ([], [c for c in changes if c["key"]["_id"] == f"p{i}"])  # only its own documents
    assert sorted(d["_id"] for d in reader["documents"].find()) == ["s0", "s1", "s2"]  # sends committed, previews left nothing


def test_a_write_conflict_between_two_previews_reaches_the_handler(hooked, reader):
    from pymongo.errors import OperationFailure

    store, documents, _ = hooked
    seed(reader, {"_id": "hot", "n": 0})
    holding, release = threading.Event(), threading.Event()
    errors: list[BaseException] = []

    def first(scope):
        documents.update_one({"_id": "hot"}, {"$set": {"n": 1}})
        holding.set()
        release.wait(5)
        return 200, {}

    def second(scope):
        holding.wait(5)
        try:
            documents.update_one({"_id": "hot"}, {"$set": {"n": 2}})
        except OperationFailure as error:  # does not queue behind the first Preview
            errors.append(error)
        finally:
            release.set()
        return 200, {}

    threads = [threading.Thread(target=lambda: run_preview(sync_bench(store), h)) for h in (first, second)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(errors) == 1 and errors[0].code == 112  # WriteConflict
    assert reader["documents"].find_one({"_id": "hot"})["n"] == 0


def test_the_checks_fail_without_the_hook(reader, database):
    """The negative test: an unhooked client writes during a Preview with nothing to stop or flag it."""
    scope = preview_scope()
    raw = new_mongo()
    with active(scope):
        raw[database]["documents"].insert_one({"_id": "unhooked"})
    # Only the global monitor noticed, because the client was created after it was registered;
    # a client without the listener would leave not even a fault. Here the fault is the proof.
    assert scope.capture.fault is not None and scope.capture.blocked is None
    assert reader["documents"].find_one({"_id": "unhooked"})
    raw.close()


def test_hooking_twice_and_bad_labels_are_refused(database):
    client = new_mongo()
    mongo_store(client)
    with pytest.raises(TypeError):
        mongo_store(client)
    with pytest.raises(ValueError):
        mongo_store(new_mongo(), name="mongodb://user:pw@host/db")
    with pytest.raises(TypeError):
        mongo_store(object())
    client.close()


def test_treat_as_read_lets_an_exact_command_through_in_guard_mode(monkeypatch, database):
    standalone(monkeypatch)
    client = new_mongo()
    store = mongo_store(client, treat_as_read=["ping"])  # already a session command: allowed either way
    scope = preview_scope()
    with active(scope):
        store.begin(scope)
        store.client[database].command("ping")
        with pytest.raises(PreviewWriteBlocked):
            store.client[database].command("dbHash")  # unlisted: a write as far as the guard knows
    client.close()


# --------------------------------------------------------------------- async clients
def async_clients():
    from pymongo import AsyncMongoClient

    from store_support import MONGODB_URL

    clients = [("async", lambda: AsyncMongoClient(MONGODB_URL))]
    try:
        import motor.motor_asyncio as motor

        clients.append(("motor", lambda: motor.AsyncIOMotorClient(MONGODB_URL)))
    except ImportError:  # pragma: no cover
        pass
    return clients


@pytest.fixture(params=[name for name, _ in async_clients()])
async def ahooked(request, database):
    client = dict(async_clients())[request.param]()
    store = mongo_store(client, name="catalog", preview_timeout=30)
    yield store, store.client[database]["documents"], request.param
    await client.close() if request.param == "async" else client.close()


async def test_async_clients_roll_back_and_report_changes(ahooked, reader):
    store, documents, flavor = ahooked
    seed(reader, {"_id": "seeded", "name": "Seeded", "profile": {"city": "Leeds"}})
    assert (await store.adescribe())["mode"] == "preview"

    async def handler(scope):
        await documents.insert_one({"_id": "new", "password_hash": "hashed:s3cret", "profile": {"city": "York"}})
        await documents.update_one({"_id": "seeded"}, {"$set": {"profile.city": "Hull"}})
        assert (await documents.find_one({"_id": "seeded"}))["profile"]["city"] == "Hull"  # reads see the transaction's writes
        async for _ in documents.find({}):
            pass

    scope, error = await arun_preview([store], handler)
    assert error is None and scope.capture.fault is None and scope.capture.blocked is None
    changes = {c.key["_id"]: c for c in scope.store_changes}
    assert (changes["new"].operation, changes["new"].after["profile"]) == ("insert", {"city": "York"})
    assert (changes["seeded"].before["profile"]["city"], changes["seeded"].after["profile"]["city"]) == ("Leeds", "Hull")
    assert reader["documents"].find_one({"_id": "new"}) is None
    assert reader["documents"].find_one({"_id": "seeded"})["profile"]["city"] == "Leeds"
    assert {e["db"]["operation"] for e in db_entries(scope, "mongodb")} >= {"insert", "update", "find"}


async def test_async_blocked_commands_session_calls_and_escapes(ahooked, reader, database):
    store, documents, flavor = ahooked
    raw = new_mongo()  # synchronous and unhooked, only for the escape

    async def handler(scope):
        with pytest.raises(PreviewWriteBlocked):
            cursor = documents.aggregate([{"$out": "archive"}])
            await cursor if flavor == "async" else None  # PyMongo's async aggregate is a coroutine; Motor's returns a cursor
        session = store.client.start_session()
        session = await session if hasattr(session, "__await__") and flavor == "motor" else session
        with pytest.raises(PreviewTransactionControl):
            await session.commit_transaction()
        raw[database]["documents"].insert_one({"_id": "escaped"})  # sent around the hook

    scope, error = await arun_preview([store], handler)
    assert error is None
    assert scope.capture.blocked["operation"] == "aggregate" and "$out" in scope.capture.blocked["detail"]
    assert scope.capture.fault is not None  # the commit attempt, and (where the context carries) the escape
    assert "archive" not in reader.list_collection_names()
    reader["documents"].delete_many({})
    raw.close()


async def test_an_async_escape_is_caught_where_the_context_carries(database, reader):
    from pymongo import AsyncMongoClient

    from store_support import MONGODB_URL

    client = AsyncMongoClient(MONGODB_URL)
    store = mongo_store(client)
    unhooked = AsyncMongoClient(MONGODB_URL)

    async def handler(scope):
        await unhooked[database]["documents"].insert_one({"_id": "escaped"})

    scope, error = await arun_preview([store], handler)
    assert error is None and scope.capture.fault is not None and "escaped the Preview session" in str(scope.capture.fault)
    await client.close()
    await unhooked.close()


async def test_a_preview_in_a_worker_thread_with_a_sync_client_crosses_the_context(hooked, reader):
    """FastAPI runs ``def`` endpoints through ``run_in_threadpool``: the scope must reach the thread."""
    store, documents, _ = hooked
    scope = preview_scope()

    async def handler(_):
        await asyncio.to_thread(documents.insert_one, {"_id": "thread"})

    result, error = await arun_preview([store], handler)
    assert error is None and [c.key["_id"] for c in result.store_changes] == ["thread"]
    assert reader["documents"].find_one({"_id": "thread"}) is None


async def test_an_async_preview_that_outlives_its_time_limit_is_aborted_and_never_confirmed(database, reader):
    from pymongo import AsyncMongoClient

    from store_support import MONGODB_URL

    client = AsyncMongoClient(MONGODB_URL)
    store = mongo_store(client, preview_timeout=0.3)
    documents = store.client[database]["documents"]

    async def handler(scope):
        await documents.insert_one({"_id": "first"})
        await asyncio.sleep(0.8)  # a handler stuck past the limit
        with pytest.raises(PreviewTransactionControl):
            await documents.insert_one({"_id": "second"})

    scope, error = await arun_preview([store], handler)
    assert error is None and scope.capture.fault is not None and "longer than" in str(scope.capture.fault)
    assert scope.store_changes == []  # the transaction was aborted: nothing to report, nothing to confirm
    assert reader["documents"].count_documents({}) == 0
    await client.close()

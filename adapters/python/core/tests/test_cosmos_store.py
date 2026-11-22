"""The Cosmos DB write guard (``cosmosdb_store``): replays the recorded requests of
``spec/data-stores/recordings/cosmosdb.json`` through the hook, and drives the real ``azure-cosmos``
client (synchronous and aio) against a local HTTP server that stands in for the account.

Cosmos DB has no compose service (its emulator is large and Linux x64 only), so every test runs
without Docker. ``test_without_the_hook_*`` shows the recording checks fail when the hook is missing.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("azure.cosmos")
from azure.core.pipeline.transport import HttpRequest, RequestsTransport  # noqa: E402
from azure.cosmos import CosmosClient  # noqa: E402

from sendproof_core import detached  # noqa: E402
from sendproof_core.stores import PreviewWriteBlocked, cosmosdb_store  # noqa: E402
from sendproof_core.stores.classify_batch_two import classify_cosmos  # noqa: E402
from store_support import active, db_entries, observed_scope, preview_scope  # noqa: E402

RECORDINGS = json.loads(
    (Path(__file__).resolve().parents[4] / "spec" / "data-stores" / "recordings" / "cosmosdb.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ the recordings
class FakeResponse:
    """What a transport answers: enough for the hook to log the reply."""

    status_code = 200

    def __init__(self) -> None:
        self.headers = {"x-ms-item-count": "2"}


class RecordingTransport:
    """A stand-in transport that remembers every request that reaches it."""

    def __init__(self) -> None:
        self.sent: list[Any] = []

    def send(self, request: Any, **kwargs: Any) -> Any:
        self.sent.append(request)
        return FakeResponse()


def build_request(http: dict) -> HttpRequest:
    body = http.get("body")
    return HttpRequest(http["method"], "https://acct.documents.azure.com:443" + http["path"],
                       headers=http.get("headers", {}), data=None if body is None else json.dumps(body))


def literals(value: Any) -> list[str]:
    """Every string and number in a recorded body, other than the structural keys."""
    if isinstance(value, dict):
        return [item for inner in value.values() for item in literals(inner)]
    if isinstance(value, list):
        return [item for inner in value for item in literals(inner)]
    return [str(value)] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else []


def replay_every_recording(hooked: bool) -> int:
    """Replay each recorded request through a (hooked) transport, with the assertions of recordings/README.md."""
    store = cosmosdb_store(name="orders")
    replayed = 0
    for recording in RECORDINGS["recordings"]:
        for entry in recording["requests"]:
            expected = entry["expect"]["http"]
            request = build_request(entry["http"])
            transport = RecordingTransport()
            if hooked:
                store.guard_transport(transport)
            with active(preview_scope()) as scope:
                if expected["kind"] == "write":
                    with pytest.raises(PreviewWriteBlocked) as blocked:
                        transport.send(request)
                    assert (blocked.value.store, blocked.value.operation) == ("cosmosdb", expected["operation"]), recording["name"]
                    assert transport.sent == [], f"{recording['name']}: a refused write reached the transport"
                    assert scope.capture.blocked["operation"] == expected["operation"]
                    assert db_entries(scope, "cosmosdb", expected["operation"])[0]["db"]["blocked"] is True
                else:
                    transport.send(request)
                    assert transport.sent == [request], f"{recording['name']}: a read must reach the transport unchanged"
                    assert scope.capture.blocked is None
                    if expected["kind"] == "read":
                        logged = db_entries(scope, "cosmosdb", expected["operation"])
                        assert len(logged) == 1, recording["name"]
                        assert logged[0]["db"]["rowsAffected"] == 2
                        statement = logged[0]["db"].get("statement", "")
                        values = [parameter.get("value") for parameter in (entry["http"].get("body") or {}).get("parameters", [])]
                        assert not any(value in statement for value in literals(values)), "parameter values never reach the Db entry"
            # Outside a Preview nothing is guarded: observed Send and plain requests go through, writes included.
            plain, observed = RecordingTransport(), RecordingTransport()
            if hooked:
                store.guard_transport(plain)
                store.guard_transport(observed)
            plain.send(build_request(entry["http"]))
            with active(observed_scope()):
                observed.send(build_request(entry["http"]))
            assert len(plain.sent) == 1 and len(observed.sent) == 1, recording["name"]
            replayed += 1
    return replayed


def test_every_recorded_request_is_classified_logged_and_refused_as_expected():
    recorded = sum(len(recording["requests"]) for recording in RECORDINGS["recordings"])
    assert replay_every_recording(hooked=True) == recorded >= 20


def test_without_the_hook_the_recording_checks_fail():
    """Removing the hook lets the first recorded write through, so the same assertions fail."""
    with pytest.raises(AssertionError):
        replay_every_recording(hooked=False)


def test_the_recordings_hold_reads_and_writes_and_the_sdk_level_expectations_agree():
    kinds = {entry["expect"]["http"]["kind"] for recording in RECORDINGS["recordings"] for entry in recording["requests"]}
    assert {"read", "write"} <= kinds
    for recording in RECORDINGS["recordings"]:
        for entry in recording["requests"]:
            sdk = entry["sdk"]
            headers = {name.lower() for name in entry["http"].get("headers", {})}
            triggers = bool(headers & {"x-ms-documentdb-pre-trigger-include", "x-ms-documentdb-post-trigger-include"})
            verdict = classify_cosmos(sdk["operationType"], triggers=triggers)
            assert (verdict.kind, verdict.operation) == (entry["expect"]["sdk"]["kind"], entry["expect"]["sdk"]["operation"]), recording["name"]


# ------------------------------------------------------------------ the real client
class Account(BaseHTTPRequestHandler):
    """A local HTTP server that answers like a Cosmos DB account, and remembers what it was sent."""

    requests: list[tuple[str, str]] = []

    def log_message(self, *args: Any) -> None:
        pass

    def respond(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        query = any((self.headers.get(name) or "").lower() == "true"
                    for name in ("x-ms-documentdb-isquery", "x-ms-cosmos-is-query-plan-request"))
        type(self).requests.append((self.command, self.path.split("?")[0].rstrip("/") or "/", query))
        here = f"http://127.0.0.1:{self.server.server_address[1]}/"
        if self.path == "/":
            body: dict = {"id": "acct", "writableLocations": [{"name": "x", "databaseAccountEndpoint": here}],
                          "readableLocations": [{"name": "x", "databaseAccountEndpoint": here}],
                          "enableMultipleWriteLocations": False, "userConsistencyPolicy": {"defaultConsistencyLevel": "Session"}}
        elif "/docs" in self.path and self.command == "POST":
            body = {"Documents": [{"id": "i"}], "_count": 1}
        else:
            body = {"id": "i", "partitionKey": {"paths": ["/pk"], "kind": "Hash"}}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header("x-ms-item-count", "1")
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = respond


@pytest.fixture
def account():
    """The local account's URL; ``Account.requests`` is cleared for the test."""
    Account.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Account)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()
        server.server_close()


def writes_seen() -> list:
    """Every request that reached the account and was not a read: queries are told apart by their headers."""
    return [seen[:2] for seen in Account.requests if seen[0] not in ("GET", "HEAD") and not seen[2]]


def test_the_client_ignores_per_call_policies_so_the_hook_is_a_transport(account):
    """The spike: ``CosmosClient`` builds a fixed policy list, so ``per_call_policies`` never runs and
    reaches the HTTP session as an unknown argument. The transport is the extension point it honours."""
    with pytest.raises(TypeError):
        CosmosClient(account, credential="a2V5", per_call_policies=[object()], connection_verify=False)


def test_the_real_client_reads_and_every_derived_proxy_stays_guarded(account):
    client = CosmosClient(account, credential="a2V5", connection_verify=False)
    store = cosmosdb_store(client, name="orders")
    database = client.get_database_client("db")
    container = database.get_container_client("c")  # derived after hooking
    derived_before = CosmosClient(account, credential="a2V5", connection_verify=False)
    early = derived_before.get_database_client("db").get_container_client("c")  # derived before hooking
    cosmosdb_store(derived_before)
    for proxy in (container, early):
        Account.requests.clear()
        with active(preview_scope()) as scope:
            assert proxy.read_item("i", partition_key="i")["id"] == "i"
            assert list(proxy.query_items("SELECT * FROM c WHERE c.a = 'secret'", enable_cross_partition_query=True))
            for refuse, operation in (
                (lambda: proxy.upsert_item({"id": "i", "pk": "i"}), "Upsert"),
                (lambda: proxy.create_item({"id": "i", "pk": "i"}), "Create"),
                (lambda: proxy.replace_item("i", {"id": "i", "pk": "i"}), "Replace"),
                (lambda: proxy.patch_item("i", "i", [{"op": "set", "path": "/a", "value": 1}]), "Patch"),
                (lambda: proxy.delete_item("i", partition_key="i"), "Delete"),
                (lambda: proxy.execute_item_batch([("create", ({"id": "b"},))], partition_key="i"), "Batch"),
                (lambda: proxy.scripts.execute_stored_procedure("readOnly", partition_key="i"), "ExecuteJavaScript"),
            ):
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    refuse()
                assert (blocked.value.store, blocked.value.operation) == ("cosmosdb", operation)
        assert writes_seen() == [] and not [r for r in Account.requests if r[0] == "POST" and r[1].endswith("/sprocs/readOnly")]
        assert scope.capture.blocked["operation"] == "Upsert"  # the first block wins
        queries = db_entries(scope, "cosmosdb", "Query")
        assert queries and queries[0]["db"]["target"] == "c" and queries[0]["db"]["namespace"] == "db"
        assert "secret" not in queries[0]["db"]["statement"] and "?" in queries[0]["db"]["statement"]
    assert store.describe() == {"system": "cosmosdb", "name": "orders", "mode": "guard"}


def test_outside_a_preview_the_hooked_client_writes_normally(account):
    client = CosmosClient(account, credential="a2V5", connection_verify=False)
    cosmosdb_store(client)
    container = client.get_database_client("db").get_container_client("c")
    container.upsert_item({"id": "i", "pk": "i"})
    scope = observed_scope()
    with active(scope):
        container.upsert_item({"id": "j", "pk": "j"})
    assert writes_seen() == [("POST", "/dbs/db/colls/c/docs")] * 2
    assert len(db_entries(scope, "cosmosdb", "Upsert")) == 1


def test_without_the_hook_the_same_writes_reach_the_account(account):
    """The control for ``writes_seen``: an unhooked client's write is seen, so an empty list proves a refusal."""
    container = CosmosClient(account, credential="a2V5", connection_verify=False).get_database_client("db").get_container_client("c")
    with active(preview_scope()):
        container.upsert_item({"id": "i", "pk": "i"})
        container.create_item({"id": "j", "pk": "j"})
        list(container.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    assert writes_seen() == [("POST", "/dbs/db/colls/c/docs")] * 2


def test_a_client_built_with_the_guarded_transport_is_guarded_from_its_first_request(account):
    store = cosmosdb_store(name="orders")
    client = CosmosClient(account, credential="a2V5", connection_verify=False, transport=store.guard_transport(RequestsTransport()))
    container = client.get_database_client("db").get_container_client("c")
    with active(preview_scope()):
        with pytest.raises(PreviewWriteBlocked):
            container.delete_item("i", partition_key="i")
    with pytest.raises(TypeError):  # a transport is hooked once, so a request is never logged twice
        store.guard_transport(client.client_connection.pipeline_client._pipeline._transport)


def test_hooking_a_client_twice_is_refused(account):
    client = CosmosClient(account, credential="a2V5", connection_verify=False)
    cosmosdb_store(client)
    with pytest.raises(TypeError, match="already hooked"):
        cosmosdb_store(client)
    with pytest.raises(TypeError):
        cosmosdb_store(object())  # no azure-core transport to guard: refused at registration, never left unguarded


def test_a_write_no_request_accounts_for_is_refused_before_it_is_sent(account):
    """A thread a handler started without its context (or the SDK's own hedging threads) carries no
    request: while a Preview is open its write is refused before sending and every open Preview is blocked."""
    client = CosmosClient(account, credential="a2V5", connection_verify=False)
    cosmosdb_store(client)
    container = client.get_database_client("db").get_container_client("c")
    refused: list = []

    def in_thread(body):
        def run() -> None:
            try:
                body()
            except PreviewWriteBlocked as error:
                refused.append(error.operation)
        thread = threading.Thread(target=run)
        thread.start()
        thread.join()

    with active(preview_scope()) as scope, active(preview_scope()) as other:
        in_thread(lambda: container.read_item("i", partition_key="i"))  # reads are never a problem
        in_thread(lambda: container.upsert_item({"id": "t", "pk": "t"}))
        assert refused == ["Upsert"]
        assert scope.capture.blocked["operation"] == other.capture.blocked["operation"] == "Upsert"
    assert writes_seen() == []
    with active(preview_scope()) as scope:  # background work the host marked is never refused
        def marked() -> None:
            with detached():
                container.upsert_item({"id": "t", "pk": "t"})
        in_thread(marked)
        assert scope.capture.fault is None and scope.capture.blocked is None
    assert len(writes_seen()) == 1


def test_registration_refuses_an_unsupported_version_or_a_client_whose_pipeline_differs(account, monkeypatch):
    from sendproof_core.stores import versions

    client = CosmosClient(account, credential="a2V5", connection_verify=False)
    with monkeypatch.context() as patch:
        patch.setattr(versions, "installed", lambda distribution: "4.18.0")
        with pytest.raises(TypeError, match="azure-cosmos>=4.17,<4.18"):
            cosmosdb_store(client)
    # A pipeline whose last step no longer sends through ``_transport``: guarding it would guard nothing.
    client.client_connection.pipeline_client._pipeline._transport = RequestsTransport()
    with pytest.raises(TypeError, match="azure-core transport"):
        cosmosdb_store(client)


def test_every_management_and_bulk_write_is_refused(account):
    client = CosmosClient.from_connection_string(f"AccountEndpoint={account};AccountKey=a2V5;", connection_verify=False)
    cosmosdb_store(client)
    database = client.get_database_client("db")
    container = database.get_container_client("c")
    with active(preview_scope()):
        for refuse in (
            lambda: container.delete_all_items_by_partition_key("i"),
            lambda: client.create_database("other"),
            lambda: client.delete_database("db"),
            lambda: database.create_container("new", partition_key=__import__("azure.cosmos").cosmos.PartitionKey("/pk")),
            lambda: database.replace_container(container, partition_key=__import__("azure.cosmos").cosmos.PartitionKey("/pk")),
            lambda: container.scripts.create_stored_procedure({"id": "p", "body": "function () {}"}),
            lambda: container.scripts.create_trigger({"id": "t", "body": "function () {}", "triggerType": "Pre", "triggerOperation": "All"}),
            lambda: database.create_user({"id": "u"}),
            lambda: container.upsert_item({"id": "i", "pk": "i"}, pre_trigger_include="audit"),
        ):
            with pytest.raises(PreviewWriteBlocked):
                refuse()
    assert writes_seen() == []


def test_the_aio_client_is_guarded_too(account):
    from azure.cosmos.aio import CosmosClient as AsyncCosmosClient

    async def run() -> None:
        async with AsyncCosmosClient(account, credential="a2V5", connection_verify=False) as client:
            cosmosdb_store(client, name="orders")
            container = client.get_database_client("db").get_container_client("c")
            with active(preview_scope()) as scope:
                assert (await container.read_item("i", partition_key="i"))["id"] == "i"
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    await container.upsert_item({"id": "i", "pk": "i"})
                assert blocked.value.operation == "Upsert"
                with pytest.raises(PreviewWriteBlocked):
                    await container.delete_item("i", partition_key="i")
            assert scope.capture.blocked["operation"] == "Upsert"
            assert db_entries(scope, "cosmosdb", "Read")

    asyncio.run(run())
    assert writes_seen() == []

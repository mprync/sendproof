"""The Firestore write guard (``firestore_store``): replays the recorded requests of
``spec/data-stores/recordings/firestore.json`` through the gRPC interceptor, and drives the real
``google-cloud-firestore`` clients (synchronous and asynchronous) against a local gRPC server that
stands in for the emulator.

Firestore has no compose service (its emulator needs a Java and gcloud toolchain), so every test
runs without Docker. ``test_without_the_hook_*`` shows the recording checks fail without the hook.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections import namedtuple
from concurrent import futures
from pathlib import Path
from typing import Any

import pytest

grpc = pytest.importorskip("grpc")
firestore = pytest.importorskip("google.cloud.firestore")
from google.cloud.firestore_v1 import types  # noqa: E402

from sendproof_core import detached  # noqa: E402
from sendproof_core.stores import PreviewWriteBlocked, firestore_store  # noqa: E402
from store_support import active, db_entries, observed_scope, preview_scope  # noqa: E402

RECORDINGS = json.loads(
    (Path(__file__).resolve().parents[4] / "spec" / "data-stores" / "recordings" / "firestore.json").read_text(encoding="utf-8"))
SERVER_STREAMING = {"BatchGetDocuments", "RunQuery", "RunAggregationQuery"}
BIDIRECTIONAL = {"Listen", "Write"}
Details = namedtuple("Details", "method")


def message_of(rpc: str, rest: dict) -> Any:
    """The request message of a recorded call: the proto3 JSON body parsed into the SDK's own request type."""
    kind = getattr(types, rpc.rsplit("/", 1)[1] + "Request")
    body = rest.get("body")
    return kind() if body is None else kind.from_json(json.dumps(body), ignore_unknown_fields=True)


class Channel:
    """What the interceptor wraps: remembers each call that is continued, as a real channel would send it."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    def continuation(self, details: Any, request: Any) -> Any:
        self.sent.append(details.method)
        return "reply"


def call_through(interceptor: Any, channel: Channel, rpc: str, message: Any) -> Any:
    """Make the call the way grpc's channel shape for ``rpc`` does, through the synchronous interceptor."""
    method = rpc.rsplit("/", 1)[1]
    details = Details(rpc)
    if method in BIDIRECTIONAL:
        return interceptor.intercept_stream_stream(channel.continuation, details, iter([message]))
    if method in SERVER_STREAMING:
        return interceptor.intercept_unary_stream(channel.continuation, details, message)
    return interceptor.intercept_unary_unary(channel.continuation, details, message)


def replay_every_recording(hooked: bool) -> int:
    """Replay each recorded request, with the assertions of recordings/README.md. ``hooked=False`` skips the interceptor."""
    store = firestore_store_without_client()
    interceptor = store._interceptor(False) if hooked else PassThrough()
    replayed = 0
    for recording in RECORDINGS["recordings"]:
        for entry in recording["requests"]:
            expected, rpc = entry["expect"], entry["rpc"]
            message = message_of(rpc, entry["rest"])
            channel = Channel()
            with active(preview_scope()) as scope:
                if expected["kind"] == "write":
                    with pytest.raises(PreviewWriteBlocked) as blocked:
                        call_through(interceptor, channel, rpc, message)
                    assert (blocked.value.store, blocked.value.operation) == ("firestore", expected["operation"]), recording["name"]
                    assert channel.sent == [], f"{recording['name']}: a refused write reached the channel"
                    assert scope.capture.blocked["operation"] == expected["operation"]
                else:
                    assert call_through(interceptor, channel, rpc, message) == "reply"
                    assert channel.sent == [rpc], f"{recording['name']}: a read must reach the channel"
                    assert scope.capture.blocked is None
                    if expected["kind"] == "read":
                        logged = db_entries(scope, "firestore", expected["operation"])
                        assert len(logged) == 1, recording["name"]
                        assert "statement" not in logged[0]["db"], "Firestore entries name collections, never values"
            plain, observed = Channel(), Channel()
            call_through(interceptor, plain, rpc, message)
            with active(observed_scope()):
                call_through(interceptor, observed, rpc, message)
            assert plain.sent == [rpc] and observed.sent == [rpc], recording["name"]
            replayed += 1
    return replayed


class PassThrough:
    """The interceptor interface with no hook: what a client without ``firestore_store`` amounts to."""

    def intercept_unary_unary(self, continuation: Any, details: Any, request: Any) -> Any:
        return continuation(details, request)

    intercept_unary_stream = intercept_unary_unary
    intercept_stream_stream = intercept_unary_unary


def firestore_store_without_client():
    """A store that guards nothing yet, for its interceptor; the real clients are hooked in the other tests."""
    from sendproof_core.stores.firestore_hook import FirestoreStore

    return FirestoreStore("profiles", None)


def test_every_recorded_call_is_classified_logged_and_refused_as_expected():
    recorded = sum(len(recording["requests"]) for recording in RECORDINGS["recordings"])
    assert replay_every_recording(hooked=True) == recorded >= 15


def test_without_the_hook_the_recording_checks_fail():
    with pytest.raises(AssertionError):
        replay_every_recording(hooked=False)


def test_the_recordings_hold_reads_writes_and_a_commit_that_writes_nothing():
    kinds = {entry["expect"]["kind"] for recording in RECORDINGS["recordings"] for entry in recording["requests"]}
    assert kinds == {"read", "write", "session"}


def test_unary_and_streaming_calls_are_all_covered_and_a_write_stream_is_refused_before_its_first_message():
    interceptor = firestore_store_without_client()._interceptor(False)
    channel = Channel()
    consumed: list = []

    def messages():
        consumed.append("first message read")
        yield types.WriteRequest()

    with active(preview_scope()) as scope:
        with pytest.raises(PreviewWriteBlocked) as blocked:
            interceptor.intercept_stream_stream(channel.continuation, Details("/google.firestore.v1.Firestore/Write"), messages())
        assert blocked.value.operation == "Write"
        # Listen is a read stream; BeginTransaction and Rollback are allowed and not logged.
        interceptor.intercept_stream_stream(channel.continuation, Details("/google.firestore.v1.Firestore/Listen"), iter([]))
        interceptor.intercept_unary_unary(channel.continuation, Details("/google.firestore.v1.Firestore/BeginTransaction"), types.BeginTransactionRequest())
        interceptor.intercept_unary_unary(channel.continuation, Details("/google.firestore.v1.Firestore/Rollback"), types.RollbackRequest())
        assert consumed == [] and channel.sent == ["/google.firestore.v1.Firestore/Listen", "/google.firestore.v1.Firestore/BeginTransaction",
                                                   "/google.firestore.v1.Firestore/Rollback"]
        assert [entry["db"]["operation"] for entry in scope.capture._logs if entry["level"] == "Db"] == ["Write", "Listen"]
        with pytest.raises(PreviewWriteBlocked):  # a stream-unary call is a write unless the table lists it
            interceptor.intercept_stream_unary(channel.continuation, Details("/google.firestore.v1.Firestore/Future"), iter([]))


# ------------------------------------------------------------------ the real clients
def handler(shape: str, name: str, seen: list):
    def record(*args: Any) -> Any:
        seen.append(name)
        return b""

    if shape == "unary":
        return grpc.unary_unary_rpc_method_handler(record, request_deserializer=None, response_serializer=None)
    if shape == "server":
        def stream(request: Any, context: Any) -> Any:
            seen.append(name)
            yield b""
        return grpc.unary_stream_rpc_method_handler(stream, request_deserializer=None, response_serializer=None)

    def bidi(requests: Any, context: Any) -> Any:
        seen.append(name)
        for _ in requests:
            yield b""
    return grpc.stream_stream_rpc_method_handler(bidi, request_deserializer=None, response_serializer=None)


@pytest.fixture
def emulator(monkeypatch):
    """A local gRPC server that answers every Firestore method with an empty message and lists what reached it."""
    seen: list[str] = []
    handlers = {name: handler("unary", name, seen) for name in (
        "GetDocument", "ListDocuments", "UpdateDocument", "DeleteDocument", "BeginTransaction", "Commit", "Rollback",
        "BatchWrite", "ListCollectionIds", "CreateDocument", "PartitionQuery")}
    handlers.update({name: handler("server", name, seen) for name in ("BatchGetDocuments", "RunQuery", "RunAggregationQuery")})
    handlers.update({name: handler("bidi", name, seen) for name in ("Write", "Listen")})
    server = grpc.server(futures.ThreadPoolExecutor(4))
    server.add_generic_rpc_handlers((grpc.method_handlers_generic_handler("google.firestore.v1.Firestore", handlers),))
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", f"127.0.0.1:{port}")
    try:
        yield seen
    finally:
        server.stop(0)


def attempt(call: Any) -> str:
    try:
        call()
    except PreviewWriteBlocked as blocked:
        return "blocked " + blocked.operation
    except Exception:  # the empty replies of the stand-in server are not valid answers for every call
        return "ran"
    return "ran"


def test_the_real_client_runs_reads_and_refuses_every_write_before_it_is_sent(emulator):
    client = firestore.Client(project="bench")
    list(client.collection("warm").limit(1).stream())  # used before it is hooked: it is rebuilt guarded
    emulator.clear()
    store = firestore_store(client, name="profiles")
    orders = client.collection("orders")
    batch = client.batch()
    batch.set(orders.document("b"), {"x": 1})

    @firestore.transactional
    def write_in_transaction(transaction: Any) -> None:
        transaction.set(orders.document("t"), {"x": 1})

    with active(preview_scope()) as scope:
        assert attempt(lambda: list(orders.where(filter=firestore.FieldFilter("a", "==", 1)).stream())) == "ran"
        assert attempt(lambda: orders.count().get()) == "ran"
        assert attempt(lambda: list(client.collections())) == "ran"
        assert attempt(lambda: list(client.get_all([orders.document("o1")]))) == "ran"
        assert emulator == ["RunQuery", "RunAggregationQuery", "ListCollectionIds", "BatchGetDocuments"]
        emulator.clear()
        for write in (
            lambda: orders.document("o1").set({"a": 1}), lambda: orders.document("o1").update({"a": 2}),
            lambda: orders.document("o1").delete(), lambda: orders.add({"a": 3}), batch.commit,
            lambda: write_in_transaction(client.transaction()),
        ):
            assert attempt(write) == "blocked Commit"
        assert [name for name in emulator if name != "BeginTransaction" and name != "Rollback"] == [], emulator
        assert scope.capture.blocked["operation"] == "Commit" and scope.capture.blocked["store"] == "firestore"
        reads = db_entries(scope, "firestore", "RunQuery")
        assert reads[0]["db"]["target"] == "orders" and reads[0]["db"]["namespace"] == "(default)"
        assert "statement" not in reads[0]["db"]
    assert store.describe() == {"system": "firestore", "name": "profiles", "mode": "guard"}


def test_without_the_hook_the_real_clients_write_reaches_the_server(emulator):
    """The control for the test above: an unhooked client sends the same write."""
    client = firestore.Client(project="bench")
    with active(preview_scope()):
        attempt(lambda: client.collection("orders").document("o1").set({"a": 1}))
    assert "Commit" in emulator


def test_outside_a_preview_the_hooked_client_writes_and_logs_observed_sends(emulator):
    client = firestore.Client(project="bench")
    firestore_store(client)
    attempt(lambda: client.collection("orders").document("o1").set({"a": 1}))
    scope = observed_scope()
    with active(scope):
        attempt(lambda: client.collection("orders").document("o2").set({"a": 1}))
    assert emulator.count("Commit") == 2
    assert [e["db"]["target"] for e in scope.capture._logs if e["level"] == "Db"] == ["orders"]


def test_a_write_stream_on_a_real_channel_is_refused_before_any_message(emulator):
    client = firestore.Client(project="bench")
    firestore_store(client)
    stream = client._firestore_api.transport.write
    with active(preview_scope()) as scope:
        # grpc hands an interceptor's exception back as the call's outcome, which raises when it is consumed.
        with pytest.raises(PreviewWriteBlocked) as blocked:
            for _ in stream(iter([types.WriteRequest()])):
                pass
        assert blocked.value.operation == "Write"
        assert scope.capture.blocked["operation"] == "Write"
    assert "Write" not in emulator


def test_the_bulk_writers_threads_have_no_request_so_they_fail_the_preview(emulator):
    """``bulk_writer`` sends ``BatchWrite`` from its own threads, which carry no request context: the write
    can't be refused there, so the Preview must fail instead of claiming a rollback."""
    client = firestore.Client(project="bench")
    firestore_store(client)
    with active(preview_scope()) as scope:
        writer = client.bulk_writer()
        writer.set(client.collection("orders").document("bulk"), {"x": 1})
        writer.close()
        assert isinstance(scope.capture.fault, Exception) and "outside any request" in str(scope.capture.fault)
    with active(preview_scope()) as scope:
        def marked() -> None:
            with detached():
                client.collection("orders").document("bg").set({"x": 1})
        thread = threading.Thread(target=marked)
        thread.start()
        thread.join()
        assert scope.capture.fault is None


def test_hooking_a_client_twice_is_refused_and_only_firestore_clients_are_accepted(emulator):
    client = firestore.Client(project="bench")
    firestore_store(client)
    with pytest.raises(TypeError, match="already hooked"):
        firestore_store(client)
    with pytest.raises(TypeError):
        firestore_store(object())


def test_the_async_client_and_its_synchronous_copy_are_guarded(emulator):
    async def run() -> None:
        client = firestore.AsyncClient(project="bench")
        firestore_store(client, name="profiles")
        orders = client.collection("orders")
        with active(preview_scope()) as scope:
            async for _ in orders.limit(1).stream():
                pass
            for write in (lambda: orders.document("o1").set({"a": 1}), lambda: orders.document("o1").delete(),
                          lambda: orders.add({"a": 1})):
                with pytest.raises(PreviewWriteBlocked) as blocked:
                    await write()
                assert blocked.value.operation == "Commit"
            with pytest.raises(PreviewWriteBlocked) as blocked:
                async for _ in client._firestore_api.transport.write(iter([types.WriteRequest()])):
                    pass
            assert blocked.value.operation == "Write"
            assert db_entries(scope, "firestore", "RunQuery")
            assert scope.capture.blocked["operation"] == "Commit"
        # The synchronous copy ``bulk_writer`` uses is guarded as well.
        with active(preview_scope()):
            with pytest.raises(PreviewWriteBlocked):
                client._to_sync_copy().collection("orders").document("c").set({"a": 1})

    asyncio.run(run())
    assert [name for name in emulator if name not in ("RunQuery",)] == []

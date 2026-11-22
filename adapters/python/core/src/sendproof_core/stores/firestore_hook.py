"""Sendproof write guard for Google Cloud Firestore (``spec/data-stores.md``, ``guard`` mode).

``firestore_store(client)`` guards a ``google-cloud-firestore`` 2 ``Client`` or ``AsyncClient`` in
place with a **gRPC channel interceptor**, the hook that sees every call type:

* The interceptor covers unary calls (``Commit``, ``GetDocument``, ``BeginTransaction``...),
  server-streaming calls (``RunQuery``, ``BatchGetDocuments``) **and** bidirectional streams
  (``Listen``, ``Write``). A ``Write`` stream is refused when it is opened, before its first message,
  so a unary-only interceptor could not have let it through.
* A call is classified by its RPC method with ``firestore.json``. ``Commit`` is a write when its
  request carries at least one write; one with none only ends a transaction that read and wrote
  nothing, so it is allowed. ``BatchWrite`` and the document RPCs are writes. A method the table
  doesn't list is a write.
* Reads run and become a ``Db`` entry that names the RPC, the collection and the database, with the
  request as JSON whose every literal, document paths included, is ``?``. In a Preview the first write
  raises :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409.
* ``bulk_writer()`` returns a writer whose ``create``, ``set``, ``update`` and ``delete`` are refused in
  a Preview where the handler queues them, on its thread: refusing the batch on the writer's own
  threads would be retried until ``flush()`` hangs. Its batches run in the flushing code's context.

The hook overrides private methods, so registration refuses a ``google-cloud-firestore`` outside
the verified minor versions (:mod:`sendproof_core.stores.versions`) or a client whose layout differs.

How it is installed: ``Client`` takes no transport, and the GAPIC transport builds all its stubs
from the channel it is given, so the hook swaps the client's class for a subclass whose
``_firestore_api_helper`` builds the transport over an intercepted channel
(``grpc.intercept_channel`` for ``Client``, a channel created with ``interceptors=`` for
``AsyncClient``). ``_firestore_api_internal`` is cleared so a client already used is rebuilt guarded
at its next call. Every collection, document, query, batch, transaction and ``bulk_writer`` made
from the client reaches Firestore through ``client._firestore_api``, so they stay guarded; an
``AsyncClient``'s synchronous copy (used by ``bulk_writer``) is guarded too. A second ``Client`` is
not covered unless it is hooked as well.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import inspect
import json
import re
import time
from typing import Any, Iterable, Optional

from .base import DataStore
from .classify import SESSION, WRITE
from .classify_batch_two import classify_firestore
from .guard import check_command, read_set, sanitize_document, store_label
from .versions import require_supported

_DATABASE = re.compile(r"(?:^|/)databases/([^/]+)")


def _field(message: Any, name: str) -> Any:
    """A request field by name, from a proto-plus or protobuf message or a mapping; ``None`` when absent."""
    try:
        if isinstance(message, dict):
            return message.get(name)
        return getattr(message, name, None)
    except Exception:  # a field the message class doesn't have
        return None


def _collection_of(document_name: Any) -> Optional[str]:
    """The collection id in a document name (``projects/p/databases/d/documents/orders/o-1`` is ``orders``)."""
    if not isinstance(document_name, str) or "/documents/" not in document_name:
        return None
    parts = [part for part in document_name.split("/documents/", 1)[1].split("/") if part]
    return parts[-2] if len(parts) >= 2 else (parts[0] if parts else None)


def describe_request(message: Any) -> tuple[Optional[str], Optional[str]]:
    """``(collection, database)`` a request names, for the ``Db`` entry. Names only, never a value."""
    if message is None:
        return None, None
    database = None
    for name in ("database", "parent", "name"):
        found = _DATABASE.search(str(_field(message, name) or ""))
        if found:
            database = found.group(1)
            break
    collection = None
    writes = _field(message, "writes")
    try:
        first = writes[0] if writes else None
    except (TypeError, IndexError, KeyError):
        first = None
    if first is not None:
        for name in ("update", "transform"):
            part = _field(first, name)
            collection = _collection_of(_field(part, "name") or _field(part, "document")) if part is not None else None
            if collection:
                break
        collection = collection or _collection_of(_field(first, "delete"))
    if collection is None:
        collection = _collection_of(_field(message, "name"))
    if collection is None:
        documents = _field(message, "documents")
        try:
            collection = _collection_of(documents[0]) if documents else None
        except (TypeError, IndexError, KeyError):
            collection = None
    if collection is None:
        query = _field(message, "structured_query")
        if query is None:
            query = _field(_field(message, "structured_aggregation_query"), "structured_query")
        sources = _field(query, "from_") or _field(query, "from") if query is not None else None
        try:
            collection = _field(sources[0], "collection_id") if sources else None
        except (TypeError, IndexError, KeyError):
            collection = None
    return collection or _field(message, "collection_id") or None, database


def describe_statement(message: Any) -> Optional[str]:
    """The ``Db`` statement of a request: the message as JSON with every literal, document paths
    included, replaced by ``"?"``. Field names are kept; ``None`` when the message can't be read."""
    if message is None:
        return None
    try:
        to_dict = getattr(type(message), "to_dict", None)  # a proto-plus message
        if callable(to_dict):
            data = to_dict(message, use_integers_for_enums=False)
        else:
            from google.protobuf.json_format import MessageToDict

            data = MessageToDict(message)
        return json.dumps(sanitize_document(data), separators=(",", ":")) if data else None
    except Exception:  # an unknown message shape: log the call without a statement rather than fail it
        return None


class _Guard:
    """Classifies one call and writes its ``Db`` entry. Shared by the synchronous and asynchronous interceptors."""

    def __init__(self, store: "FirestoreStore") -> None:
        self.store = store

    def before(self, method: Any, message: Any) -> Optional[tuple]:
        """Classify the call, refuse a write in a Preview, and return what the ``Db`` entry needs."""
        text = method.decode() if isinstance(method, (bytes, bytearray)) else str(method)
        verdict = classify_firestore(text, message, self.store._reads)
        scope = check_command("firestore", verdict.operation, verdict.kind)
        if scope is None or verdict.kind == SESSION:
            return None  # outside a request, or a call that changes no data and isn't logged
        collection, database = describe_request(message)
        return scope, verdict, collection, database, describe_statement(message), time.perf_counter()

    @staticmethod
    def after(pending: Optional[tuple], outcome: Any) -> None:
        """Log the call. A streaming call is logged when it is opened, so its entry has no error or timing."""
        if pending is None:
            return
        scope, verdict, collection, database, statement, began = pending
        error = None
        try:
            import grpc

            if isinstance(outcome, grpc.RpcError) and callable(getattr(outcome, "code", None)):
                code = outcome.code()
                error = None if code is None or code == grpc.StatusCode.OK else code.name
        except Exception:
            error = None
        scope.capture.record_db("firestore", verdict.operation, target=collection, namespace=database, statement=statement,
                                error=error, elapsed_ms=(time.perf_counter() - began) * 1000)


def _sync_interceptor(guard: _Guard) -> Any:
    """A ``grpc`` client interceptor for all four call shapes."""
    import grpc

    class Interceptor(grpc.UnaryUnaryClientInterceptor, grpc.UnaryStreamClientInterceptor,
                      grpc.StreamUnaryClientInterceptor, grpc.StreamStreamClientInterceptor):
        _sendproof_guard = guard

        def intercept_unary_unary(self, continuation: Any, client_call_details: Any, request: Any) -> Any:
            pending = guard.before(client_call_details.method, request)
            outcome = continuation(client_call_details, request)
            guard.after(pending, outcome)
            return outcome

        def intercept_unary_stream(self, continuation: Any, client_call_details: Any, request: Any) -> Any:
            pending = guard.before(client_call_details.method, request)
            outcome = continuation(client_call_details, request)
            guard.after(pending, None)
            return outcome

        def intercept_stream_unary(self, continuation: Any, client_call_details: Any, request_iterator: Any) -> Any:
            pending = guard.before(client_call_details.method, None)  # refused before the first message is read
            outcome = continuation(client_call_details, request_iterator)
            guard.after(pending, None)
            return outcome

        def intercept_stream_stream(self, continuation: Any, client_call_details: Any, request_iterator: Any) -> Any:
            pending = guard.before(client_call_details.method, None)  # Write is refused before its first message
            outcome = continuation(client_call_details, request_iterator)
            guard.after(pending, None)
            return outcome

    return Interceptor()


def _async_interceptors(guard: _Guard) -> list:
    """The four ``grpc.aio`` client interceptors, one per call shape.

    ``grpc.aio`` registers an interceptor for **one** shape, the first it is an instance of, so a
    single object inheriting all four would guard unary calls only and let a ``Write`` stream through.
    """
    from grpc import aio

    class UnaryUnary(aio.UnaryUnaryClientInterceptor):
        async def intercept_unary_unary(self, continuation: Any, client_call_details: Any, request: Any) -> Any:
            pending = guard.before(client_call_details.method, request)
            outcome = await continuation(client_call_details, request)
            guard.after(pending, None)
            return outcome

    class UnaryStream(aio.UnaryStreamClientInterceptor):
        async def intercept_unary_stream(self, continuation: Any, client_call_details: Any, request: Any) -> Any:
            pending = guard.before(client_call_details.method, request)
            outcome = await continuation(client_call_details, request)
            guard.after(pending, None)
            return outcome

    class StreamUnary(aio.StreamUnaryClientInterceptor):
        async def intercept_stream_unary(self, continuation: Any, client_call_details: Any, request_iterator: Any) -> Any:
            pending = guard.before(client_call_details.method, None)
            outcome = await continuation(client_call_details, request_iterator)
            guard.after(pending, None)
            return outcome

    class StreamStream(aio.StreamStreamClientInterceptor):
        async def intercept_stream_stream(self, continuation: Any, client_call_details: Any, request_iterator: Any) -> Any:
            pending = guard.before(client_call_details.method, None)
            outcome = await continuation(client_call_details, request_iterator)
            guard.after(pending, None)
            return outcome

    return [UnaryUnary(), UnaryStream(), StreamUnary(), StreamStream()]


_HOOKED = "_sendproof_firestore_store"
_bulk_writer_classes: dict[tuple[type, int], type] = {}


class _ContextExecutor(concurrent.futures.ThreadPoolExecutor):
    """A thread pool that runs each task in the context of the code that submitted it.

    ``BulkWriter`` submits its batches from the thread that queued or flushed them, so its sends
    keep that request's attribution instead of arriving with none.
    """

    def submit(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:  # type: ignore[override]
        return super().submit(contextvars.copy_context().run, fn, *args, **kwargs)


def _guarded_bulk_writer_class(base: type, store: "FirestoreStore") -> type:
    """A ``BulkWriter`` subclass whose writes are refused in a Preview before they are queued."""

    def guarded(name: str) -> Any:
        original = getattr(base, name)

        def method(self: Any, *args: Any, **kwargs: Any) -> Any:
            check_command("firestore", "BatchWrite", WRITE)
            return original(self, *args, **kwargs)

        method.__name__ = name
        return method

    namespace: dict[str, Any] = {name: guarded(name) for name in ("create", "set", "update", "delete")}
    namespace.update({"_instantiate_executor": lambda self: _ContextExecutor(), _HOOKED: store, "__module__": __name__})
    return type(f"Guarded{base.__name__}", (base,), namespace)


def _check_layout(base: type, asynchronous: bool) -> None:
    """Refuse a client class whose private layout isn't the one the hook overrides."""
    from google.cloud.firestore_v1 import base_client

    problems = []
    helper = getattr(base, "_firestore_api_helper", None)
    try:
        parameters = list(inspect.signature(helper).parameters) if callable(helper) else []
    except (TypeError, ValueError):
        parameters = []
    if parameters != ["self", "transport", "client_class", "client_module"]:
        problems.append("_firestore_api_helper(transport, client_class, client_module)")
    if not hasattr(base, "_firestore_api_internal"):
        problems.append("_firestore_api_internal")
    if not callable(getattr(base, "bulk_writer", None)):
        problems.append("bulk_writer")
    if asynchronous:
        problems += [name for name in ("_emulator_channel", "_to_sync_copy") if not callable(getattr(base, name, None))]
        if not hasattr(base_client, "_GRPC_MSG_SIZE_OPTIONS"):
            problems.append("base_client._GRPC_MSG_SIZE_OPTIONS")
    if problems:
        raise TypeError(f"This google-cloud-firestore client has no {', '.join(problems)}; firestore_store can't guard it.")


class FirestoreStore(DataStore):
    """A hooked Firestore client, ready for ``data_stores``."""

    system = "firestore"

    def __init__(self, name: Optional[str], reads: Optional[frozenset[str]]) -> None:
        self.name = name
        self._reads = reads
        self._guard = _Guard(self)
        self._sync = None
        self._async: Optional[list] = None

    def describe(self) -> dict[str, Any]:
        return {"system": "firestore", **({"name": self.name} if self.name else {}), "mode": "guard"}

    def _interceptor(self, asynchronous: bool) -> Any:
        """The synchronous interceptor, or the list of the four asynchronous ones."""
        if asynchronous:
            if self._async is None:
                self._async = _async_interceptors(self._guard)
            return self._async
        if self._sync is None:
            self._sync = _sync_interceptor(self._guard)
        return self._sync

    # ------------------------------------------------------------------ transports
    def _guarded_transport(self, transport: type, asynchronous: bool) -> type:
        """A subclass of the GAPIC gRPC transport that builds all its stubs over an intercepted channel."""
        import grpc

        store = self
        if not asynchronous:
            class SyncTransport(transport):  # type: ignore[valid-type, misc]
                def __init__(self, *args: Any, channel: Any = None, **kwargs: Any) -> None:
                    if not isinstance(channel, grpc.Channel):
                        raise TypeError("firestore_store needs the client's own gRPC channel to guard it.")
                    super().__init__(*args, channel=grpc.intercept_channel(channel, store._interceptor(False)), **kwargs)

            SyncTransport.__name__ = SyncTransport.__qualname__ = f"Guarded{transport.__name__}"
            return SyncTransport

        class AsyncTransport(transport):  # type: ignore[valid-type, misc]
            @classmethod
            def create_channel(cls, *args: Any, **kwargs: Any) -> Any:
                kwargs["interceptors"] = [*(kwargs.get("interceptors") or ()), *store._interceptor(True)]
                return super().create_channel(*args, **kwargs)

            def __init__(self, *args: Any, channel: Any = None, **kwargs: Any) -> None:
                # Every call shape must carry its interceptor. A channel whose layout differs, or one
                # built without them, is refused rather than used unguarded.
                ours = store._interceptor(True)
                for shape, interceptor in zip(("unary_unary", "unary_stream", "stream_unary", "stream_stream"), ours):
                    found = getattr(channel, f"_{shape}_interceptors", None)
                    if not isinstance(found, list) or interceptor not in found:
                        raise TypeError("firestore_store needs the client's channel to carry its interceptors.")
                super().__init__(*args, channel=channel, **kwargs)

        AsyncTransport.__name__ = AsyncTransport.__qualname__ = f"Guarded{transport.__name__}"
        return AsyncTransport

    def _guarded_client_class(self, base: type, asynchronous: bool) -> type:
        store = self

        def _firestore_api_helper(self: Any, transport: type, client_class: Any, client_module: Any) -> Any:
            return base._firestore_api_helper(self, store._guarded_transport(transport, asynchronous), client_class, client_module)

        def bulk_writer(self: Any, *args: Any, **kwargs: Any) -> Any:
            return store._guard_bulk_writer(base.bulk_writer(self, *args, **kwargs))

        namespace: dict[str, Any] = {"_firestore_api_helper": _firestore_api_helper, "bulk_writer": bulk_writer,
                                     "__module__": __name__, _HOOKED: self}

        if asynchronous:
            def _emulator_channel(self: Any, transport: type) -> Any:
                # An asynchronous channel takes its interceptors when it is created.
                import grpc
                from google.cloud.firestore_v1.base_client import _GRPC_MSG_SIZE_OPTIONS

                token = getattr(self._credentials, "id_token", None) if self._credentials is not None else None
                options = [("Authorization", f"Bearer {token or 'owner'}"), *_GRPC_MSG_SIZE_OPTIONS]
                return grpc.aio.insecure_channel(self._emulator_host, options=options, interceptors=store._interceptor(True))

            def _to_sync_copy(self: Any) -> Any:
                copy = base._to_sync_copy(self)
                if getattr(type(copy), _HOOKED, None) is None:
                    store.guard_client(copy)
                return copy

            namespace["_emulator_channel"] = _emulator_channel
            namespace["_to_sync_copy"] = _to_sync_copy
        return type(f"Guarded{base.__name__}", (base,), namespace)

    def _guard_bulk_writer(self, writer: Any) -> Any:
        """Guard a ``BulkWriter``: refuse its writes where the handler queues them, and send its batches
        in the context of the code that flushed them.

        A ``BulkWriter`` sends ``BatchWrite`` from its own executor threads. Refusing there would leave
        the refused batch counted in flight, and enough of those stall ``flush()`` for good, so in a
        Preview ``create``, ``set``, ``update`` and ``delete`` are refused before anything is queued.
        Outside a Preview its batches run in the flushing code's context, so an observed Send logs them.
        """
        base = type(writer)
        if getattr(base, _HOOKED, None) is not None:
            return writer
        missing = [name for name in ("create", "set", "update", "delete", "_executor") if not hasattr(writer, name)]
        if missing:
            raise TypeError(f"This google-cloud-firestore BulkWriter has no {', '.join(missing)}; firestore_store can't guard it.")
        guarded = _bulk_writer_classes.get((base, id(self)))
        if guarded is None:
            guarded = _bulk_writer_classes[(base, id(self))] = _guarded_bulk_writer_class(base, self)
        previous = writer._executor
        writer.__class__ = guarded
        writer._executor = _ContextExecutor()
        previous.shutdown(wait=False)
        return writer

    # ------------------------------------------------------------------ hooking
    def guard_client(self, client: Any) -> None:
        """Guard a Firestore client in place. Hooking a client twice is refused.

        The hook overrides private methods of the client, so a version outside the verified range
        (:data:`~sendproof_core.stores.versions.SUPPORTED`) or a client whose layout differs is refused here.
        """
        from google.cloud.firestore_v1.async_client import AsyncClient
        from google.cloud.firestore_v1.client import Client

        if getattr(type(client), _HOOKED, None) is not None:
            raise TypeError("This Firestore client is already hooked by firestore_store.")
        if isinstance(client, AsyncClient):
            asynchronous = True
        elif isinstance(client, Client):
            asynchronous = False
        else:
            raise TypeError("firestore_store takes a google-cloud-firestore Client or AsyncClient.")
        require_supported("google-cloud-firestore", "firestore_store")
        _check_layout(type(client), asynchronous)
        client.__class__ = self._guarded_client_class(type(client), asynchronous)
        previous = getattr(client, "_firestore_api_internal", None)
        if previous is not None:  # already used: rebuild it over a guarded channel at the next call
            client._firestore_api_internal = None
            if not asynchronous:
                try:
                    previous.transport.close()
                except Exception:
                    pass


def firestore_store(client: Any, *, name: Optional[str] = None, treat_as_read: Optional[Iterable[str]] = None) -> FirestoreStore:
    """Hook a ``google-cloud-firestore`` 2 ``Client`` or ``AsyncClient`` in place and return the store for ``data_stores``.

    Hooking the same client twice is refused. Hook the client before you hand it to code that
    keeps a reference to ``client._firestore_api``.

    Args:
        name: A display label for discovery, such as ``profiles``. Never a project id or host name.
        treat_as_read: RPC method names you state never write, such as ``ExecutePipeline``: exact
            names, no wildcards. **The guard trusts this list**: a listed method that does write is not blocked.
    """
    store = FirestoreStore(store_label(name), read_set(treat_as_read))
    store.guard_client(client)
    return store

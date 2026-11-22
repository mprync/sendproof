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
* Reads run and become a ``Db`` entry that names the RPC, the collection and the database, never a
  value. In a Preview the first write raises
  :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409.

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

import re
import time
from typing import Any, Iterable, Optional

from .base import DataStore
from .classify import SESSION
from .classify_batch_two import classify_firestore
from .guard import check_command, read_set, store_label

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
        return scope, verdict, collection, database, time.perf_counter()

    @staticmethod
    def after(pending: Optional[tuple], outcome: Any) -> None:
        """Log the call. A streaming call is logged when it is opened, so its entry has no error or timing."""
        if pending is None:
            return
        scope, verdict, collection, database, began = pending
        error = None
        try:
            import grpc

            if isinstance(outcome, grpc.RpcError) and callable(getattr(outcome, "code", None)):
                code = outcome.code()
                error = None if code is None or code == grpc.StatusCode.OK else code.name
        except Exception:
            error = None
        scope.capture.record_db("firestore", verdict.operation, target=collection, namespace=database,
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
                for shape in ("unary_unary", "unary_stream", "stream_unary", "stream_stream"):
                    found = getattr(channel, f"_{shape}_interceptors", None)
                    if found is not None and not any(ours in found for ours in store._interceptor(True)):
                        raise TypeError("firestore_store needs the client's channel to carry its interceptors.")
                super().__init__(*args, channel=channel, **kwargs)

        AsyncTransport.__name__ = AsyncTransport.__qualname__ = f"Guarded{transport.__name__}"
        return AsyncTransport

    def _guarded_client_class(self, base: type, asynchronous: bool) -> type:
        store = self

        def _firestore_api_helper(self: Any, transport: type, client_class: Any, client_module: Any) -> Any:
            return base._firestore_api_helper(self, store._guarded_transport(transport, asynchronous), client_class, client_module)

        namespace: dict[str, Any] = {"_firestore_api_helper": _firestore_api_helper, "__module__": __name__, _HOOKED: self}

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

    # ------------------------------------------------------------------ hooking
    def guard_client(self, client: Any) -> None:
        """Guard a Firestore client in place. Hooking a client twice is refused."""
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
        if "_firestore_api_helper" not in dir(client):
            raise TypeError("This google-cloud-firestore version has no _firestore_api_helper; 2.x is expected.")
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

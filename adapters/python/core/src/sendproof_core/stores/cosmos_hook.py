"""Sendproof write guard for Azure Cosmos DB for NoSQL (``spec/data-stores.md``, ``guard`` mode).

``cosmosdb_store(client)`` guards an ``azure-cosmos`` 4 ``CosmosClient`` (synchronous or
``azure.cosmos.aio``) in place through its azure-core **transport**.

Why the transport: ``CosmosClient`` builds its azure-core pipeline from a fixed policy list, so
``per_call_policies=`` is **not** honoured (it falls through to the HTTP session and fails). The
one extension point the client does honour is ``transport=``, and every request the SDK sends,
retries and metadata reads included, passes through ``transport.send`` after the pipeline signed it
and before it is written. The hook swaps the client's transport for a guarded subclass, so
``database_client()``, ``get_container_client()``, ``scripts`` and every other derived proxy, which
all share the client's one pipeline, stay guarded.

* Each ``HttpRequest`` is classified with ``fromRequest`` in ``cosmosdb.json``: the method, the
  resource path and the ``x-ms-documentdb-isquery``, ``x-ms-cosmos-is-query-plan-request``,
  ``x-ms-cosmos-is-batch-request`` and ``x-ms-documentdb-is-upsert`` headers name the operation.
  A request that names a pre-trigger or post-trigger is a write. So are stored-procedure
  executions, batches and patches.
* Reads run and become a ``Db`` entry: the query text with every literal replaced by ``?`` (names
  of parameters, never their values). In a Preview the first write raises
  :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409.

Coverage: the hooked client, and anything built from it. A second ``CosmosClient`` is not covered
unless you hook it too or build it with ``transport=store.guard_transport(RequestsTransport())``.
"""

from __future__ import annotations

import inspect
import json
import re
import time
from http import HTTPStatus
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit

from .base import DataStore
from .classify_batch_two import classify_cosmos, path_segments
from .guard import check_command, read_set, store_label
from .versions import require_supported

_COSMOS_STRING = re.compile(r"""'(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?""", re.DOTALL)
_COSMOS_NUMBER = re.compile(r"(?<![\w@.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w])")


def sanitize_cosmos_sql(text: str) -> str:
    """Replace every literal in a Cosmos DB SQL query with ``?``: single- and double-quoted strings
    (both are strings in this dialect) and numbers. ``@parameter`` names and identifiers are kept."""
    return _COSMOS_NUMBER.sub("?", _COSMOS_STRING.sub("?", text))


def _query_text(body: Any) -> Optional[str]:
    """The sanitized text of a query request's JSON body (``{"query": ..., "parameters": [...]}``)."""
    if isinstance(body, (bytes, bytearray)):
        body = bytes(body).decode("utf-8", "replace")
    try:
        parsed = json.loads(body) if isinstance(body, str) else None
    except ValueError:
        return "?"
    query = parsed.get("query") if isinstance(parsed, dict) else None
    return sanitize_cosmos_sql(query) if isinstance(query, str) else None


def _status_name(status: Any) -> Optional[str]:
    """``NotFound``, ``Conflict``, ``TooManyRequests``...: the HTTP phrase of an error status, else ``None``."""
    try:
        code = int(status)
        return HTTPStatus(code).phrase.replace(" ", "") if code >= 400 else None
    except (TypeError, ValueError):
        return f"HTTP{status}"


class _Guard:
    """The methods a guarded transport class gets.

    They are copied into a subclass with the transport's own class as its only base, and call
    ``base.send(self, ...)`` rather than ``super()``: swapping a transport's ``__class__`` needs the
    same instance layout, and a mixin in front of azure-core's ``Generic`` and ``ABC`` bases changes it.
    """

    _sendproof_store: "CosmosDBStore"

    def _sendproof_before(self, request: Any) -> Optional[tuple]:
        store = self._sendproof_store
        path = urlsplit(str(request.url)).path
        headers = dict(request.headers or {})
        verdict = classify_cosmos(request={"method": str(request.method), "path": path, "headers": headers},
                                  treat_as_read=store._reads)
        scope = check_command("cosmosdb", verdict.operation, verdict.kind)
        if scope is None:
            return None
        segments = path_segments(path)
        names = {kind: segments[index + 1] for index, kind in enumerate(segments[:-1]) if kind in ("dbs", "colls")}
        statement = _query_text(getattr(request, "body", None)) if verdict.operation in ("Query", "SqlQuery") else None
        return scope, verdict, names.get("colls"), names.get("dbs"), statement, time.perf_counter()

    def _sendproof_after(self, pending: Optional[tuple], response: Any, error: Optional[BaseException]) -> None:
        if pending is None:
            return
        scope, verdict, target, namespace, statement, began = pending
        rows: Optional[int] = None
        failure: Optional[str] = type(error).__name__ if error is not None else None
        if response is not None:
            failure = _status_name(getattr(response, "status_code", None))
            try:
                count = response.headers.get("x-ms-item-count")
                rows = int(count) if count is not None else None
            except (AttributeError, TypeError, ValueError):
                rows = None
        scope.capture.record_db(
            "cosmosdb", verdict.operation, target=target, namespace=namespace, statement=statement,
            rows_affected=rows, error=failure, elapsed_ms=(time.perf_counter() - began) * 1000,
        )


def _guarded_class(base: type, store: "CosmosDBStore") -> type:
    """A subclass of the transport class ``base`` whose ``send`` classifies and guards before sending."""
    if inspect.iscoroutinefunction(base.send):
        async def send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
            pending = self._sendproof_before(request)
            try:
                response = await base.send(self, request, *args, **kwargs)
            except Exception as error:
                self._sendproof_after(pending, None, error)
                raise
            self._sendproof_after(pending, response, None)
            return response
    else:
        def send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:  # type: ignore[misc]
            pending = self._sendproof_before(request)
            try:
                response = base.send(self, request, *args, **kwargs)
            except Exception as error:
                self._sendproof_after(pending, None, error)
                raise
            self._sendproof_after(pending, response, None)
            return response
    return type(f"Guarded{base.__name__}", (base,), {
        "send": send, "_sendproof_before": _Guard._sendproof_before, "_sendproof_after": _Guard._sendproof_after,
        "_sendproof_store": store, "__module__": __name__,
    })


_classes: dict[tuple[type, int], type] = {}


def _client_transport(client: Any) -> Any:
    """The azure-core transport a ``CosmosClient`` sends through.

    ``client_connection.pipeline_client._pipeline._transport`` is not public API, so a client whose
    layout differs is refused at registration rather than left unguarded.
    """
    pipeline = getattr(getattr(getattr(client, "client_connection", None), "pipeline_client", None), "_pipeline", None)
    transport = getattr(pipeline, "_transport", None)
    policies = getattr(pipeline, "_impl_policies", None)
    # The object found must be the one the pipeline's last step sends through, or guarding it guards nothing.
    runner = getattr(policies[-1], "next", None) if isinstance(policies, list) and policies else None
    if transport is None or not hasattr(transport, "send") or getattr(runner, "_sender", None) is not transport:
        raise TypeError(
            "cosmosdb_store could not find the azure-core transport of this client (azure-cosmos 4 expected). "
            "Build the client with transport=store.guard_transport(...) instead.")
    return transport


class CosmosDBStore(DataStore):
    """A hooked Cosmos DB client, ready for ``data_stores``."""

    system = "cosmosdb"

    def __init__(self, name: Optional[str], reads: Optional[frozenset[str]]) -> None:
        self.name = name
        self._reads = reads

    def describe(self) -> dict[str, Any]:
        return {"system": "cosmosdb", **({"name": self.name} if self.name else {}), "mode": "guard"}

    def guard_transport(self, transport: Any) -> Any:
        """Guard an azure-core transport object in place and return it, for ``CosmosClient(transport=...)``.

        Hooking a transport twice is refused, so a request is never logged twice.
        """
        if getattr(type(transport), "_sendproof_store", None) is not None:
            raise TypeError("This Cosmos DB client or transport is already hooked by cosmosdb_store.")
        base = type(transport)
        key = (base, id(self))
        guarded = _classes.get(key)
        if guarded is None:
            guarded = _classes[key] = _guarded_class(base, self)
        try:
            transport.__class__ = guarded
        except TypeError as error:  # an unusual instance layout: refuse rather than leave the client unguarded
            raise TypeError(f"cosmosdb_store can't hook a {base.__name__}; build the client with a plain subclass of it.") from error
        return transport


def cosmosdb_store(client: Any = None, *, name: Optional[str] = None,
                   treat_as_read: Optional[Iterable[str]] = None) -> CosmosDBStore:
    """Hook an ``azure-cosmos`` 4 ``CosmosClient`` (sync or aio) in place and return the store for ``data_stores``.

    Pass nothing to get just the store, and build the client with
    ``transport=store.guard_transport(RequestsTransport())``. Hooking the same client twice is refused.

    Args:
        name: A display label for discovery, such as ``orders``. Never an account endpoint or key.
        treat_as_read: Operation types you state never write, such as ``Execute`` for a stored
            procedure you know only reads: exact names, no wildcards. A request that names a
            trigger is still a write. **The guard trusts this list**: a listed operation that does
            write is not blocked.
    """
    require_supported("azure-cosmos", "cosmosdb_store")
    store = CosmosDBStore(store_label(name), read_set(treat_as_read))
    if client is not None:
        store.guard_transport(_client_transport(client))
    return store

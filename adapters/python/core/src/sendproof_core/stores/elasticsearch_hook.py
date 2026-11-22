"""Sendproof write guard for Elasticsearch and OpenSearch (``spec/data-stores.md``, ``guard`` mode).

``elasticsearch_store(client)`` hooks an ``elasticsearch`` 8 client (``Elasticsearch`` or
``AsyncElasticsearch``) and ``opensearch_store(client)`` an ``opensearch-py`` 2 client
(``OpenSearch`` or ``AsyncOpenSearch``) in place. The hook is a ``Transport`` subclass whose
``perform_request(method, target, body=...)`` is the one place every typed API call, helper
(``helpers.bulk``, ``helpers.scan``) and raw ``client.perform_request`` goes through, below the
serializer and the HTTP node, so a refused write never becomes an HTTP request:

* The request is classified by method and path (and, for the SQL endpoints, the body) with the
  shared ``elasticsearch.json`` table. A ``POST`` to ``_search`` reads; ``_bulk``,
  ``_update_by_query``, ``_delete_by_query``, ``_reindex``, document ``PUT``/``POST``/``DELETE`` and
  every index, alias, template and mapping change write.
* Reads run and become a ``Db`` entry whose statement is the request body with every value replaced
  by ``?``. In a Preview the first write raises
  :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409.
* Point-in-time, scroll, async-search and SQL-cursor handles are session state: allowed, not logged.

Derived clients stay guarded: ``client.options(...)`` (and ``child``-style copies) share the
hooked transport. Hooking a client covers that client and its copies; a second client built
elsewhere is not covered unless it is built with ``store.guard_transport_class(...)``::

    store = elasticsearch_store(name="search")      # no client yet
    client = Elasticsearch(url, transport_class=store.guard_transport_class(Transport))
"""

from __future__ import annotations

import inspect
import json
import time
from typing import Any, Iterable, Mapping, Optional

from .base import DataStore
from .classify import SESSION
from .classify_batch_two import classify_elasticsearch, elasticsearch_target
from .guard import check_command, read_set, sanitize_document, store_label


def sanitize_body(body: Any) -> Optional[str]:
    """A request body as ``Db`` statement text: field names and operators kept, every value ``?``.

    NDJSON (``_bulk``, ``_msearch``) is sanitized line by line. A body the hook can't read becomes ``?``.
    """
    if body is None or body == "" or body == b"":
        return None
    if isinstance(body, (bytes, bytearray)):
        body = bytes(body).decode("utf-8", "replace")
    if isinstance(body, str):
        lines = [line for line in body.split("\n") if line.strip()]
        try:
            return "\n".join(json.dumps(sanitize_document(json.loads(line)), separators=(",", ":")) for line in lines)
        except ValueError:
            return "?"
    try:
        return json.dumps(sanitize_document(body), separators=(",", ":"))
    except (TypeError, ValueError):
        return "?"


def _rows(body: Any) -> Optional[int]:
    """Documents returned, matched or written, when the reply says so."""
    if isinstance(body, (bytes, bytearray, str)) or not isinstance(body, Mapping):
        return None
    hits = body.get("hits")
    if isinstance(hits, Mapping) and isinstance(hits.get("hits"), list):
        return len(hits["hits"])
    for key in ("docs", "items"):
        if isinstance(body.get(key), list):
            return len(body[key])
    for key in ("updated", "deleted"):
        if isinstance(body.get(key), int) and not isinstance(body.get(key), bool):
            return body[key]
    if body.get("found") is True or body.get("result") in ("created", "updated", "deleted"):
        return 1
    return None


def _error_name(error: BaseException) -> str:
    """The store's error type (``version_conflict_engine_exception``) when the client exposes it, else the class name."""
    found = getattr(error, "error", None)
    return found if isinstance(found, str) and found and len(found) <= 64 else type(error).__name__


class _GuardBase:
    """What the four guarded transports share: classify, guard, then log when the reply arrives."""

    _sendproof_store: "ElasticsearchStore"

    def _sendproof_before(self, method: Any, path: Any, body: Any) -> Optional[tuple]:
        store = self._sendproof_store
        verdict = classify_elasticsearch(method, path, body, store._reads)
        scope = check_command(store.system, verdict.operation, verdict.kind)
        if scope is None or verdict.kind == SESSION:
            return None  # outside a request, or a handle that is never logged
        return scope, verdict, elasticsearch_target(path), sanitize_body(body), time.perf_counter()

    def _sendproof_after(self, pending: Optional[tuple], response: Any, error: Optional[BaseException]) -> None:
        if pending is None:
            return
        scope, verdict, target, statement, began = pending
        body = getattr(response, "body", response)
        scope.capture.record_db(
            self._sendproof_store.system, verdict.operation, target=target, statement=statement,
            rows_affected=None if error is not None else _rows(body),
            error=None if error is None else _error_name(error), elapsed_ms=(time.perf_counter() - began) * 1000,
        )


class _ElasticSync(_GuardBase):
    """Mixin for ``elastic_transport.Transport``."""

    def perform_request(self, method: Any, target: Any, *args: Any, **kwargs: Any) -> Any:
        pending = self._sendproof_before(method, target, kwargs.get("body"))
        try:
            response = super().perform_request(method, target, *args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_after(pending, None, error)
            raise
        self._sendproof_after(pending, response, None)
        return response


class _ElasticAsync(_GuardBase):
    """Mixin for ``elastic_transport.AsyncTransport``."""

    async def perform_request(self, method: Any, target: Any, *args: Any, **kwargs: Any) -> Any:
        pending = self._sendproof_before(method, target, kwargs.get("body"))
        try:
            response = await super().perform_request(method, target, *args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_after(pending, None, error)
            raise
        self._sendproof_after(pending, response, None)
        return response


class _OpenSync(_GuardBase):
    """Mixin for ``opensearchpy.Transport``, whose ``perform_request(method, url, params, body, ...)`` takes the body positionally."""

    def perform_request(self, method: Any, url: Any, params: Any = None, body: Any = None, *args: Any, **kwargs: Any) -> Any:
        pending = self._sendproof_before(method, url, body)
        try:
            response = super().perform_request(method, url, params, body, *args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_after(pending, None, error)
            raise
        self._sendproof_after(pending, response, None)
        return response


class _OpenAsync(_GuardBase):
    """Mixin for ``opensearchpy.AsyncTransport``."""

    async def perform_request(self, method: Any, url: Any, params: Any = None, body: Any = None, *args: Any, **kwargs: Any) -> Any:
        pending = self._sendproof_before(method, url, body)
        try:
            response = await super().perform_request(method, url, params, body, *args, **kwargs)  # type: ignore[misc]
        except Exception as error:
            self._sendproof_after(pending, None, error)
            raise
        self._sendproof_after(pending, response, None)
        return response


_GUARDS = (_ElasticSync, _ElasticAsync, _OpenSync, _OpenAsync)
_classes: dict[tuple[type, int], type] = {}


def _flavor(base: type) -> str:
    """``opensearch`` for an ``opensearch-py`` transport class, ``elasticsearch`` for an ``elastic-transport`` one."""
    return "opensearch" if base.__module__.split(".")[0] == "opensearchpy" else "elasticsearch"


class ElasticsearchStore(DataStore):
    """A hooked Elasticsearch or OpenSearch client, ready for ``data_stores``.

    ``system`` is ``elasticsearch`` or ``opensearch``: the id the ``Db`` entries, discovery and the 409 report.
    """

    def __init__(self, system: str, name: Optional[str], reads: Optional[frozenset[str]]) -> None:
        self.system = system
        self.name = name
        self._reads = reads

    def describe(self) -> dict[str, Any]:
        return {"system": self.system, **({"name": self.name} if self.name else {}), "mode": "guard"}

    def guard_transport_class(self, base: type) -> type:
        """A guarded subclass of a transport class, for ``transport_class=`` when you build the client yourself."""
        if issubclass(base, _GUARDS):
            return base
        flavor = _flavor(base)
        if flavor != self.system:
            raise TypeError(f"{base.__name__} belongs to the {flavor} client; use {flavor}_store.")
        asynchronous = inspect.iscoroutinefunction(base.perform_request)
        mixin = {("elasticsearch", False): _ElasticSync, ("elasticsearch", True): _ElasticAsync,
                 ("opensearch", False): _OpenSync, ("opensearch", True): _OpenAsync}[(flavor, asynchronous)]
        key = (base, id(self))
        found = _classes.get(key)
        if found is None:
            found = _classes[key] = type(f"Guarded{base.__name__}", (mixin, base), {
                "_sendproof_store": self, "__module__": __name__,
            })
        return found

    def guard_transport(self, transport: Any) -> None:
        """Guard one transport object in place. Hooking a transport twice is refused."""
        if isinstance(transport, _GUARDS):
            raise TypeError(f"This {self.system} client is already hooked by {self.system}_store.")
        transport.__class__ = self.guard_transport_class(type(transport))


def _hook(system: str, client: Any, name: Optional[str], treat_as_read: Optional[Iterable[str]]) -> ElasticsearchStore:
    store = ElasticsearchStore(system, store_label(name), read_set(treat_as_read, allow_spaces=True))
    if client is not None:
        transport = getattr(client, "transport", None) or getattr(client, "_transport", None) or client
        if not hasattr(transport, "perform_request"):
            raise TypeError(f"{system}_store takes a {system} client or its transport.")
        store.guard_transport(transport)
    return store


def elasticsearch_store(client: Any = None, *, name: Optional[str] = None,
                        treat_as_read: Optional[Iterable[str]] = None) -> ElasticsearchStore:
    """Hook an ``elasticsearch`` 8 client in place and return the store for ``data_stores``.

    ``client`` is an ``Elasticsearch`` or ``AsyncElasticsearch`` (or its ``Transport``). Pass
    nothing to get just the store and build your client with
    ``transport_class=store.guard_transport_class(Transport)``. Hooking the same client twice is
    refused, so a request is never logged twice.

    Args:
        name: A display label for discovery, such as ``search``. Never a URL or host name.
        treat_as_read: Operation names you state never write: the table's endpoint name, or
            ``METHOD /path`` for an unlisted endpoint, such as ``POST /{}/_refresh``. Exact names,
            no wildcards. **The guard trusts this list**: a listed request that does write is not blocked.
    """
    return _hook("elasticsearch", client, name, treat_as_read)


def opensearch_store(client: Any = None, *, name: Optional[str] = None,
                     treat_as_read: Optional[Iterable[str]] = None) -> ElasticsearchStore:
    """Hook an ``opensearch-py`` 2 client (``OpenSearch`` or ``AsyncOpenSearch``) in place; see :func:`elasticsearch_store`.

    The store reports ``opensearch`` as its system.
    """
    return _hook("opensearch", client, name, treat_as_read)

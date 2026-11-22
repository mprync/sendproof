"""Sendproof write guard for Cassandra (``spec/data-stores.md``, ``guard`` mode).

``cassandra_store(target)`` guards a DataStax ``cassandra-driver`` (or ScyllaDB's fork) ``Session``
or ``Cluster`` in place. The hook overrides ``Session.execute_async``, which every other entry point
reaches: ``Session.execute``, ``execute_concurrent`` and the ``cqlengine`` object mapper all call
it. It sees the statement before the driver builds a message, so nothing is sent for a refused write:

* A statement is classified by the text it carries: a string, a ``SimpleStatement``, or a
  ``BoundStatement`` / ``PreparedStatement``, whose ``prepared_statement.query_string`` is the text
  the driver prepared, so an ``EXECUTE`` is classified exactly like its ``PREPARE``.
* Every ``BatchStatement`` is a write, even one holding only reads. ``execute_graph_async`` (DSE
  Graph) is a write too: the guard can't read Gremlin.
* Reads run. In a Preview the first write raises
  :class:`~sendproof_core.stores.guard.PreviewWriteBlocked` and the Preview answers 409. A read
  becomes a ``Db`` entry whose statement has every literal replaced by ``?``.

Registering on a **cluster** covers its sessions: the ones that exist and every session
``Cluster.connect`` creates afterwards (the hook wraps that cluster's ``connect``). Registering on a **session** covers that session only. A
session of another cluster, or a raw connection, is not covered.
"""

from __future__ import annotations

import functools
import time
from typing import Any, Iterable, Optional

from ..scope import RequestScope
from .base import DataStore
from .classify import SESSION, WRITE
from .classify_batch_two import Verdict, classify_cassandra, cql_target, sanitize_cql
from .guard import check_command, read_set, store_label

_HOOKED = "_sendproof_cassandra_store"


def _query_text(query: Any) -> tuple[Optional[str], Optional[str]]:
    """``(text, kind)`` of what ``Session.execute`` was given: the CQL text, or ``(None, "BATCH")``
    for a batch and ``(None, "UNKNOWN")`` for a statement type the hook can't read."""
    from cassandra.query import BatchStatement, BoundStatement, PreparedStatement, SimpleStatement

    if isinstance(query, str):
        return query, None
    if isinstance(query, BatchStatement):
        return None, "BATCH"
    if isinstance(query, BoundStatement):
        return query.prepared_statement.query_string, None
    if isinstance(query, (PreparedStatement, SimpleStatement)):
        return query.query_string, None
    return None, "UNKNOWN"


class _Guarded:
    """Mixin for ``cassandra.cluster.Session``: classify and guard before sending, log when done."""

    _sendproof_store: "CassandraStore"

    def execute_async(self, query: Any, *args: Any, **kwargs: Any) -> Any:
        store = self._sendproof_store
        text, special = _query_text(query)
        verdict = Verdict(WRITE, special) if special else classify_cassandra(text, store._reads)
        scope = check_command("cassandra", verdict.operation, verdict.kind)
        began = time.perf_counter()
        future = super().execute_async(query, *args, **kwargs)  # type: ignore[misc]
        if scope is not None and verdict.kind != SESSION:
            store._log_when_done(future, scope, verdict, text, getattr(self, "keyspace", None), began)
        return future

    def execute_graph_async(self, *args: Any, **kwargs: Any) -> Any:
        check_command("cassandra", "GRAPH", WRITE)  # Gremlin can write and the guard can't read it
        return super().execute_graph_async(*args, **kwargs)  # type: ignore[misc]


_classes: dict[tuple[type, int], type] = {}


class CassandraStore(DataStore):
    """A hooked Cassandra session or cluster, ready for ``data_stores``."""

    system = "cassandra"

    def __init__(self, name: Optional[str], reads: Optional[frozenset[str]]) -> None:
        self.name = name
        self._reads = reads

    def describe(self) -> dict[str, Any]:
        return {"system": "cassandra", **({"name": self.name} if self.name else {}), "mode": "guard"}

    # ------------------------------------------------------------------ logging
    def _log_when_done(self, future: Any, scope: RequestScope, verdict: Verdict, text: Optional[str],
                       keyspace: Optional[str], began: float) -> None:
        """Log the command when its reply arrives. The driver runs callbacks on its own threads, so the
        capture is bound here; one that already ended ignores the entry."""
        statement = sanitize_cql(text) if text is not None else None
        namespace, target = cql_target(statement) if statement else (None, None)
        namespace = namespace or keyspace

        def log(rows: Optional[int], error: Optional[str]) -> None:
            scope.capture.record_db(
                "cassandra", verdict.operation, target=target, namespace=namespace, statement=statement,
                rows_affected=rows, error=error, elapsed_ms=(time.perf_counter() - began) * 1000,
            )

        def done(result: Any) -> None:
            try:
                rows = len(result) if result is not None and not isinstance(result, (str, bytes)) else None
            except TypeError:
                rows = None
            log(rows, None)

        future.add_callbacks(done, lambda error: log(None, type(error).__name__))

    # ------------------------------------------------------------------ hooking
    def guard_session(self, session: Any) -> None:
        """Guard one session in place. Hooking a session twice is refused, so a command is never logged twice."""
        if isinstance(session, _Guarded):
            raise TypeError("This Cassandra session is already hooked by cassandra_store.")
        base = type(session)
        key = (base, id(self))
        guarded = _classes.get(key)
        if guarded is None:
            guarded = _classes[key] = type(f"Guarded{base.__name__}", (_Guarded, base), {
                "_sendproof_store": self, "__module__": __name__,
            })
        session.__class__ = guarded

    def guard_cluster(self, cluster: Any) -> None:
        """Guard a cluster's sessions: the existing ones, and every session ``connect()`` creates later."""
        if getattr(cluster, _HOOKED, None) is not None:
            raise TypeError("This Cassandra cluster is already hooked by cassandra_store.")
        # ``connect()`` is the public, only way a cluster makes a session; wrapping it relies on no
        # private method, so a driver that reorganizes its internals can't make sessions unguarded.
        original = cluster.connect
        sessions = getattr(cluster, "sessions", None)
        if not callable(original) or sessions is None:
            raise TypeError("This cassandra-driver Cluster has no connect() or sessions; cassandra_store can't guard it.")
        store = self

        @functools.wraps(original)
        def connect(*args: Any, **kwargs: Any) -> Any:
            session = original(*args, **kwargs)
            if not isinstance(session, _Guarded):
                store.guard_session(session)
            return session

        cluster.connect = connect
        setattr(cluster, _HOOKED, self)
        for session in list(sessions):
            if not isinstance(session, _Guarded):
                self.guard_session(session)


def cassandra_store(target: Any, *, name: Optional[str] = None, treat_as_read: Optional[Iterable[str]] = None) -> CassandraStore:
    """Hook a ``cassandra-driver`` ``Cluster`` or ``Session`` in place and return the store for ``data_stores``.

    Args:
        target: A ``Cluster`` (covers its sessions, before and after the call) or a ``Session``
            (covers that session). Hook the cluster whenever the host owns it.
        name: A display label for discovery, such as ``tickets``. Never a contact point or host name.
        treat_as_read: Statement keys you state never write, such as a custom statement
            ``DESCRIBE``-like keyword: exact upper-case names (``LIST ROLES``), no wildcards.
            **The guard trusts this list**: a listed statement that does write is not blocked.
    """
    from cassandra.cluster import Cluster, Session

    store = CassandraStore(store_label(name), read_set(treat_as_read, lambda item: item.upper(), allow_spaces=True))
    if isinstance(target, Session):
        store.guard_session(target)
    elif isinstance(target, Cluster):
        store.guard_cluster(target)
    else:
        raise TypeError("cassandra_store takes a cassandra-driver Cluster or Session.")
    return store

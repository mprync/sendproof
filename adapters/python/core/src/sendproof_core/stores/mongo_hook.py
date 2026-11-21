"""Sendproof Preview and write guard for MongoDB (``spec/data-stores.md`` "MongoDB in Preview").

On a replica set or sharded cluster a Preview runs every command in one transaction that is
aborted after the handler, and reports document changes. On a standalone server MongoDB cannot
run transactions, so the store runs in ``guard`` mode like Redis: reads run and the first write
blocks the Preview.

Usage::

    client = MongoClient(url)                      # PyMongo, AsyncMongoClient or Motor
    catalog = mongo_store(client, name="catalog")  # handlers use catalog.client
    app.get("/documents/{id}")(lambda id: catalog.client["shop"]["documents"].find_one({"_id": id}))

No MongoDB driver offers a documented pre-send hook, so ``catalog.client`` is a guarded handle:
``client[db][collection]`` return handles with the driver's own API. During a Preview each call is
checked before the driver builds a command:

* every call gets the Preview session (``preview`` mode), so the command carries the Preview's
  ``lsid``, ``txnNumber`` and ``autocommit: false``;
* an explicit session other than the Preview's is refused, failing the Preview with 500;
* the guard classifies the command the method sends and blocks writes (``guard`` mode) or what a
  transaction cannot run (``preview`` mode);
* a method the tables below do not list is refused, so a new driver method fails closed.

Command monitoring backs the handles up as a **tripwire**: a global ``CommandListener`` sees every
command of every client created after this module was imported (or given the listener), in the
request's context. A write during a Preview without the Preview's ``lsid`` and
``autocommit: false`` has escaped the transaction and cannot be undone: the Preview fails with 500,
so no rollback is ever claimed for it. The same listener supplies the ``Db`` log entries, the
change candidates, the snapshot time and the code 263 block.

Limits: a client created before this module was imported has no listener and is refused (pass
``event_listeners=[mongo_monitor]``). Motor runs the driver in a thread pool that does not carry
``contextvars``, so for Motor the monitor attributes commands to a Preview by their ``lsid`` only:
a stray write through an unhooked Motor client cannot be attributed and is not caught.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
import weakref
from dataclasses import dataclass, field
from typing import Any, Callable, Generator, Iterable, Mapping, Optional

from bson import json_util
from pymongo import monitoring
from pymongo.errors import OperationFailure
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from ..provider import PreviewChange
from ..scope import RequestScope, current_scope
from .base import DataStore
from .classify import READ, SESSION, WRITE, classify_mongo
from .guard import (
    PreviewTransactionControl,
    current_preview,
    guard,
    read_set,
    refuse_in_preview,
    sanitize_document,
    store_label,
)

#: The reason a standalone server, or any reply the binding does not recognise, runs in ``guard`` mode.
STANDALONE_REASON = "Preview unavailable: this MongoDB server doesn't support transactions"

#: The default Preview time limit in seconds: below the server's 60-second
#: ``transactionLifetimeLimitSeconds``, so the binding, not the server, ends a Preview whose handler
#: runs too long.
DEFAULT_PREVIEW_TIMEOUT = 50.0


def refused_reason(operation: str) -> str:
    """The reason for a command MongoDB refuses inside a transaction."""
    return f"Preview unavailable: MongoDB can't run {operation} inside a transaction"


#: Commands the monitoring specification marks security-sensitive: never logged.
_SENSITIVE = frozenset({"authenticate", "saslstart", "saslcontinue", "getnonce", "createuser", "updateuser",
                        "copydbgetnonce", "copydbsaslstart", "copydb"})
#: Fields the driver adds to every command; they carry no meaning for the log and are dropped.
_ENVELOPE = frozenset({"lsid", "txnNumber", "autocommit", "startTransaction", "$clusterTime", "$db",
                       "$readPreference", "readConcern", "writeConcern", "apiVersion", "apiStrict",
                       "apiDeprecationErrors", "maxTimeMS", "comment"})
#: Most candidate documents read back for change capture in one Preview.
_CANDIDATE_LIMIT = 1000
#: Server error codes meaning the collection or snapshot did not exist at the start time.
_ABSENT_AT_START = frozenset({26, 246})  # NamespaceNotFound, SnapshotUnavailable
_SYSTEM_DATABASES = frozenset({"admin", "config", "local"})
_EXTENSION = "sendproof.mongodb"


def _ends_transaction(name: str) -> bool:
    """Commands that end a transaction. In a Preview only the engine may send them."""
    return name in ("committransaction", "aborttransaction")


def system_database(name: Optional[str]) -> bool:
    """Commands on these databases cannot join a transaction."""
    return name in _SYSTEM_DATABASES


# --------------------------------------------------------------------------- sans-IO driving
# The engine's server calls are written once, as generators that yield zero-argument callables
# and receive their results. ``_drive_sync`` runs them against PyMongo, ``_drive_async`` against
# AsyncMongoClient and Motor, where a result may need awaiting.
Steps = Generator[Callable[[], Any], Any, Any]


def _drive_sync(steps: Steps) -> Any:
    try:
        step = next(steps)
        while True:
            try:
                value = step()
            except BaseException as error:  # delivered to the generator, which may handle it
                step = steps.throw(error)
                continue
            step = steps.send(value)
    except StopIteration as done:
        return done.value


async def _drive_async(steps: Steps) -> Any:
    try:
        step = next(steps)
        while True:
            try:
                value = step()
                if inspect.isawaitable(value):
                    value = await value
            except BaseException as error:
                step = steps.throw(error)
                continue
            step = steps.send(value)
    except StopIteration as done:
        return done.value


def plain(value: Any) -> Any:
    """Convert BSON to plain JSON, using MongoDB Extended JSON v2 relaxed form for the types JSON lacks
    (``{"$oid": ...}``, ``{"$date": ...}``)."""
    return json.loads(json_util.dumps(value, json_options=json_util.RELAXED_JSON_OPTIONS))


def _lsid_hex(command: Mapping[str, Any]) -> Optional[str]:
    """Hex of a command's session id (``lsid.id``, a BSON UUID)."""
    lsid = command.get("lsid") if hasattr(command, "get") else None
    identifier = lsid.get("id") if hasattr(lsid, "get") else None
    return bytes(identifier).hex() if identifier is not None else None


# ----------------------------------------------------------------------------- Preview state
@dataclass
class PreviewState:
    """The state of one ``preview``-mode Preview."""

    engine: "MongoEngine"
    scope: RequestScope
    #: The real driver session carrying the Preview transaction.
    session: Any
    lsid: str
    #: What the handler sees as its session: transaction calls join, they never end the transaction.
    view: Any = None
    #: Set once a command carried the session to the server.
    used: bool = False
    finished: bool = False
    #: Set while the engine itself aborts, so the monitor does not mistake it for the handler's.
    aborting: bool = False
    #: Set when the Preview outlived its time limit: later commands are refused.
    expired: bool = False
    #: Candidate documents: key -> (namespace, collection, id, via).
    candidates: dict[str, tuple[str, str, Any, Optional[str]]] = field(default_factory=dict)
    #: Filters whose matches, before and inside the transaction, are change candidates.
    filters: list[tuple[str, str, Any, Optional[str]]] = field(default_factory=list)
    #: The transaction's snapshot time: the ``operationTime`` of the first reply to a command the
    #: Preview session sent. ``before`` images are read at this time, so a concurrent commit by
    #: another request never shows up as a Preview change.
    start_time: Any = None
    timer: Any = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    #: Guarded calls currently running (synchronous clients), so the time limit never aborts under one.
    inflight: int = 0


#: Preview states by lsid, so a command is attributed to its Preview even where ``contextvars``
#: are lost (Motor's thread pool).
_states: dict[str, PreviewState] = {}
_states_lock = threading.Lock()
#: Host-declared reads of every engine, for the monitor's write classification.
_extra_reads: set[str] = set()


def _state_of(lsid: Optional[str]) -> Optional[PreviewState]:
    with _states_lock:
        return _states.get(lsid) if lsid else None


# ------------------------------------------------------------------------------ the monitor
@dataclass
class _Pending:
    capture: Any
    state: Optional[PreviewState]
    name: str
    namespace: str
    target: Optional[str]
    statement: str
    lsid: Optional[str]


class MongoMonitor(monitoring.CommandListener):
    """The tripwire and logger for every MongoDB command the process sends.

    Registered globally when this module is imported, so every client created afterwards has it.
    Pass the instance as ``event_listeners=[mongo_monitor]`` for a client created earlier.
    """

    def __init__(self) -> None:
        self._pending: dict[tuple[Any, Any], _Pending] = {}
        self._lock = threading.Lock()

    # -- events
    def started(self, event: Any) -> None:
        command = event.command or {}
        name = event.command_name
        lower = name.lower()
        lsid = _lsid_hex(command)
        state = _state_of(lsid)
        context = current_scope()
        scope = context if context is not None else (state.scope if state is not None else None)
        preview = scope if scope is not None and scope.rollback else None
        kind, _ = classify_mongo(command if command else {name: 1}, frozenset(_extra_reads) or None)
        if preview is not None:
            if _ends_transaction(lower):
                # Sent around the hook, for example through an unguarded handle: it may have
                # committed the Preview transaction, so the Preview can never be confirmed.
                if not (state is not None and state.aborting):
                    preview.capture.refuse(PreviewTransactionControl(
                        f"A MongoDB {name} reached the server during a Preview; the Preview can't be confirmed."))
            elif kind == WRITE:
                self._watch_write(preview, state, command, event.database_name, lower)
        if kind == SESSION or lower in _SENSITIVE or _ends_transaction(lower) or scope is None:
            return
        target = command.get(name) if isinstance(command.get(name), str) else None
        body = {key: value for key, value in command.items() if key not in _ENVELOPE}
        pending = _Pending(scope.capture, state if state is not None and state.scope is scope else None, name,
                           event.database_name, target, json.dumps(sanitize_document(body)), lsid)
        with self._lock:
            if len(self._pending) > 10000:  # a leak guard: replies that never arrive
                self._pending.clear()
            self._pending[(event.request_id, event.connection_id)] = pending

    def succeeded(self, event: Any) -> None:
        pending = self._take(event)
        if pending is None:
            return
        reply = event.reply or {}
        state = pending.state
        if state is not None:
            with state.lock:
                # The first reply in the transaction carries its snapshot time (the read timestamp).
                if state.start_time is None and reply.get("operationTime") is not None and pending.lsid == state.lsid:
                    state.start_time = reply["operationTime"]
                if pending.target:
                    # Upserted ids appear only in the reply.
                    for upsert in reply.get("upserted") or ():
                        self._candidate(state, pending.namespace, pending.target, upsert.get("_id"), "upsert")
                    value = reply.get("value")
                    if pending.name.lower() == "findandmodify" and isinstance(value, Mapping) and "_id" in value:
                        self._candidate(state, pending.namespace, pending.target, value["_id"], None)
                    upserted = (reply.get("lastErrorObject") or {}).get("upserted")
                    if upserted is not None:
                        self._candidate(state, pending.namespace, pending.target, upserted, "upsert")
        # A write the transaction cannot run (a capped collection) is refused per write, inside an
        # otherwise successful reply: code 263, OperationNotSupportedInTransaction.
        if state is not None and any(isinstance(e, Mapping) and e.get("code") == 263 for e in reply.get("writeErrors") or ()):
            state.scope.capture.block("mongodb", pending.name, refused_reason(pending.name))
        cursor = reply.get("cursor")
        if isinstance(cursor, Mapping):
            rows: Optional[int] = len(cursor.get("firstBatch") or cursor.get("nextBatch") or ())
        else:
            rows = reply.get("n") if isinstance(reply.get("n"), int) else None
        self._log(pending, event.duration_micros / 1000, rows, None)

    def failed(self, event: Any) -> None:
        pending = self._take(event)
        if pending is None:
            return
        failure = event.failure if isinstance(event.failure, Mapping) else {}
        # The server refused something a transaction cannot do and applied nothing: a block, not a crash.
        if pending.state is not None and failure.get("code") == 263:
            pending.state.scope.capture.block("mongodb", pending.name, refused_reason(pending.name))
        self._log(pending, event.duration_micros / 1000, None, failure.get("codeName") or "Error")

    # -- helpers
    def _take(self, event: Any) -> Optional[_Pending]:
        with self._lock:
            return self._pending.pop((event.request_id, event.connection_id), None)

    @staticmethod
    def _log(pending: _Pending, elapsed_ms: float, rows: Optional[int], error: Optional[str]) -> None:
        pending.capture.record_db(
            "mongodb", pending.name, namespace=pending.namespace, target=pending.target,
            statement=pending.statement, rows_affected=rows, error=error, elapsed_ms=elapsed_ms,
        )

    def _watch_write(self, preview: RequestScope, state: Optional[PreviewState], command: Mapping[str, Any],
                     namespace: str, name: str) -> None:
        """A write seen during a Preview: collect change candidates, or trip if it escaped the session."""
        # Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
        if state is None or state.finished or state.scope is not preview or command.get("autocommit") is not False:
            # The hook could not stop it and nothing can undo it: never claim a rollback.
            preview.capture.refuse(PreviewTransactionControl(
                f"A MongoDB {name} escaped the Preview session; the Preview can't be confirmed."))
            return
        with state.lock:
            state.used = True
            first = next(iter(command), "")
            collection = command[first] if isinstance(command.get(first), str) else ""
            if name == "insert" and isinstance(command.get("documents"), list):
                for document in command["documents"]:
                    self._candidate(state, namespace, collection, document.get("_id") if hasattr(document, "get") else None, None)
            elif name == "update" and isinstance(command.get("updates"), list):
                for update in command["updates"]:
                    via = "upsert" if update.get("upsert") else "replace" if _replaces(update.get("u")) else None
                    state.filters.append((namespace, collection, update.get("q") or {}, via))
            elif name == "delete" and isinstance(command.get("deletes"), list):
                for removal in command["deletes"]:
                    state.filters.append((namespace, collection, removal.get("q") or {}, None))
            elif name == "findandmodify":
                via = "upsert" if command.get("upsert") else "replace" if _replaces(command.get("update")) else None
                state.filters.append((namespace, collection, command.get("query") or {}, via))
            elif name == "bulkwrite" and isinstance(command.get("ops"), list) and isinstance(command.get("nsInfo"), list):
                # The client-level bulkWrite command: each op names its namespace by index.
                namespaces = [str(info.get("ns", "")).split(".", 1) for info in command["nsInfo"]]
                for op in command["ops"]:
                    index = next((op[key] for key in ("insert", "update", "delete") if key in op), 0)
                    database, target = (namespaces[index] + [""])[:2] if index < len(namespaces) else (namespace, "")
                    if "document" in op:
                        self._candidate(state, database, target, op["document"].get("_id"), None)
                    else:
                        state.filters.append((database, target, op.get("filter") or {}, "upsert" if op.get("upsert") else None))

    @staticmethod
    def _candidate(state: PreviewState, namespace: str, collection: str, identifier: Any, via: Optional[str]) -> None:
        if identifier is None:
            return
        key = f"{namespace}\u0000{collection}\u0000{json_util.dumps(identifier)}"
        known = state.candidates.get(key)
        if known is None or (known[3] is None and via):
            state.candidates[key] = (namespace, collection, identifier, via)


def _replaces(update: Any) -> bool:
    """Whether an update document replaces the whole document rather than applying operators."""
    if not isinstance(update, Mapping) or not update:
        return False
    return not str(next(iter(update))).startswith("$")


#: The listener instance: registered globally on import, and passable to a client's ``event_listeners``.
mongo_monitor = MongoMonitor()
monitoring.register(mongo_monitor)


# -------------------------------------------------------------------------------- the engine
def _flavor(client: Any) -> str:
    """``sync`` (PyMongo), ``async`` (``AsyncMongoClient``) or ``motor``."""
    try:
        from motor.core import AgnosticClient

        if isinstance(client, AgnosticClient):
            return "motor"
    except ImportError:
        pass
    try:
        from pymongo.asynchronous.mongo_client import AsyncMongoClient

        if isinstance(client, AsyncMongoClient):
            return "async"
    except ImportError:
        pass
    from pymongo import MongoClient

    if isinstance(client, MongoClient):
        return "sync"
    raise TypeError("mongo_store takes a MongoClient, AsyncMongoClient or Motor client.")


def _listeners_of(client: Any) -> Optional[list[Any]]:
    """The command listeners a client was built with, or ``None`` when this driver version hides them."""
    try:
        target = getattr(client, "delegate", client)
        return list(target.options.pool_options._event_listeners.event_listeners())
    except Exception:
        return None


class MongoEngine:
    """One engine per hooked client: topology, Preview transaction, guard, change capture."""

    def __init__(self, client: Any, reads: Optional[frozenset[str]], timeout: float) -> None:
        self.client = client
        self.flavor = _flavor(client)
        self.is_async = self.flavor != "sync"
        self.reads = reads
        self.timeout = timeout
        #: The guarded client handlers use; set by :class:`MongoStore`.
        self.guarded: Any = None
        self._detected: Optional[tuple[str, Optional[str]]] = None
        #: The detected mode, known before any Preview runs: ``begin`` awaits detection.
        self.mode: Optional[str] = None
        listeners = _listeners_of(client)
        if listeners is not None and not any(isinstance(item, MongoMonitor) for item in listeners):
            raise TypeError(
                "Create the MongoDB client after importing sendproof_core.stores.mongo_store, or pass "
                "event_listeners=[mongo_monitor]: the Preview tripwire needs command monitoring.")
        if reads:
            _extra_reads.update(reads)

    # -- per-Preview records, kept on the scope so a Preview keeps the mode it began in
    def _records(self, scope: RequestScope) -> dict[int, Any]:
        return scope.extensions.setdefault(_EXTENSION, {})

    def state(self, scope: Optional[RequestScope] = None) -> Optional[PreviewState]:
        """The current Preview's state, when this code runs in a ``preview``-mode Preview that began."""
        scope = scope or current_preview()
        found = self._records(scope).get(id(self)) if scope is not None else None
        return found if isinstance(found, PreviewState) else None

    def mode_of(self, scope: RequestScope) -> str:
        """The mode the Preview began in; ``guard`` for a Preview that never began on this store.

        A shared, mutable mode would let a Preview that began without a session have its writes
        treated as joining a transaction it never had, once a later detection succeeded.
        """
        found = self._records(scope).get(("mode", id(self)))
        return found if found in ("preview", "guard") else "guard"

    # -- detection
    def _detect_steps(self) -> Steps:
        if self._detected is not None:
            return self._detected
        try:
            hello = yield (lambda: self.client["admin"].command({"hello": 1}))
        except Exception:
            # Unreachable or unrecognised: guard mode for now, and ask again next time.
            self.mode = self.mode or "guard"
            return "guard", STANDALONE_REASON
        transactions = bool((hello.get("setName") or hello.get("msg") == "isdbgrid")
                            and hello.get("logicalSessionTimeoutMinutes") is not None)
        self._detected = ("preview", None) if transactions else ("guard", STANDALONE_REASON)
        self.mode = self._detected[0]
        return self._detected

    def detect(self) -> tuple[str, Optional[str]]:
        """Detect the topology once: ``preview`` on a replica set or mongos with logical sessions."""
        self._require_sync()
        return _drive_sync(self._detect_steps())

    async def adetect(self) -> tuple[str, Optional[str]]:
        """Async form of :meth:`detect`."""
        return await (_drive_async(self._detect_steps()) if self.is_async else asyncio.to_thread(self.detect))

    def _require_sync(self) -> None:
        if self.is_async:
            raise RuntimeError("An asynchronous MongoDB client needs the ASGI adapter (FastAPI or Starlette).")

    # -- begin
    def _begin_steps(self, scope: RequestScope) -> Steps:
        mode, _ = yield from self._detect_steps()
        if scope.rollback is not True:
            return None
        records = self._records(scope)
        records[("mode", id(self))] = mode
        if mode != "preview":
            return None
        session = yield (lambda: self.client.start_session())
        try:
            yield (lambda: _start_transaction(session))
        except BaseException:
            yield from self._discard_steps(session)
            raise
        lsid = _lsid_hex({"lsid": session.session_id})
        if lsid is None:
            yield from self._discard_steps(session)
            raise RuntimeError("The MongoDB driver did not expose the Preview session id.")
        state = PreviewState(self, scope, session, lsid)
        state.view = _SessionView(state)
        records[id(self)] = state
        with _states_lock:
            _states[lsid] = state
        self._arm_timer(state)
        return state

    def _discard_steps(self, session: Any) -> Steps:
        try:
            yield (lambda: session.end_session())
        except Exception:
            pass

    def begin(self, scope: RequestScope) -> Optional[PreviewState]:
        """Prepare a Preview: detect the mode and, in ``preview`` mode, start its session and transaction."""
        self._require_sync()
        return _drive_sync(self._begin_steps(scope))

    async def abegin(self, scope: RequestScope) -> Optional[PreviewState]:
        """Async form of :meth:`begin`."""
        if self.is_async:
            return await _drive_async(self._begin_steps(scope))
        return await asyncio.to_thread(self.begin, scope)

    # -- the time limit
    def _arm_timer(self, state: PreviewState) -> None:
        """Abort a Preview that outlives its limit: a handler still running loses its transaction,
        later commands fail, nothing commits, and the Preview answers 500 when it ends."""
        if self.is_async:
            state.timer = asyncio.get_running_loop().call_later(self.timeout, lambda: self._expire_async(state))
        else:
            state.timer = threading.Timer(self.timeout, self._expire_sync, (state,))
            state.timer.daemon = True
            state.timer.start()

    def _expire_common(self, state: PreviewState) -> bool:
        state.scope.capture.refuse(PreviewTransactionControl(
            f"The Preview ran longer than {self.timeout:g} s, so its MongoDB transaction was aborted."))
        state.expired = True
        return not state.finished

    def _expire_sync(self, state: PreviewState) -> None:
        with state.lock:
            if not self._expire_common(state):
                return
            # A session is not thread-safe: abort now only when no guarded call is running.
            # Otherwise the last call to return aborts (see ``release``).
            if state.inflight == 0:
                self._abort_now(state)

    def _abort_now(self, state: PreviewState) -> None:
        try:
            _drive_sync(self._end_steps(state))
        except Exception:
            pass

    def _expire_async(self, state: PreviewState) -> None:
        if self._expire_common(state):
            asyncio.ensure_future(self._aend(state))

    def acquire(self, state: PreviewState) -> None:
        """Mark a guarded call as running. Refuses it when the Preview has expired."""
        with state.lock:
            if state.expired:
                error = PreviewTransactionControl("The Preview ran past its time limit, so its MongoDB transaction was aborted.")
                state.scope.capture.refuse(error)
                raise error
            state.inflight += 1

    def release(self, state: PreviewState) -> None:
        """Mark a guarded call as finished; abort now if the limit passed while it ran."""
        with state.lock:
            state.inflight -= 1
            if state.expired and state.inflight == 0 and not state.finished and not self.is_async:
                self._abort_now(state)

    # -- guard
    def check(self, command: Mapping[str, Any], operation: Optional[str] = None, database: Optional[str] = None) -> None:
        """Classify a command before it is sent and let the guard refuse it.

        In ``guard`` mode every write blocks; in ``preview`` mode only what MongoDB cannot run inside
        a transaction does. Commands on the admin, config or local databases run outside the
        transaction, so their writes block too.
        """
        scope = current_preview()
        if scope is None:
            return
        operation = operation or str(next(iter(command), "command"))
        if _ends_transaction(operation.lower()):
            raise refuse_in_preview(  # type: ignore[misc]
                f"Preview owns the MongoDB transaction, so the handler's {operation} cannot run during Preview.")
        kind, refused = classify_mongo(command, self.reads)
        if self.mode_of(scope) == "preview" and not system_database(database):
            if refused:
                guard("mongodb", operation, WRITE, refused_reason(refused))
            return
        guard("mongodb", operation, kind)

    # -- finish
    def _finish_steps(self, scope: RequestScope) -> Steps:
        state = self.state(scope)
        if state is None or state.finished:
            return
        failure: Optional[BaseException] = None
        try:
            if state.used:
                yield from self._capture_steps(scope, state)
        except Exception as error:
            # A failed command inside a transaction makes the server abort it: nothing to capture.
            if getattr(error, "code", None) != 251 and getattr(error, "details", {}).get("codeName") != "NoSuchTransaction":
                failure = error
        finally:
            yield from self._end_steps(state)
        if failure is not None:
            raise failure

    def finish(self, scope: RequestScope) -> None:
        """After the handler: capture document changes, then abort the transaction and end the session."""
        self._require_sync()
        _drive_sync(self._finish_steps(scope))

    async def afinish(self, scope: RequestScope) -> None:
        """Async form of :meth:`finish`."""
        if self.is_async:
            await _drive_async(self._finish_steps(scope))
        else:
            await asyncio.to_thread(self.finish, scope)

    def _end_steps(self, state: PreviewState) -> Steps:
        """Abort the Preview transaction and end its session, once. The driver ignores abort errors, as the
        transactions specification requires; an unacknowledged abort still commits nothing, because no
        ``commitTransaction`` is ever sent for the Preview session."""
        with state.lock:  # the time limit and the end of the handler may race to abort
            if state.finished:
                return
            state.finished = True
            state.aborting = True
        timer = state.timer
        try:
            if timer is not None:
                timer.cancel()
            if state.session.in_transaction:
                try:
                    yield (lambda: state.session.abort_transaction())
                except Exception:
                    pass
            try:
                yield (lambda: state.session.end_session())
            except Exception:
                pass
        finally:
            state.aborting = False
            with _states_lock:
                _states.pop(state.lsid, None)

    async def _aend(self, state: PreviewState) -> None:
        try:
            await _drive_async(self._end_steps(state))
        except Exception:
            pass

    def _at_start_steps(self, state: PreviewState, namespace: str, collection: str, query: Any,
                        projection: Optional[dict] = None) -> Steps:
        """Find documents as they were when the Preview transaction started: a snapshot read at its start
        time, outside the transaction. Without a start time (no reply carried one) it reads the
        majority-committed view, which the spec allows: nothing the Preview wrote is committed, so the
        only difference is a concurrent commit by another request."""
        concern = {"level": "majority"} if state.start_time is None else {"level": "snapshot", "atClusterTime": state.start_time}
        command: dict[str, Any] = {"find": collection, "filter": query}
        if projection:
            command["projection"] = projection
        command.update({"batchSize": _CANDIDATE_LIMIT, "limit": _CANDIDATE_LIMIT, "singleBatch": True, "readConcern": concern})
        try:
            reply = yield (lambda: self.client[namespace].command(command))
        except OperationFailure as error:
            # The collection was created after the start time: nothing in it existed then.
            if error.code in _ABSENT_AT_START:
                return []
            raise
        return list((reply.get("cursor") or {}).get("firstBatch") or [])

    def _list_steps(self, namespace: str, collection: str, query: Any, state: PreviewState) -> Steps:
        projection = {"_id": 1}
        target = self.client[namespace][collection]
        if self.is_async:
            return (yield (lambda: target.find(query, projection, session=state.session).to_list(None)))
        return (yield (lambda: list(target.find(query, projection, session=state.session))))

    def _capture_steps(self, scope: RequestScope, state: PreviewState) -> Steps:
        """Compare each candidate's start-time and in-transaction versions and record the differences."""
        for namespace, collection, query, via in list(state.filters):
            matched = yield from self._list_steps(namespace, collection, query, state)
            earlier = yield from self._at_start_steps(state, namespace, collection, query, {"_id": 1})
            for document in [*matched, *earlier]:
                MongoMonitor._candidate(state, namespace, collection, document["_id"], via)
                if len(state.candidates) >= _CANDIDATE_LIMIT:
                    break
        read = 0
        for namespace, collection, identifier, via in list(state.candidates.values()):
            if read >= _CANDIDATE_LIMIT:
                scope.store_changes_truncated = True
                break
            read += 1
            found = yield from self._at_start_steps(state, namespace, collection, {"_id": identifier})
            before = found[0] if found else None
            target = self.client[namespace][collection]
            after = yield (lambda: target.find_one({"_id": identifier}, session=state.session))
            was = None if before is None else plain(before)
            now = None if after is None else plain(after)
            if was == now:
                continue
            operation = "insert" if was is None else "delete" if now is None else "update"
            scope.store_changes.append(PreviewChange(
                operation, collection, {"_id": plain(identifier)}, was, now, "mongodb", namespace,
                via if via and operation != "delete" else None,
            ))


def _start_transaction(session: Any) -> Any:
    """Start the Preview transaction: snapshot reads, majority writes."""
    return session.start_transaction(read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))


# -------------------------------------------------------------------------- the guarded handles
Rule = Callable[[str, tuple, dict], dict]


def _simple(command: str) -> Rule:
    return lambda name, args, kwargs: {command: name}


def _aggregate(name: str, args: tuple, kwargs: dict) -> dict:
    pipeline = args[0] if args else kwargs.get("pipeline", [])
    return {"aggregate": name, "pipeline": pipeline}


def _stream(name: str, args: tuple, kwargs: dict) -> dict:
    return {"aggregate": name, "pipeline": [{"$changeStream": {}}, *(args[0] if args else kwargs.get("pipeline") or [])]}


def _command_document(name: str, args: tuple, kwargs: dict) -> dict:
    command = args[0] if args else kwargs.get("command")
    if isinstance(command, str):
        return {command: args[1] if len(args) > 1 else kwargs.get("value", 1)}
    return dict(command) if isinstance(command, Mapping) else {}


def _db_aggregate(name: str, args: tuple, kwargs: dict) -> dict:
    return {"aggregate": 1, "pipeline": args[0] if args else kwargs.get("pipeline", [])}


def _named(command: str, index: int = 0, key: str = "name") -> Rule:
    def rule(name: str, args: tuple, kwargs: dict) -> dict:
        value = args[index] if len(args) > index else kwargs.get(key)
        return {command: value if isinstance(value, str) else getattr(value, "name", value)}
    return rule


#: Collection methods: the command each sends, for classification. Unlisted methods are refused in a Preview.
_COLLECTION_RULES: dict[str, Rule] = {
    "insert_one": _simple("insert"), "insert_many": _simple("insert"), "bulk_write": _simple("bulkWrite"),
    "update_one": _simple("update"), "update_many": _simple("update"), "replace_one": _simple("update"),
    "delete_one": _simple("delete"), "delete_many": _simple("delete"),
    "find_one": _simple("find"), "find": _simple("find"), "find_raw_batches": _simple("find"),
    "count_documents": lambda name, a, k: {"aggregate": name, "pipeline": []}, "distinct": _simple("distinct"),
    "find_one_and_delete": _simple("findAndModify"), "find_one_and_replace": _simple("findAndModify"),
    "find_one_and_update": _simple("findAndModify"),
    "aggregate": _aggregate, "aggregate_raw_batches": _aggregate,
    "estimated_document_count": _simple("count"), "rename": _simple("renameCollection"), "drop": _simple("drop"),
    "options": _simple("listCollections"),
    "create_index": _simple("createIndexes"), "create_indexes": _simple("createIndexes"),
    "drop_index": _simple("dropIndexes"), "drop_indexes": _simple("dropIndexes"),
    "list_indexes": _simple("listIndexes"), "index_information": _simple("listIndexes"),
    "list_search_indexes": lambda name, a, k: {"aggregate": name, "pipeline": [{"$listSearchIndexes": {}}]},
    "create_search_index": _simple("createSearchIndexes"), "create_search_indexes": _simple("createSearchIndexes"),
    "drop_search_index": _simple("dropSearchIndex"), "update_search_index": _simple("updateSearchIndex"),
    "watch": _stream,
}
#: Database methods.
_DATABASE_RULES: dict[str, Rule] = {
    "command": _command_document, "cursor_command": _command_document, "aggregate": _db_aggregate,
    "create_collection": _named("create"), "drop_collection": _named("drop"),
    "list_collection_names": _simple("listCollections"), "list_collections": _simple("listCollections"),
    "validate_collection": _named("validate"), "dereference": _simple("find"), "watch": _stream,
}
#: Client methods, beyond ``start_session`` and ``with_session`` which need no rule.
_CLIENT_RULES: dict[str, Rule] = {
    "bulk_write": lambda name, a, k: {"bulkWrite": 1},
    "list_database_names": lambda name, a, k: {"listDatabases": 1}, "list_databases": lambda name, a, k: {"listDatabases": 1},
    "drop_database": lambda name, a, k: {"dropDatabase": 1}, "server_info": lambda name, a, k: {"buildInfo": 1},
    "watch": lambda name, a, k: {"aggregate": 1, "pipeline": [{"$changeStream": {}}]},
}
#: Callables that are neither commands nor handles; they pass through untouched.
_INERT = frozenset({"close", "aclose", "with_options", "get_collection", "get_database", "get_default_database",
                    "get_io_loop", "__enter__", "__exit__", "__aenter__", "__aexit__", "__getitem__", "__getattr__"})


def _classes() -> tuple[tuple[type, ...], tuple[type, ...], tuple[type, ...], tuple[type, ...]]:
    """The driver classes of clients, databases, collections and sessions, for every installed flavor."""
    from pymongo import MongoClient
    from pymongo.client_session import ClientSession
    from pymongo.collection import Collection
    from pymongo.database import Database

    clients: list[type] = [MongoClient]
    databases: list[type] = [Database]
    collections: list[type] = [Collection]
    sessions: list[type] = [ClientSession]
    try:
        from pymongo.asynchronous.client_session import AsyncClientSession
        from pymongo.asynchronous.collection import AsyncCollection
        from pymongo.asynchronous.database import AsyncDatabase
        from pymongo.asynchronous.mongo_client import AsyncMongoClient

        clients.append(AsyncMongoClient)
        databases.append(AsyncDatabase)
        collections.append(AsyncCollection)
        sessions.append(AsyncClientSession)
    except ImportError:
        pass
    try:
        from motor.core import AgnosticClient, AgnosticClientSession, AgnosticCollection, AgnosticDatabase

        clients.append(AgnosticClient)
        databases.append(AgnosticDatabase)
        collections.append(AgnosticCollection)
        sessions.append(AgnosticClientSession)
    except ImportError:
        pass
    return tuple(clients), tuple(databases), tuple(collections), tuple(sessions)


_CLIENTS, _DATABASES, _COLLECTIONS, _SESSIONS = _classes()


class _SessionView:
    """The Preview session as the handler sees it: its transaction calls join the Preview transaction.

    ``start_transaction`` and ``with_transaction`` run inside the Preview transaction;
    ``commit_transaction`` and ``abort_transaction`` never reach the server and fail the Preview
    with 500, like a raw SQL ``COMMIT``; ``end_session`` leaves the session to the Preview. Anything
    else is the real session's.
    """

    def __init__(self, state: PreviewState) -> None:
        object.__setattr__(self, "_sp_state", state)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._sp_state.session, name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._sp_state.session, name, value)

    # -- joining
    def start_transaction(self, *args: Any, **kwargs: Any) -> Any:
        context = _JoinedTransaction()
        if self._sp_state.engine.flavor == "async":
            async def started() -> Any:
                return context
            return started()  # AsyncMongoClient: ``async with await session.start_transaction()``
        return context

    def with_transaction(self, callback: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return callback(self)

    # -- refusing
    def _refuse(self, what: str) -> Any:
        state = self._sp_state
        error = PreviewTransactionControl(
            f"Preview owns the MongoDB transaction, so the handler's {what} cannot run during Preview.")
        state.scope.capture.refuse(error)
        raise error

    def commit_transaction(self, *args: Any, **kwargs: Any) -> Any:
        return self._refuse("commit_transaction")

    def abort_transaction(self, *args: Any, **kwargs: Any) -> Any:
        return self._refuse("abort_transaction")

    def end_session(self, *args: Any, **kwargs: Any) -> Any:
        if self._sp_state.engine.is_async:
            async def nothing() -> None:
                return None
            return nothing()
        return None

    # -- context managers and awaiting
    def __enter__(self) -> "_SessionView":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    async def __aenter__(self) -> "_SessionView":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    def __await__(self) -> Any:
        async def me() -> "_SessionView":
            return self
        return me().__await__()


class _JoinedTransaction:
    """What ``start_transaction`` returns inside a Preview: entering and leaving it change nothing."""

    def __enter__(self) -> "_JoinedTransaction":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    async def __aenter__(self) -> "_JoinedTransaction":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _Handle:
    """A guarded client, database or collection with the driver's own API."""

    __slots__ = ("_sp_target", "_sp_engine", "_sp_rules", "_sp_name", "_sp_database", "_sp_kind")

    def __init__(self, target: Any, engine: MongoEngine) -> None:
        kind = "client" if isinstance(target, _CLIENTS) else "database" if isinstance(target, _DATABASES) else "collection"
        object.__setattr__(self, "_sp_target", target)
        object.__setattr__(self, "_sp_engine", engine)
        object.__setattr__(self, "_sp_kind", kind)
        object.__setattr__(self, "_sp_rules", {"client": _CLIENT_RULES, "database": _DATABASE_RULES, "collection": _COLLECTION_RULES}[kind])
        object.__setattr__(self, "_sp_name", {"client": "", "database": getattr(target, "name", ""), "collection": getattr(target, "name", "")}[kind])
        object.__setattr__(self, "_sp_database", {"client": None, "database": getattr(target, "name", None),
                                                  "collection": getattr(getattr(target, "database", None), "name", None)}[kind])

    # -- wrapping what comes back
    def _wrap(self, value: Any) -> Any:
        engine = self._sp_engine
        if isinstance(value, _CLIENTS):
            return engine.guarded if value is engine.client else value
        if isinstance(value, (*_DATABASES, *_COLLECTIONS)):
            return _Handle(value, engine)
        return value

    def __getattr__(self, name: str) -> Any:
        target = self._sp_target
        value = getattr(target, name)
        if not callable(value) or isinstance(value, (*_CLIENTS, *_DATABASES, *_COLLECTIONS)):
            return self._wrap(value)
        if name in _INERT:
            return lambda *args, **kwargs: self._wrap(value(*args, **kwargs))
        rule = self._sp_rules.get(name)
        engine = self._sp_engine

        def call(*args: Any, **kwargs: Any) -> Any:
            scope = current_preview()
            if scope is None:
                return self._wrap(value(*args, **kwargs))
            if rule is None:
                # A method this guard does not know: refuse it in a Preview rather than let it escape.
                guard("mongodb", name, WRITE, refused_reason(name))
            args, kwargs, state = self._prepare(rule, name, args, kwargs)  # type: ignore[arg-type]
            if state is None:
                return self._wrap(value(*args, **kwargs))
            engine.acquire(state)
            try:
                result = value(*args, **kwargs)
            except BaseException:
                engine.release(state)
                raise
            if inspect.isawaitable(result):
                return _release_after(result, engine, state)
            engine.release(state)
            return self._wrap(result)

        return call

    def _prepare(self, rule: Rule, name: str, args: tuple, kwargs: dict) -> tuple[tuple, dict, Optional[PreviewState]]:
        """Guard one call during a Preview and give it the Preview session. Raises the guard's error,
        or a refusal for a foreign session."""
        engine = self._sp_engine
        command = rule(self._sp_name, args, kwargs)
        engine.check(command, str(next(iter(command), name)), self._sp_database)
        state = engine.state()
        if state is None or system_database(self._sp_database):
            return args, kwargs, None
        real, replaced = state.session, []
        for item in args:
            if isinstance(item, (*_SESSIONS, _SessionView)):
                if item is not state.view and item is not real:
                    raise refuse_in_preview(  # type: ignore[misc]
                        "A MongoDB call passed its own session during a Preview; the Preview session must carry every command.")
                item = real
            replaced.append(item)
        given = kwargs.get("session")
        if given is not None and given is not state.view and given is not real:
            raise refuse_in_preview(  # type: ignore[misc]
                "A MongoDB call passed its own session during a Preview; the Preview session must carry every command.")
        return tuple(replaced), {**kwargs, "session": real}, state

    def __getitem__(self, name: str) -> Any:
        return self._wrap(self._sp_target[name])

    def __eq__(self, other: object) -> bool:
        return self._sp_target == (other._sp_target if isinstance(other, _Handle) else other)

    def __hash__(self) -> int:
        return hash(self._sp_target)

    def __repr__(self) -> str:
        return f"Guarded({self._sp_target!r})"

    def __bool__(self) -> bool:
        return True


class _GuardedClient(_Handle):
    """The guarded client: in a Preview ``start_session`` and ``with_session`` hand out the Preview session."""

    __slots__ = ()

    def start_session(self, *args: Any, **kwargs: Any) -> Any:
        state = self._sp_engine.state()
        if state is not None:
            return state.view
        return self._sp_target.start_session(*args, **kwargs)


async def _release_after(awaitable: Any, engine: MongoEngine, state: PreviewState) -> Any:
    try:
        return await awaitable
    finally:
        engine.release(state)


def _guarded_client(engine: MongoEngine) -> Any:
    return _GuardedClient(engine.client, engine)


# ----------------------------------------------------------------------------------- the store
class MongoStore(DataStore):
    """A hooked MongoDB client, ready for ``data_stores``."""

    system = "mongodb"

    def __init__(self, engine: MongoEngine, name: Optional[str]) -> None:
        self.engine = engine
        self.name = name
        #: The guarded client handlers must use: same API, Preview session added during a Preview.
        self.client = engine.guarded = _guarded_client(engine)

    def _description(self, detected: tuple[str, Optional[str]]) -> dict[str, Any]:
        mode, reason = detected
        return {"system": "mongodb", **({"name": self.name} if self.name else {}), "mode": mode,
                **({"reason": reason} if reason else {})}

    def describe(self) -> dict[str, Any]:
        return self._description(self.engine.detect())

    async def adescribe(self) -> dict[str, Any]:
        return self._description(await self.engine.adetect())

    def begin(self, scope: RequestScope) -> None:
        self.engine.begin(scope)

    async def abegin(self, scope: RequestScope) -> None:
        await self.engine.abegin(scope)

    def finish(self, scope: RequestScope) -> None:
        self.engine.finish(scope)

    async def afinish(self, scope: RequestScope) -> None:
        await self.engine.afinish(scope)


#: Clients already hooked, by identity: two clients for the same seeds compare equal, so a set would conflate them.
_hooked: dict[int, "weakref.ref[Any]"] = {}


def mongo_store(
    client: Any, *, name: Optional[str] = None, treat_as_read: Optional[Iterable[str]] = None,
    preview_timeout: float = DEFAULT_PREVIEW_TIMEOUT,
) -> MongoStore:
    """Hook a PyMongo, ``AsyncMongoClient`` or Motor client and return the store for ``data_stores``.

    Handlers must use the returned store's ``client``; the original stays unguarded. Create the
    client after importing this module (or pass ``event_listeners=[mongo_monitor]``): the store
    relies on command monitoring and refuses a client without it.

    Args:
        name: A display label for discovery, such as ``catalog``. Never a connection string or host.
        treat_as_read: Commands you state never write, by exact name (compared case-insensitively,
            as MongoDB does). **The guard trusts this list**: a wrongly listed write is not blocked
            in ``guard`` mode.
        preview_timeout: Seconds a Preview may hold its MongoDB transaction; 50 by default, below
            the server's 60-second transaction lifetime. A Preview still running at the limit has
            its transaction aborted and answers 500 without confirmation.
    """
    if preview_timeout is None or not isinstance(preview_timeout, (int, float)) or preview_timeout <= 0:
        raise ValueError("preview_timeout must be a positive number of seconds.")
    label = store_label(name)
    if id(client) in _hooked and _hooked[id(client)]() is client:
        raise TypeError("This MongoDB client is already hooked.")
    engine = MongoEngine(client, read_set(treat_as_read, lambda item: item.lower()), float(preview_timeout))
    try:
        _hooked[id(client)] = weakref.ref(client, lambda _ref, key=id(client): _hooked.pop(key, None))
    except TypeError:  # a client that cannot be weakly referenced is simply not tracked
        pass
    return MongoStore(engine, label)

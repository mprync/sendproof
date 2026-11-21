"""Django ORM implementation of the Sendproof preview provider."""

from __future__ import annotations

import re
import sys
import threading
import time
from typing import Any, Iterable

from django.core.signals import got_request_exception
from django.db import connections, transaction
from django.db.models.signals import post_delete, post_save, pre_delete, pre_save

from sendproof_core import (
    PreviewChange,
    PreviewObservation,
    PreviewProvider,
    PreviewRollbackError,
    PreviewSession,
    PreviewUnavailable,
    RequestScope,
    limits,
)
from sendproof_core.jsonsafe import is_missing, snapshot
from sendproof_core.redaction import describe_parameters, python_type_name
from sendproof_core.scope import current_scope
from sendproof_core.txguard import escapes_transaction, normalize_procedures, server_ended_transaction

STATE_KEY = "django_orm"
_UID = "sendproof_django"
_connected = False

#: The savepoint every Preview opens its transaction with. Django names its own savepoints
#: ``s<thread>_x<n>``, so it never makes this one, and a handler's ``RELEASE`` or ``ROLLBACK TO`` of it
#: is refused like a ``COMMIT``.
SAVEPOINT = "sendproof_preview"

#: Django's own savepoint statements, which may still run after the server ended the Preview transaction.
_SAVEPOINT_CONTROL = re.compile(r"\s*(?:ROLLBACK\s+TO\s+SAVEPOINT|RELEASE\s+SAVEPOINT)\s+[`\"]?s\d+_x\d+[`\"]?\s*$", re.I)


def _raw(alias: str, statement: str) -> None:
    """Run ``statement`` on the alias's DBAPI connection, past the execute wrappers and the SQL log."""
    cursor = connections[alias].connection.cursor()
    try:
        cursor.execute(statement)
    finally:
        cursor.close()

#: One lock per MySQL database alias; a preview holds it from its first transaction until rollback.
_mysql_turns: dict[str, threading.Lock] = {}
_mysql_turns_guard = threading.Lock()


def _take_mysql_turn(alias: str) -> threading.Lock:
    """Wait until no other preview on ``alias`` runs, and answer the held lock.

    InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the
    same key and the first one rolls back, as every preview does, the waiters each hold that shared lock and
    each need the exclusive one, so InnoDB aborts all but one with a deadlock (error 1213). Sent for real,
    the first insert commits and the others get a duplicate-key error instead. MySQL previews therefore take
    turns, as SQLite previews queue behind ``BEGIN IMMEDIATE``.
    """
    with _mysql_turns_guard:
        lock = _mysql_turns.setdefault(alias, threading.Lock())
    lock.acquire()
    return lock


def _enter_atomic(alias: str) -> Any:
    """Open the preview's ``atomic`` block on ``alias`` and answer it.

    On SQLite the outermost block opens with ``BEGIN IMMEDIATE`` unless the database already sets an
    IMMEDIATE or EXCLUSIVE ``transaction_mode``. A deferred ``BEGIN`` takes only a read lock, so two
    previews that read and then write one row both hold it, and the second to write fails at once with
    "database is locked" instead of waiting. Taking the write lock up front makes previews queue instead.
    """
    connection = connections[alias]
    atomic = transaction.atomic(using=alias)
    immediate = (
        connection.vendor == "sqlite"
        and connection.get_autocommit()
        and (getattr(connection, "transaction_mode", None) or "DEFERRED") == "DEFERRED"
    )
    if not immediate:
        atomic.__enter__()
        return atomic
    # Django starts an SQLite transaction through this hook; Django 4.2 to 5.0 always issue a plain BEGIN.
    connection._start_transaction_under_autocommit = lambda: connection.cursor().execute("BEGIN IMMEDIATE")
    try:
        atomic.__enter__()
    finally:
        del connection._start_transaction_under_autocommit  # back to the class's method
    return atomic


def _json_value(value: Any) -> Any:
    shown = snapshot(value)
    return str(value) if is_missing(shown) else shown


class _State:
    """Per-request state: the open transactions, SQL wrappers and captured changes."""

    def __init__(self, aliases: tuple[str, ...], rollback: bool,
                 safe_procedures: frozenset[str] = frozenset()) -> None:
        self.aliases = aliases
        self.rollback = rollback
        #: Procedures the host declared never commit; any other MySQL ``CALL`` is refused.
        self.safe_procedures = safe_procedures
        #: MySQL aliases whose Preview transaction opened with the ``SAVEPOINT`` the backstop checks.
        self.marked: list[str] = []
        #: Aliases whose Preview transaction the server itself ended (a deadlock), with the reason.
        self.ended: dict[str, str] = {}
        self.changes: list[PreviewChange] = []
        self.changes_truncated = False
        self.silent = 0  # >0 while Sendproof runs its own reads
        self.pending: dict[int, dict[str, Any] | None] = {}
        self.atomics: list[tuple[str, Any]] = []
        #: The MySQL turns this preview holds (see ``_take_mysql_turn``), released when it ends.
        self.turns: list[threading.Lock] = []
        self.wrappers: list[tuple[Any, Any]] = []
        self.finished = False
        #: Why the rollback cannot be trusted, set when SQL tried to end the preview transaction.
        self.unsafe: str | None = None

    def add_change(self, change: PreviewChange) -> None:
        if len(self.changes) >= limits.CHANGES:
            self.changes_truncated = True
        else:
            self.changes.append(change)

    # -- SQL capture
    def install_wrappers(self) -> None:
        for alias in self.aliases:
            connection = connections[alias]
            wrapper = self._wrapper
            connection.execute_wrappers.append(wrapper)
            self.wrappers.append((connection, wrapper))

    def remove_wrappers(self) -> None:
        for connection, wrapper in self.wrappers:
            if wrapper in connection.execute_wrappers:
                connection.execute_wrappers.remove(wrapper)
        self.wrappers.clear()

    def _wrapper(self, execute: Any, sql: str, params: Any, many: bool, context: dict) -> Any:
        if self.rollback and not self.finished:
            connection = context.get("connection")
            alias = getattr(connection, "alias", "")
            text = sql if isinstance(sql, str) else str(sql)
            ended = self.ended.get(alias)
            # Once the server ended the Preview transaction, a statement would run outside it. Django's own
            # savepoint rollbacks still pass: they write nothing, and the handler keeps its original error.
            if ended is not None and not _SAVEPOINT_CONTROL.match(text):
                raise PreviewRollbackError(ended)
            # A raw COMMIT (or DDL that MySQL and Oracle commit implicitly) would make the
            # preview's writes durable before the rollback, so it never reaches the database.
            vendor = getattr(connection, "vendor", "")
            reason = escapes_transaction(text, vendor, SAVEPOINT, self.safe_procedures)
            if reason is not None:
                self.unsafe = reason
                raise PreviewRollbackError(reason)
            try:
                return self._capture(execute, sql, params, many, context)
            except Exception as error:
                self._notice_server_rollback(error, alias, vendor)
                raise
        return self._capture(execute, sql, params, many, context)

    def _notice_server_rollback(self, error: BaseException, alias: str, vendor: str) -> None:
        """Remember a MySQL deadlock (or rolled-back lock wait timeout) that ended the Preview transaction."""
        if alias in self.ended:
            return

        def rollback_on_timeout() -> bool:
            try:
                cursor = connections[alias].connection.cursor()
                try:
                    cursor.execute("SELECT @@innodb_rollback_on_timeout")
                    return bool(int(cursor.fetchone()[0]))
                finally:
                    cursor.close()
            except Exception:  # noqa: BLE001 - unknown: assume the transaction is gone
                return True

        reason = server_ended_transaction(error, vendor, rollback_on_timeout)
        if reason is not None:
            self.ended[alias] = reason
            self.unsafe = self.unsafe or reason

    def _capture(self, execute: Any, sql: str, params: Any, many: bool, context: dict) -> Any:
        scope = current_scope()
        if scope is None or self.silent or not scope.capture.is_active:
            return execute(sql, params, many, context)
        started = time.perf_counter()
        try:
            return execute(sql, params, many, context)
        finally:
            duration = (time.perf_counter() - started) * 1000
            try:
                named = _named_parameters(params, many)
                listed, truncated = describe_parameters(sql, named, scope.include_sql_parameter_values)
                rows = getattr(context.get("cursor"), "rowcount", None)
                scope.capture.record_sql(
                    sql, listed, rows_affected=rows if isinstance(rows, int) and rows >= 0 else None,
                    duration_ms=duration, category="django.db.backends", truncated=truncated or many,
                )
            except Exception:  # capture must never interrupt the application
                pass


def _named_parameters(params: Any, many: bool) -> list[tuple[str, Any, str]]:
    if many and params:
        params = next(iter(params), None)
    if isinstance(params, dict):
        return [(str(k), v, python_type_name(v)) for k, v in params.items()]
    if isinstance(params, (list, tuple)):
        return [(f"p{i}", v, python_type_name(v)) for i, v in enumerate(params)]
    return []


def _row(instance: Any) -> dict[str, Any]:
    return {field.column: _json_value(field.value_from_object(instance)) for field in instance._meta.concrete_fields}


def _stored_row(model: Any, using: str, pk: Any, state: _State) -> dict[str, Any] | None:
    """Read the row as stored. The read is not logged."""
    if pk is None:
        return None
    state.silent += 1
    try:
        columns = {f.attname: f.column for f in model._meta.concrete_fields}
        values = model._base_manager.using(using).filter(pk=pk).values(*columns).first()
    finally:
        state.silent -= 1
    return None if values is None else {columns[name]: _json_value(value) for name, value in values.items()}


def _state_for(using: str) -> _State | None:
    scope = current_scope()
    state = scope.extensions.get(STATE_KEY) if scope else None
    return state if state is not None and not state.finished and using in state.aliases else None


def _key(instance: Any) -> dict[str, Any]:
    pk = instance._meta.pk
    return {pk.column: _json_value(pk.value_from_object(instance))}


def _on_pre_save(sender: Any, instance: Any, raw: bool = False, using: str = "default", **kwargs: Any) -> None:
    if (state := _state_for(using)) is not None and not raw:
        state.pending[id(instance)] = _stored_row(sender, using, instance.pk, state)


def _on_post_save(sender: Any, instance: Any, created: bool, raw: bool = False, using: str = "default", **kwargs: Any) -> None:
    if (state := _state_for(using)) is None or raw:
        return
    before = state.pending.pop(id(instance), None)
    state.add_change(PreviewChange(
        "insert" if created else "update", sender._meta.db_table, _key(instance),
        None if created else before, _row(instance),
    ))


def _on_pre_delete(sender: Any, instance: Any, using: str = "default", **kwargs: Any) -> None:
    if (state := _state_for(using)) is not None:
        state.pending[id(instance)] = _stored_row(sender, using, instance.pk, state) or _row(instance)


def _on_post_delete(sender: Any, instance: Any, using: str = "default", **kwargs: Any) -> None:
    if (state := _state_for(using)) is not None:
        before = state.pending.pop(id(instance), None) or _row(instance)
        state.add_change(PreviewChange("delete", sender._meta.db_table, _key(instance), before, None))


def _on_unhandled(sender: Any, request: Any = None, **kwargs: Any) -> None:
    """Django turns unhandled errors into 500 responses; remember them so a preview can fail."""
    scope = current_scope()
    if scope is not None:
        scope.extensions["unhandled"] = sys.exc_info()[1] or True


def install_signals() -> None:
    """Connect the change-capture receivers once per process."""
    global _connected
    if not _connected:
        for signal, receiver in ((pre_save, _on_pre_save), (post_save, _on_post_save),
                                 (pre_delete, _on_pre_delete), (post_delete, _on_post_delete)):
            signal.connect(receiver, weak=False, dispatch_uid=f"{_UID}.{receiver.__name__}")
        got_request_exception.connect(_on_unhandled, weak=False, dispatch_uid=f"{_UID}.unhandled")
        _connected = True


class DjangoOrmPreview(PreviewProvider):
    """Rolls back and observes the writes of an application that uses the Django ORM.

    ``using`` lists the database aliases to enroll (default: ``("default",)``). ``database`` is a
    public label for the workbench; never put a connection string in it.

    On MySQL and MariaDB a Preview refuses ``CALL``, because a stored procedure can commit the
    Preview transaction. ``safe_procedures`` lists procedures the host declares never commit, by
    exact name (optionally ``schema.name``; case-insensitive, like MySQL): a ``CALL`` of one of
    them is allowed. The binding trusts the declaration; a listed procedure that does commit is
    caught by the savepoint check before the rollback, which answers 500, but its writes stay.
    """

    def __init__(self, using: Iterable[str] = ("default",), database: str | None = None,
                 safe_procedures: Iterable[str] = ()) -> None:
        self.aliases = tuple(using)
        if not self.aliases:
            raise ValueError("Pass at least one database alias.")
        self.database = database
        self.safe_procedures = normalize_procedures(safe_procedures)
        install_signals()

    @property
    def system(self) -> str | None:  # type: ignore[override]
        """The SQL provider id the workbench shows a store mark for: Django's ``vendor`` of the first database."""
        try:
            return str(connections[self.aliases[0]].vendor)
        except Exception:
            return None

    def begin(self, scope: RequestScope) -> PreviewSession:
        state = _State(self.aliases, rollback=True, safe_procedures=self.safe_procedures)
        scope.extensions[STATE_KEY] = state
        try:
            for alias in self.aliases:
                connection = connections[alias]
                if not connection.features.supports_transactions:
                    raise PreviewUnavailable(f"Database '{alias}' does not support transactions.")
                if connection.vendor == "mysql":
                    state.turns.append(_take_mysql_turn(alias))
                state.atomics.append((alias, _enter_atomic(alias)))
                # The backstop's mark, made first thing in the Preview transaction (see ``rollback``).
                _raw(alias, "SAVEPOINT " + SAVEPOINT)
                state.marked.append(alias)
            state.install_wrappers()
        except BaseException:
            _Session(state).close()
            raise
        return _Session(state)

    def begin_observation(self, scope: RequestScope) -> PreviewObservation | None:
        state = _State(self.aliases, rollback=False)
        scope.extensions[STATE_KEY] = state
        state.install_wrappers()
        return _Observation(state)


class _Observation(PreviewObservation):
    def __init__(self, state: _State) -> None:
        self._state = state

    @property
    def changes(self) -> list[PreviewChange]:
        return self._state.changes

    @property
    def changes_truncated(self) -> bool:
        return self._state.changes_truncated

    def close(self) -> None:
        self._state.finished = True
        self._state.remove_wrappers()


class _Session(PreviewSession):
    """Ends every enrolled ``atomic`` block with a rollback and confirms it."""

    def __init__(self, state: _State) -> None:
        self._state = state
        self._rolled_back = False

    @property
    def changes(self) -> list[PreviewChange]:
        return self._state.changes

    @property
    def changes_truncated(self) -> bool:
        return self._state.changes_truncated

    def rollback(self) -> None:
        state = self._state
        errors: list[BaseException] = []
        for alias in state.marked:
            # The backstop, on every database: the savepoint made when the Preview transaction opened
            # must still exist. Any commit, explicit or implicit, erases every savepoint, and the driver
            # (or MySQL with autocommit off) then opens a new transaction by itself, so a savepoint made now would
            # prove nothing. Error 1305 (or a lost connection) means the rollback can't be confirmed.
            try:
                _raw(alias, "ROLLBACK TO SAVEPOINT " + SAVEPOINT)
            except Exception:  # noqa: BLE001 - reported through ``unsafe``
                state.unsafe = state.unsafe or (
                    "The Preview transaction was committed before its rollback (its savepoint is gone), "
                    "so the Preview can't be confirmed."
                )
        while state.atomics:
            alias, atomic = state.atomics.pop()
            try:
                transaction.set_rollback(True, using=alias)
                atomic.__exit__(None, None, None)
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)
        if errors:
            raise PreviewRollbackError("The database rollback could not be confirmed.") from errors[0]
        if state.unsafe:
            raise PreviewRollbackError(state.unsafe)
        self._rolled_back = True

    def close(self) -> None:
        state = self._state
        state.finished = True
        state.remove_wrappers()
        failure: BaseException | None = None
        try:
            while state.atomics:  # only when rollback() did not run or failed part way
                alias, atomic = state.atomics.pop()
                try:
                    atomic.__exit__(RuntimeError, RuntimeError("preview abandoned"), None)
                except RuntimeError:
                    pass
                except BaseException as error:  # noqa: BLE001
                    failure = failure or error
        finally:
            # The preview's transactions have ended, so the next MySQL preview may run.
            while state.turns:
                state.turns.pop().release()
        if failure is not None:
            raise failure

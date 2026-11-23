"""SQLAlchemy implementation of the Sendproof preview provider."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterable
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.types import NullType

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
from sendproof_core.provider import run_in_thread
from sendproof_core.scope import current_scope
from sendproof_core.sessions import HeldPart, StepFailed, StoreEnded, savepoint

from . import changes as change_capture
from .connection import SAVEPOINT, Hold, ensure_supported
from .turns import take_turn
from sendproof_core.redaction import describe_parameters, python_type_name
from sendproof_core.txguard import escapes_transaction, normalize_procedures, server_ended_transaction

try:  # AsyncEngine support needs greenlet; synchronous use does not.
    from sqlalchemy.ext.asyncio import AsyncEngine
except ImportError:  # pragma: no cover - depends on the installed extras
    class AsyncEngine:  # type: ignore[no-redef]
        """Placeholder so that isinstance checks work without greenlet."""


async def greenlet_spawn(function: Any, *args: Any) -> Any:
    """Run ``function`` where SQLAlchemy's async adapters may await."""
    from sqlalchemy.util import greenlet_spawn as spawn

    return await spawn(function, *args)


STATE_KEY = change_capture.STATE_KEY
_STARTED = "_sendproof_started"


class _State:
    """Per-request state shared by listeners, the pool hook and the session."""

    def __init__(self, engines: frozenset[Engine], rollback: bool,
                 safe_procedures: frozenset[str] = frozenset()) -> None:
        self.engines = engines
        self.rollback = rollback
        #: Procedures the host declared never commit; any other MySQL ``CALL`` is refused.
        self.safe_procedures = safe_procedures
        self.holds: dict[Engine, Hold] = {}
        self.changes: list[PreviewChange] = []
        self.changes_truncated = False
        self.finished = False
        self.held = False
        self.unsafe: str | None = None
        self.lock = threading.RLock()

    def add_change(self, change: PreviewChange) -> None:
        with self.lock:
            if len(self.changes) >= limits.CHANGES:
                self.changes_truncated = True
            else:
                self.changes.append(change)

    def connect(self, engine: Engine, original: Any) -> Any:
        """Answer ``engine.raw_connection()`` from the shared, rollback-only connection."""
        with self.lock:
            if engine not in self.holds:
                self.open_hold(engine, original)
            return self.holds[engine].connect()

    def open_hold(self, engine: Engine, original: Any, *, held: bool = False) -> None:
        release_turn = take_turn(engine, nowait=held)
        try:
            fairy = original()
            try:
                hold = self.holds[engine] = Hold(engine, fairy, held=held)
            except BaseException:
                fairy.invalidate()
                fairy.close()
                raise
        except BaseException:
            if release_turn is not None:
                release_turn()
            raise
        hold.release_turn = release_turn


class _Instrumentation:
    """Listeners and the ``raw_connection`` hook installed on one engine."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._original = engine.raw_connection
        engine.raw_connection = self._raw_connection  # type: ignore[method-assign]
        event.listen(engine, "before_cursor_execute", self._before)
        event.listen(engine, "after_cursor_execute", self._after)
        event.listen(engine, "handle_error", self._error)

    def remove(self) -> None:
        event.remove(self.engine, "before_cursor_execute", self._before)
        event.remove(self.engine, "after_cursor_execute", self._after)
        event.remove(self.engine, "handle_error", self._error)
        self.engine.__dict__.pop("raw_connection", None)

    def _error(self, context: Any) -> None:
        """Notice when the server ended the Preview transaction itself; the handler still gets the error."""
        scope = current_scope()
        state = scope.extensions.get(STATE_KEY) if scope else None
        hold = state.holds.get(self.engine) if state is not None and state.rollback and not state.finished else None
        if hold is None or hold.ended:
            return

        def rollback_on_timeout() -> bool:
            try:
                cursor = hold.proxy._tb_real.cursor()
                try:
                    cursor.execute("SELECT @@innodb_rollback_on_timeout")
                    return bool(int(cursor.fetchone()[0]))
                finally:
                    cursor.close()
            except Exception:  # noqa: BLE001 - unknown: assume the transaction is gone
                return True

        reason = server_ended_transaction(context.original_exception, self.engine.dialect.name, rollback_on_timeout)
        if state.held and context.is_disconnect:
            reason = "The SQL server closed the held Preview connection."
        if reason is not None:
            hold.ended = hold.unsafe = reason

    def _raw_connection(self) -> Any:
        scope = current_scope()
        state = scope.extensions.get(STATE_KEY) if scope else None
        if state is not None and state.held and state.finished:
            raise PreviewRollbackError("The held Preview request has ended.")
        if state is None or not state.rollback or state.finished:
            return self._original()
        return state.connect(self.engine, self._original)

    def _before(self, conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool) -> None:
        scope = current_scope()
        if scope is None:
            return
        state = scope.extensions.get(STATE_KEY)
        if state is not None and state.held and state.finished:
            raise PreviewRollbackError("The held Preview request has ended.")
        if state is not None and state.rollback and not state.finished:
            hold = state.holds.get(self.engine)
            if hold is not None and hold.ended:
                # The server already ended the Preview transaction: this statement would run outside it.
                raise PreviewRollbackError(hold.ended)
            if conn.get_execution_options().get("isolation_level") == "AUTOCOMMIT":
                state.unsafe = "A statement ran in AUTOCOMMIT mode, which cannot be rolled back."
            # Refuse COMMIT, END, implicit-commit DDL and the like before they reach the driver:
            # flagging them afterwards would be too late, the earlier writes would be durable.
            reason = escapes_transaction(statement, conn.dialect.name, SAVEPOINT, state.safe_procedures)
            if reason is not None:
                state.unsafe = reason
                raise PreviewRollbackError(reason)
        try:
            setattr(context, _STARTED, time.perf_counter())
        except AttributeError:
            pass

    def _after(self, conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool) -> None:
        scope = current_scope()
        if scope is None or not scope.capture.is_active:
            return
        started = getattr(context, _STARTED, None)
        duration = 0.0 if started is None else (time.perf_counter() - started) * 1000
        listed, truncated = _parameters(statement, parameters, context, scope.include_sql_parameter_values)
        rows = cursor.rowcount if isinstance(cursor.rowcount, int) and cursor.rowcount >= 0 else None
        scope.capture.record_sql(
            statement, listed, rows_affected=rows, duration_ms=duration,
            category="sqlalchemy.engine", truncated=truncated or executemany,
        )


def _parameters(statement: str, parameters: Any, context: Any, show_values: bool) -> tuple[list[tuple[str, str | None, str]], bool]:
    """Name, stringify and redact the bound parameters of a statement."""
    compiled = getattr(context, "compiled", None)
    named: list[tuple[str, Any, str]] = []
    if compiled is not None and getattr(context, "compiled_parameters", None):
        for name, value in context.compiled_parameters[0].items():
            bind = compiled.binds.get(name)
            kind = type(bind.type).__name__ if bind is not None and not isinstance(bind.type, NullType) else None
            named.append((name, value, kind or python_type_name(value)))
    elif isinstance(parameters, dict):
        named = [(str(k), v, python_type_name(v)) for k, v in parameters.items()]
    elif isinstance(parameters, (list, tuple)):
        rows = parameters[0] if parameters and isinstance(parameters[0], (list, tuple, dict)) else parameters
        named = [(f"p{i}", v, python_type_name(v)) for i, v in enumerate(rows.values() if isinstance(rows, dict) else rows)]
    return describe_parameters(statement, named, show_values)


class SQLAlchemyPreview(PreviewProvider):
    """Rolls back and observes the writes of an application that uses SQLAlchemy.

    ``engines`` may be :class:`~sqlalchemy.engine.Engine` or
    :class:`~sqlalchemy.ext.asyncio.AsyncEngine` instances. ``database`` is a public label for the
    workbench; never put a connection string in it.

    On MySQL and MariaDB a Preview refuses ``CALL``, because a stored procedure can commit the
    Preview transaction. ``safe_procedures`` lists procedures the host declares never commit, by
    exact name (optionally ``schema.name``; case-insensitive, like MySQL): a ``CALL`` of one of
    them is allowed. The binding trusts the declaration, so a listed procedure that does commit
    makes the Preview's writes durable; the savepoint check before the rollback then answers 500.
    """

    def __init__(self, *engines: Engine | AsyncEngine, database: str | None = None,
                 safe_procedures: Iterable[str] = ()) -> None:
        if not engines:
            raise ValueError("Pass at least one engine.")
        self.database = database
        self._safe_procedures = normalize_procedures(safe_procedures)
        self._async = {e.sync_engine for e in engines if isinstance(e, AsyncEngine)}
        self._engines = frozenset(e.sync_engine if isinstance(e, AsyncEngine) else e for e in engines)
        first = (engines[0].sync_engine if isinstance(engines[0], AsyncEngine) else engines[0]).dialect
        #: The SQL provider id the workbench shows a store mark for.
        self.system = "mariadb" if first.name == "mysql" and getattr(first, "is_mariadb", False) else first.name
        self._instrumentation = [
            _Instrumentation(engine) for engine in self._engines if "raw_connection" not in engine.__dict__
        ]
        change_capture.install()

    # ------------------------------------------------------------------ provider
    def begin(self, scope: RequestScope) -> PreviewSession:
        for engine in self._engines:
            ensure_supported(engine)
        state = _State(self._engines, rollback=True, safe_procedures=self._safe_procedures)
        scope.extensions[STATE_KEY] = state
        return _Session(state, self._async)

    def begin_observation(self, scope: RequestScope) -> PreviewObservation | None:
        state = _State(self._engines, rollback=False)
        scope.extensions[STATE_KEY] = state
        return _Observation(state)

    def supports_held(self, asynchronous: bool) -> bool:
        if self._async and not asynchronous:
            return False
        for engine in self._engines:
            try:
                ensure_supported(engine)
            except PreviewUnavailable:
                return False
            if engine.dialect.name == "oracle" or (
                engine.dialect.name == "sqlite" and (
                    engine.url.database in (None, "", ":memory:")
                    or engine.url.query.get("mode") == "memory"
                    or str(engine.url.database).startswith("file::memory:")
                )
            ):
                return False
        return True

    def _held(self) -> "_Held":
        return _Held(self._engines, self._async, self._safe_procedures)

    def hold(self) -> HeldPart:
        part = self._held()
        try:
            part.open()
        except BaseException:
            part.close()
            raise
        return part

    async def ahold(self) -> HeldPart:
        part = self._held()
        try:
            await part.ainvoke(part.open)
        except BaseException:
            await part.ainvoke(part.close)
            raise
        return part

    def uninstall(self) -> None:
        """Remove the hooks from the engines. Meant for tests and shutdown."""
        for hook in self._instrumentation:
            hook.remove()
        self._instrumentation.clear()


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


class _Session(PreviewSession):
    """Rolls back every connection the request used and confirms it."""

    def __init__(self, state: _State, async_engines: set[Engine]) -> None:
        self._state = state
        self._async = async_engines
        self._rolled_back = False

    @property
    def changes(self) -> list[PreviewChange]:
        return self._state.changes

    @property
    def changes_truncated(self) -> bool:
        return self._state.changes_truncated

    # ----------------------------------------------------------------- rollback
    def _check_before(self) -> None:
        unsafe = self._state.unsafe or next((h.unsafe for h in self._state.holds.values() if h.unsafe), None)
        if unsafe:
            raise PreviewRollbackError(unsafe)

    def _rollback_hold(self, hold: Hold) -> BaseException | None:
        if not hold.unsafe:
            # The backstop, on every dialect: the savepoint the Preview opened its transaction with must
            # still exist. Any commit, explicit or implicit, erases every savepoint, and the driver (or
            # MySQL with autocommit off) then opens a new transaction by itself, so only a savepoint made
            # at the start, never one made now, proves the Preview transaction is the one still open.
            # ROLLBACK TO rather than RELEASE: it also works on a PostgreSQL transaction aborted by an
            # error, which commits nothing and must not fail the Preview.
            try:
                hold.run("ROLLBACK TO SAVEPOINT " + SAVEPOINT)
            except BaseException as error:  # noqa: BLE001 - "no such savepoint" (MySQL 1305), or a lost connection
                hold.unsafe = (
                    "The Preview transaction was committed before its rollback (its savepoint is gone), "
                    "so the Preview can't be confirmed."
                )
                if not isinstance(error, Exception):
                    raise
        try:
            hold.proxy._tb_real.rollback()
        except BaseException as error:  # noqa: BLE001 - reported through PreviewRollbackError
            return error
        return None

    def rollback(self) -> None:
        if self._async & set(self._state.holds):
            raise PreviewUnavailable("Use the async API for AsyncEngine previews.")
        self._finish([self._rollback_hold(h) for h in list(self._state.holds.values())])

    async def arollback(self) -> None:
        results: list[BaseException | None] = []
        for engine, hold in list(self._state.holds.items()):
            if engine in self._async:
                results.append(await greenlet_spawn(self._rollback_hold, hold))
            else:
                results.append(await run_in_thread(self._rollback_hold, hold))
        self._finish(results)

    def _finish(self, errors: list[BaseException | None]) -> None:
        failures = [e for e in errors if e is not None]
        self._check_before()
        if failures:
            raise PreviewRollbackError("The database rollback could not be confirmed.") from failures[0]
        self._rolled_back = True

    # -------------------------------------------------------------------- close
    def _release(self, hold: Hold) -> BaseException | None:
        try:
            if not self._rolled_back:
                # Never hand a connection with unconfirmed writes back to the pool.
                hold.fairy.invalidate()
            hold.fairy.close()
        except BaseException as error:  # noqa: BLE001
            return error
        finally:
            # The transaction has ended with the connection, so the next MySQL preview may run.
            release_turn, hold.release_turn = hold.release_turn, None
            if release_turn is not None:
                release_turn()
        return None

    def close(self) -> None:
        self._state.finished = True
        holds, self._state.holds = list(self._state.holds.items()), {}
        errors = [self._release(h) for _, h in holds]
        _raise_first(errors)

    async def aclose(self) -> None:
        self._state.finished = True
        holds, self._state.holds = list(self._state.holds.items()), {}
        errors = []
        for engine, hold in holds:
            if engine in self._async:
                errors.append(await greenlet_spawn(self._release, hold))
            else:
                errors.append(await run_in_thread(self._release, hold))
        _raise_first(errors)


def _raise_first(errors: list[BaseException | None]) -> None:
    for error in errors:
        if error is not None:
            raise error


class _Held(HeldPart):
    """Reuse the rollback-only DBAPI proxy while resetting the request's ORM capture."""

    def __init__(self, engines: frozenset[Engine], async_engines: set[Engine], procedures: frozenset[str]) -> None:
        self.engines = sorted(engines, key=id)
        self.async_engines = async_engines
        self.procedures = procedures
        self.state = _State(engines, rollback=True, safe_procedures=procedures)
        self.sqlite_pools: dict[Engine, Any] = {}

    def _open_engine(self, engine: Engine) -> None:
        if engine.dialect.name != "sqlite":
            self.state.open_hold(engine, engine.raw_connection, held=True)
            return
        # Keep the application's pool available for readers, even with a one-slot pool.
        pool = engine.pool.recreate()
        try:
            self.state.open_hold(engine, pool.connect, held=True)
        except BaseException:
            pool.dispose()
            raise
        self.sqlite_pools[engine] = pool

    def open(self) -> None:
        for engine in self.engines:
            self._open_engine(engine)

    def _check(self) -> None:
        holds = self.state.holds.values()
        if any(hold.ended for hold in holds):
            raise StoreEnded("The SQL server ended the Preview transaction.")
        _Session(self.state, self.async_engines)._check_before()

    def _attach_engine(self, engine: Engine, step: int) -> None:
        self._control(engine, "SAVEPOINT " + savepoint(step), "SAVEPOINT " + SAVEPOINT)

    def _control(self, engine: Engine, *statements: str) -> None:
        hold = self.state.holds[engine]
        try:
            hold.run(*statements)
        except Exception as error:
            dialect = engine.dialect
            if isinstance(error, dialect.dbapi.Error) and dialect.is_disconnect(error, hold.proxy._tb_real, None):
                raise StoreEnded("The SQL server closed the held Preview connection.") from error
            raise

    def _bind(self, scope: RequestScope) -> None:
        previous = self.state
        self.state = _State(previous.engines, rollback=True, safe_procedures=self.procedures)
        self.state.held = True
        self.state.holds = previous.holds
        scope.extensions[STATE_KEY] = self.state

    def attach(self, scope: RequestScope, step: int) -> None:
        self._check()
        for engine in self.engines:
            self._attach_engine(engine, step)
        self._bind(scope)

    def _collect_engine(self, engine: Engine) -> None:
        try:
            # The marker predates the handler. Creating a new marker would miss an implicit commit.
            self._control(engine, "RELEASE SAVEPOINT " + SAVEPOINT)
        except Exception as error:
            if getattr(error, "sqlstate", getattr(error, "pgcode", None)) == "25P02":
                raise StepFailed("The Preview statement failed inside PostgreSQL.") from error
            raise

    def _changes(self, scope: RequestScope) -> None:
        scope.store_changes[:0] = self.state.changes
        scope.store_changes_truncated |= self.state.changes_truncated

    def collect(self, scope: RequestScope, step: int) -> None:
        self.state.finished = True
        self._check()
        for engine in self.engines:
            self._collect_engine(engine)
        self._changes(scope)

    def detach(self, scope: RequestScope) -> None:
        state = scope.extensions.get(STATE_KEY)
        if state is not None:
            state.finished = True

    def _rewind_engine(self, engine: Engine, step: int) -> None:
        self._control(engine, "ROLLBACK TO SAVEPOINT " + savepoint(step), "RELEASE SAVEPOINT " + savepoint(step))

    def rewind(self, step: int) -> None:
        self.state.finished = True
        self._check()
        for engine in self.engines:
            self._rewind_engine(engine, step)

    def _close_engine(self, engine: Engine) -> None:
        hold = self.state.holds.pop(engine)
        cleanup = _Session(self.state, self.async_engines)
        try:
            hold.proxy._tb_real.rollback()
            cleanup._rolled_back = not bool(hold.unsafe)
        finally:
            try:
                _raise_first([cleanup._release(hold)])
            finally:
                pool = self.sqlite_pools.pop(engine, None)
                if pool is not None:
                    pool.dispose()

    def close(self) -> None:
        errors = []
        for engine in tuple(self.state.holds):
            try:
                self._close_engine(engine)
            except BaseException as error:
                errors.append(error)
        _raise_first(errors)

    async def ainvoke(self, method: Any, *args: Any) -> Any:
        if not self.async_engines:
            return await super().ainvoke(method, *args)
        if method == self.detach:
            return self.detach(*args)
        engine_methods = {
            self.open: self._open_engine, self.attach: self._attach_engine,
            self.collect: self._collect_engine, self.rewind: self._rewind_engine, self.close: self._close_engine,
        }
        errors = []
        if method in (self.attach, self.collect, self.rewind):
            if method != self.attach:
                self.state.finished = True
            self._check()
        for engine in tuple(self.state.holds) if method == self.close else self.engines:
            invoke = greenlet_spawn if engine in self.async_engines else run_in_thread
            values = args[-1:] if method in (self.attach, self.rewind) else ()
            try:
                await invoke(engine_methods[method], engine, *values)
            except BaseException as error:
                if method != self.close:
                    raise
                errors.append(error)
        _raise_first(errors)
        if method == self.attach:
            self._bind(args[0])
        elif method == self.collect:
            self._changes(args[0])

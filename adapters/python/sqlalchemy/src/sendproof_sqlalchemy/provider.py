"""SQLAlchemy implementation of the Sendproof preview provider."""

from __future__ import annotations

import threading
import time
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

from . import changes as change_capture
from .connection import SAVEPOINT, Hold, ensure_supported
from sendproof_core.redaction import describe_parameters, python_type_name
from sendproof_core.txguard import escapes_transaction

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

    def __init__(self, engines: frozenset[Engine], rollback: bool) -> None:
        self.engines = engines
        self.rollback = rollback
        self.holds: dict[Engine, Hold] = {}
        self.changes: list[PreviewChange] = []
        self.changes_truncated = False
        self.finished = False
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
            hold = self.holds.get(engine)
            if hold is None:
                fairy = original()
                try:
                    hold = self.holds[engine] = Hold(engine, fairy)
                except BaseException:
                    fairy.invalidate()
                    fairy.close()
                    raise
        return hold.connect()


class _Instrumentation:
    """Listeners and the ``raw_connection`` hook installed on one engine."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._original = engine.raw_connection
        engine.raw_connection = self._raw_connection  # type: ignore[method-assign]
        event.listen(engine, "before_cursor_execute", self._before)
        event.listen(engine, "after_cursor_execute", self._after)

    def remove(self) -> None:
        event.remove(self.engine, "before_cursor_execute", self._before)
        event.remove(self.engine, "after_cursor_execute", self._after)
        self.engine.__dict__.pop("raw_connection", None)

    def _raw_connection(self) -> Any:
        scope = current_scope()
        state = scope.extensions.get(STATE_KEY) if scope else None
        if state is None or not state.rollback or state.finished:
            return self._original()
        return state.connect(self.engine, self._original)

    def _before(self, conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, executemany: bool) -> None:
        scope = current_scope()
        if scope is None:
            return
        state = scope.extensions.get(STATE_KEY)
        if state is not None and state.rollback and not state.finished:
            if conn.get_execution_options().get("isolation_level") == "AUTOCOMMIT":
                state.unsafe = "A statement ran in AUTOCOMMIT mode, which cannot be rolled back."
            # Refuse COMMIT, END, implicit-commit DDL and the like before they reach the driver:
            # flagging them afterwards would be too late, the earlier writes would be durable.
            reason = escapes_transaction(statement, conn.dialect.name, SAVEPOINT)
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
    """

    def __init__(self, *engines: Engine | AsyncEngine, database: str | None = None) -> None:
        if not engines:
            raise ValueError("Pass at least one engine.")
        self.database = database
        self._async = {e.sync_engine for e in engines if isinstance(e, AsyncEngine)}
        self._engines = frozenset(e.sync_engine if isinstance(e, AsyncEngine) else e for e in engines)
        self._instrumentation = [
            _Instrumentation(engine) for engine in self._engines if "raw_connection" not in engine.__dict__
        ]
        change_capture.install()

    # ------------------------------------------------------------------ provider
    def begin(self, scope: RequestScope) -> PreviewSession:
        for engine in self._engines:
            ensure_supported(engine)
        state = _State(self._engines, rollback=True)
        scope.extensions[STATE_KEY] = state
        return _Session(state, self._async)

    def begin_observation(self, scope: RequestScope) -> PreviewObservation | None:
        state = _State(self._engines, rollback=False)
        scope.extensions[STATE_KEY] = state
        return _Observation(state)

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

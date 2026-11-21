"""Django ORM implementation of the Test Bench preview provider."""

from __future__ import annotations

import sys
import time
from typing import Any, Iterable

from django.core.signals import got_request_exception
from django.db import connections, transaction
from django.db.models.signals import post_delete, post_save, pre_delete, pre_save

from testbench_core import (
    PreviewChange,
    PreviewObservation,
    PreviewProvider,
    PreviewRollbackError,
    PreviewSession,
    PreviewUnavailable,
    RequestScope,
    limits,
)
from testbench_core.jsonsafe import is_missing, snapshot
from testbench_core.redaction import describe_parameters, python_type_name
from testbench_core.scope import current_scope

STATE_KEY = "django_orm"
_UID = "testbench_django"
_connected = False


def _json_value(value: Any) -> Any:
    shown = snapshot(value)
    return str(value) if is_missing(shown) else shown


class _State:
    """Per-request state: the open transactions, SQL wrappers and captured changes."""

    def __init__(self, aliases: tuple[str, ...], rollback: bool) -> None:
        self.aliases = aliases
        self.rollback = rollback
        self.changes: list[PreviewChange] = []
        self.changes_truncated = False
        self.silent = 0  # >0 while Test Bench runs its own reads
        self.pending: dict[int, dict[str, Any] | None] = {}
        self.atomics: list[tuple[str, Any]] = []
        self.wrappers: list[tuple[Any, Any]] = []
        self.finished = False

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
    """

    def __init__(self, using: Iterable[str] = ("default",), database: str | None = None) -> None:
        self.aliases = tuple(using)
        if not self.aliases:
            raise ValueError("Pass at least one database alias.")
        self.database = database
        install_signals()

    def begin(self, scope: RequestScope) -> PreviewSession:
        state = _State(self.aliases, rollback=True)
        scope.extensions[STATE_KEY] = state
        try:
            for alias in self.aliases:
                connection = connections[alias]
                if not connection.features.supports_transactions:
                    raise PreviewUnavailable(f"Database '{alias}' does not support transactions.")
                atomic = transaction.atomic(using=alias)
                atomic.__enter__()
                state.atomics.append((alias, atomic))
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
        while state.atomics:
            alias, atomic = state.atomics.pop()
            try:
                transaction.set_rollback(True, using=alias)
                atomic.__exit__(None, None, None)
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)
        if errors:
            raise PreviewRollbackError("The database rollback could not be confirmed.") from errors[0]
        self._rolled_back = True

    def close(self) -> None:
        state = self._state
        state.finished = True
        state.remove_wrappers()
        failure: BaseException | None = None
        while state.atomics:  # only when rollback() did not run or failed part way
            alias, atomic = state.atomics.pop()
            try:
                atomic.__exit__(RuntimeError, RuntimeError("preview abandoned"), None)
            except RuntimeError:
                pass
            except BaseException as error:  # noqa: BLE001
                failure = failure or error
        if failure is not None:
            raise failure

"""ORM change capture through ``Session`` flush events."""

from __future__ import annotations

from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import NO_VALUE

from testbench_core import PreviewChange
from testbench_core.scope import current_scope

STATE_KEY = "sqlalchemy"
_PENDING = "testbench.pending"
_installed = False


def install() -> None:
    """Register the flush listeners once per process."""
    global _installed
    if not _installed:
        event.listen(Session, "before_flush", _before_flush)
        event.listen(Session, "after_flush", _after_flush)
        event.listen(Session, "after_rollback", _discard_pending)
        _installed = True


def uninstall() -> None:
    """Remove the flush listeners (used by tests)."""
    global _installed
    if _installed:
        event.remove(Session, "before_flush", _before_flush)
        event.remove(Session, "after_flush", _after_flush)
        event.remove(Session, "after_rollback", _discard_pending)
        _installed = False


def _state_for(session: Session, mapper: Any):
    scope = current_scope()
    state = scope.extensions.get(STATE_KEY) if scope else None
    if state is None or state.finished:
        return None
    try:
        bind = session.get_bind(mapper=mapper)
    except Exception:
        return None
    return state if getattr(bind, "engine", bind) in state.engines else None


def _columns(mapper: Any):
    for prop in mapper.column_attrs:
        yield prop.key, prop.columns[0].name


def _current_row(instance_state: Any, mapper: Any) -> dict[str, Any]:
    return {name: instance_state.dict[key] for key, name in _columns(mapper) if key in instance_state.dict}


def _original_row(instance_state: Any, mapper: Any) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for key, name in _columns(mapper):
        if key in instance_state.committed_state:
            old = instance_state.committed_state[key]
            if old is not NO_VALUE:
                row[name] = old
        elif key in instance_state.dict:
            row[name] = instance_state.dict[key]
    return row


def _key(mapper: Any, row: dict[str, Any], instance_state: Any) -> dict[str, Any]:
    key = {}
    for column in mapper.primary_key:
        prop = mapper.get_property_by_column(column)
        key[column.name] = row.get(column.name, instance_state.dict.get(prop.key))
    return key


def _before_flush(session: Session, flush_context: Any, instances: Any) -> None:
    pending: list[tuple[str, Any, Any, dict | None]] = []
    for instance in list(session.new):
        instance_state = inspect(instance)
        if _state_for(session, instance_state.mapper) is not None:
            pending.append(("insert", instance_state, instance_state.mapper, None))
    for instance in list(session.dirty):
        instance_state = inspect(instance)
        if instance_state.modified and session.is_modified(instance) and \
                _state_for(session, instance_state.mapper) is not None:
            pending.append(("update", instance_state, instance_state.mapper, _original_row(instance_state, instance_state.mapper)))
    for instance in list(session.deleted):
        instance_state = inspect(instance)
        if _state_for(session, instance_state.mapper) is not None:
            pending.append(("delete", instance_state, instance_state.mapper, _original_row(instance_state, instance_state.mapper)))
    session.info[_PENDING] = pending


def _after_flush(session: Session, flush_context: Any) -> None:
    pending = session.info.pop(_PENDING, None)
    if not pending:
        return
    for operation, instance_state, mapper, before in pending:
        state = _state_for(session, mapper)
        if state is None:
            continue
        after = None if operation == "delete" else _current_row(instance_state, mapper)
        key = _key(mapper, after or before or {}, instance_state)
        state.add_change(PreviewChange(operation, mapper.local_table.fullname, key, before, after))


def _discard_pending(session: Session) -> None:
    session.info.pop(_PENDING, None)


__all__ = ["STATE_KEY", "install", "uninstall"]

"""Per-request capture of effects, logs and SQL for previews and observed sends."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from . import jsonsafe, limits

_LEVELS = {
    logging.DEBUG: "Debug",
    logging.INFO: "Information",
    logging.WARNING: "Warning",
    logging.ERROR: "Error",
    logging.CRITICAL: "Critical",
}


@dataclass(frozen=True)
class CaptureTiming:
    """Final timing in milliseconds."""

    auth: float
    handler: float
    db: float
    query_count: int
    serialize: float

    def server_timing(self) -> str:
        """Render the ``Server-Timing`` header value."""
        return (
            f"auth;dur={self.auth:.3f}, handler;dur={self.handler:.3f}, "
            f'db;dur={self.db:.3f};desc="{self.query_count} queries", serialize;dur={self.serialize:.3f}'
        )

    def as_trace(self) -> dict[str, Any]:
        """Return the trace schema ``timing`` object."""
        return {
            "auth": self.auth,
            "handler": self.handler,
            "db": self.db,
            "queryCount": self.query_count,
            "serialize": self.serialize,
        }


@dataclass
class CaptureSnapshot:
    """Immutable result of :meth:`Capture.finish`."""

    effects: list[dict[str, Any]]
    logs: list[dict[str, Any]]
    logs_truncated: bool
    effects_truncated: bool


@dataclass
class Capture:
    """Collects the effects and logs of a single request.

    ``rollback`` is true for a preview, where effects must be suppressed by the host.
    For an observed send the effects are recorded as intended deliveries and the host still
    delivers them.
    """

    rollback: bool
    started: float = field(default_factory=time.perf_counter)
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)
    _effects: list[dict[str, Any]] = field(default_factory=list, repr=False)
    _logs: list[dict[str, Any]] = field(default_factory=list, repr=False)
    _active: bool = True
    _logs_truncated: bool = False
    _effects_truncated: bool = False
    _log_size: int = 0
    _effect_size: int = 0
    _db_ms: float = 0.0
    _queries: int = 0
    _serialize_ms: float = 0.0
    _handler_start: float | None = None
    _handler_end: float | None = None
    _blocked: dict[str, str] | None = None
    _fault: BaseException | None = None
    _quiet: bool = False

    # ------------------------------------------------------------ write guard
    @property
    def blocked(self) -> dict[str, str] | None:
        """The first write the guard refused during a Preview: ``store``, ``operation`` and ``detail``."""
        return self._blocked

    @property
    def fault(self) -> BaseException | None:
        """The first transaction-control refusal or escape of a Preview; it withholds confirmation."""
        return self._fault

    def block(self, store: str, operation: str, detail: str) -> None:
        """Keep the first refused write. It decides the Preview's 409, whatever the handler returns.

        Recording works after :meth:`finish` too, so a write sent late by a handler is never lost.
        """
        with self._lock:
            if self.rollback and self._blocked is None:
                self._blocked = {
                    "store": limits.clip(store, limits.NAME),
                    "operation": limits.clip(operation, limits.NAME),
                    "detail": limits.clip(detail),
                }

    def refuse(self, error: BaseException) -> None:
        """Keep the first fault. It withholds confirmation, whatever the handler returns."""
        with self._lock:
            if self.rollback and self._fault is None:
                self._fault = error

    # ------------------------------------------------------------------ effects
    def record_effect(self, kind: str, description: str, data: Any = None) -> bool:
        """Record an effect and return ``True`` when the host must suppress its delivery."""
        with self._lock:
            if not self._active:
                return False
            if len(self._effects) >= limits.EFFECTS or self._effect_size >= limits.LOG_BUDGET:
                self._effects_truncated = True
                return self.rollback
            began = time.perf_counter()
            captured = None if data is None else jsonsafe.snapshot(data)
            self._serialize_ms += (time.perf_counter() - began) * 1000
            data_missing = captured is not None and jsonsafe.is_missing(captured)
            if data_missing:
                captured = None
            clipped_kind = limits.clip(kind, limits.NAME)
            clipped_description = limits.clip(description)
            self._effects_truncated |= (
                clipped_kind != kind or clipped_description != description or data_missing
            )
            size = len(clipped_kind) + len(clipped_description) + (len(str(captured)) if captured else 0)
            if self._effect_size + size <= limits.LOG_BUDGET:
                self._effect_size += size
                effect: dict[str, Any] = {"kind": clipped_kind, "description": clipped_description}
                if captured is not None:
                    effect["data"] = captured
                else:
                    effect["data"] = None
                if not self.rollback:
                    effect["delivered"] = True
                self._effects.append(effect)
            else:
                self._effects_truncated = True
            return self.rollback

    # --------------------------------------------------------------------- logs
    def record_log(
        self,
        level: str,
        message: str,
        *,
        category: str | None = None,
        event_id: tuple[int, str | None] | None = None,
        properties: Mapping[str, Any] | None = None,
        exception: tuple[str, str] | None = None,
        elapsed_ms: float | None = None,
        offset_ms: float | None = None,
        sql: dict[str, Any] | None = None,
        db: dict[str, Any] | None = None,
    ) -> None:
        """Append a structured log entry when there is room."""
        with self._lock:
            if not self._active or not self._has_room():
                return
            entry: dict[str, Any] = {
                "level": limits.clip(level, limits.NAME),
                "message": limits.clip(message),
            }
            self._logs_truncated |= entry["message"] != message
            if category:
                entry["category"] = limits.clip(category, limits.NAME)
            if event_id is not None:
                entry["eventId"] = {"id": event_id[0]}
                if event_id[1]:
                    entry["eventId"]["name"] = limits.clip(event_id[1], limits.NAME)
            entry["offsetMs"] = max(0.0, self._offset_ms() if offset_ms is None else offset_ms)
            if elapsed_ms is not None:
                entry["elapsedMs"] = max(0.0, elapsed_ms)
            if properties:
                kept = {}
                for key, value in properties.items():
                    if key == "{OriginalFormat}":
                        continue
                    if len(kept) >= limits.PROPERTIES:
                        self._logs_truncated = True
                        break
                    kept[limits.clip(str(key), limits.NAME)] = limits.clip(str(value))
                if kept:
                    entry["properties"] = kept
            if exception is not None:
                entry["exception"] = {
                    "type": limits.clip(exception[0], limits.NAME),
                    "message": limits.clip(exception[1]),
                }
            if sql is not None:
                entry["sql"] = sql
            if db is not None:
                entry["db"] = db
            size = _entry_size(entry)
            if self._log_size + size <= limits.LOG_BUDGET:
                self._logs.append(entry)
                self._log_size += size
            else:
                self._logs_truncated = True

    def record_sql(
        self,
        text: str,
        parameters: Iterable[tuple[str, str | None, str]],
        *,
        rows_affected: int | None = None,
        duration_ms: float = 0.0,
        category: str = "sql",
        truncated: bool = False,
    ) -> None:
        """Record one executed SQL command and add its duration to the ``db`` timing."""
        with self._lock:
            if not self._active:
                return
            self._db_ms += duration_ms
            self._queries += 1
            if not self._has_room():
                return
            clipped = limits.clip(text)
            listed = []
            for index, (name, value, db_type) in enumerate(parameters):
                if index >= limits.PARAMETERS:
                    truncated = True
                    break
                listed.append({
                    "name": limits.clip(name, limits.NAME),
                    "value": None if value is None else limits.clip(value),
                    "dbType": limits.clip(db_type, limits.NAME),
                })
            self._logs_truncated |= truncated or clipped != text
            sql: dict[str, Any] = {"text": clipped, "parameters": listed}
            if rows_affected is not None and rows_affected >= 0:
                sql["rowsAffected"] = rows_affected
            self.record_log(
                "Sql",
                clipped,
                category=category,
                elapsed_ms=duration_ms,
                offset_ms=max(0.0, self._offset_ms() - duration_ms),
                sql=sql,
            )

    def record_db(
        self,
        system: str,
        operation: str,
        *,
        target: str | None = None,
        namespace: str | None = None,
        statement: str | None = None,
        rows_affected: int | None = None,
        blocked: bool = False,
        error: str | None = None,
        elapsed_ms: float | None = None,
    ) -> None:
        """Record one data-store command as a ``Db`` log entry.

        The message is the OpenTelemetry span name, ``{operation} {target}``. Hooks pass sanitized
        statements only: values never reach this method. A blocked command never ran, so it adds
        nothing to the ``db`` timing.
        """
        with self._lock:
            if not self._active or self._quiet:
                return
            if not blocked:
                self._queries += 1
                self._db_ms += elapsed_ms or 0.0
            db: dict[str, Any] = {
                "system": limits.clip(system, limits.NAME), "operation": limits.clip(operation, limits.NAME),
            }
            if target is not None:
                db["target"] = limits.clip(target, limits.NAME)
            if namespace is not None:
                db["namespace"] = limits.clip(namespace, limits.NAME)
            if statement is not None:
                self._logs_truncated |= len(statement) > limits.TEXT
                db["statement"] = limits.clip(statement)
            if rows_affected is not None and rows_affected >= 0:
                db["rowsAffected"] = int(rows_affected)
            if blocked:
                db["blocked"] = True
            if error:
                db["error"] = limits.clip(error, limits.NAME)
            message = db["operation"] if "target" not in db else f"{db['operation']} {db['target']}"
            offset = None if elapsed_ms is None else max(0.0, self._offset_ms() - elapsed_ms)
            self.record_log("Db", message, elapsed_ms=elapsed_ms, offset_ms=offset, db=db)

    # ------------------------------------------------------------------- timing
    def handler_started(self) -> None:
        """Mark entry into the application handler (end of the ``auth`` phase)."""
        if self._handler_start is None:
            self._handler_start = time.perf_counter()

    def handler_finished(self) -> None:
        """Mark the end of handler execution.

        Data-store commands the binding itself sends after this point (reading document changes,
        aborting a transaction) are not logged as the handler's.
        """
        self._handler_end = time.perf_counter()
        self._quiet = True

    def timing(self, extra_serialize_ms: float = 0.0) -> CaptureTiming:
        """Compute the current timing breakdown."""
        with self._lock:
            handler_start = self._handler_start or self.started
            handler_end = self._handler_end or time.perf_counter()
            serialize = self._serialize_ms
            db = self._db_ms
            handler = max(0.0, (handler_end - handler_start) * 1000 - db - serialize)
            return CaptureTiming(
                (handler_start - self.started) * 1000, handler, db, self._queries, serialize + extra_serialize_ms
            )

    def finish(self) -> CaptureSnapshot:
        """Stop capturing and return the collected data."""
        with self._lock:
            self._active = False
            snapshot = CaptureSnapshot(
                list(self._effects), list(self._logs), self._logs_truncated, self._effects_truncated
            )
            self._effects.clear()
            self._logs.clear()
            return snapshot

    @property
    def is_active(self) -> bool:
        """Whether the capture still accepts records."""
        return self._active

    # ----------------------------------------------------------------- internals
    def _offset_ms(self) -> float:
        return (time.perf_counter() - self.started) * 1000

    def _has_room(self) -> bool:
        room = len(self._logs) < limits.LOGS and self._log_size < limits.LOG_BUDGET
        self._logs_truncated |= not room
        return room


def _entry_size(entry: Mapping[str, Any]) -> int:
    size = len(entry["level"]) + len(entry["message"]) + len(entry.get("category", ""))
    for key, value in entry.get("properties", {}).items():
        size += len(key) + len(value)
    if "exception" in entry:
        size += len(entry["exception"]["type"]) + len(entry["exception"]["message"])
    if "db" in entry:
        db = entry["db"]
        size += sum(len(str(value)) for value in db.values())
    if "sql" in entry:
        sql = entry["sql"]
        size += len(sql["text"])
        for parameter in sql["parameters"]:
            size += len(parameter["name"]) + len(parameter["value"] or "") + len(parameter["dbType"])
    return size


# Loggers that print SQL with its bound values (SQLAlchemy ``echo``, Django's DEBUG query log).
# The data-layer providers record every statement themselves with redaction applied, so these
# records would only duplicate them with secrets in clear text.
_SQL_ECHO_LOGGERS = ("sqlalchemy.engine", "django.db.backends")


def _is_sql_echo(name: str) -> bool:
    return any(name == prefix or name.startswith(prefix + ".") for prefix in _SQL_ECHO_LOGGERS)


def _exception_message(error: BaseException | None) -> str:
    """The message of a logged exception without SQL parameter values.

    SQLAlchemy's ``StatementError`` appends ``[parameters: ...]`` to its text; only the driver's
    own message (``orig``) is kept for those.
    """
    if error is None:
        return ""
    if hasattr(error, "statement") and hasattr(error, "params"):
        original = getattr(error, "orig", None)
        return f"{type(original).__name__}: {original}" if original is not None else type(error).__name__
    return str(error)


class CaptureLogHandler(logging.Handler):
    """Forwards standard ``logging`` records to the capture of the current request."""

    def __init__(self, scope_getter: Callable[[], Any]) -> None:
        super().__init__(level=logging.DEBUG)
        self._scope_getter = scope_getter

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401 - logging API
        scope = self._scope_getter()
        if scope is None or _is_sql_echo(record.name):
            return
        try:
            exception = None
            if record.exc_info and record.exc_info[0] is not None:
                exception = (record.exc_info[0].__qualname__, _exception_message(record.exc_info[1]))
            scope.capture.record_log(
                _LEVELS.get(record.levelno, record.levelname.title()),
                record.getMessage(),
                category=record.name,
                exception=exception,
            )
        except Exception:  # capture must never interrupt the application
            self.handleError(record)

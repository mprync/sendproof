"""Request scope shared between adapters, providers and application code."""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Iterator

from .capture import Capture, CaptureLogHandler


@dataclass
class RequestScope:
    """State of one preview or observed request.

    Providers keep their own state in :attr:`extensions` under a unique key.
    """

    capture: Capture
    environment: str
    include_sql_parameter_values: bool
    extensions: dict[str, Any] = field(default_factory=dict)
    #: Set when the application handler is entered, i.e. after routing and authorization.
    entered: bool = False
    #: Document, item and key changes captured by ``preview``-mode data stores (MongoDB), in addition
    #: to the SQL provider's own.
    store_changes: list[Any] = field(default_factory=list)
    store_changes_truncated: bool = False

    @property
    def rollback(self) -> bool:
        """Whether this scope is a rollback-only preview."""
        return self.capture.rollback


_current: ContextVar[RequestScope | None] = ContextVar("sendproof_scope", default=None)
_handler: CaptureLogHandler | None = None

#: How code without a scope is attributed: ``"request"`` inside any request the adapter saw,
#: ``"detached"`` inside work the host marked with :func:`detached`, ``None`` otherwise.
_attribution: ContextVar[str | None] = ContextVar("sendproof_attribution", default=None)
#: Previews currently open in this process, by scope identity, with how often each is active.
_open: dict[int, list[Any]] = {}
_open_lock = threading.Lock()


def current_scope() -> RequestScope | None:
    """Return the preview or observed scope of the running request, if any."""
    return _current.get()


def activate(scope: RequestScope) -> Token[RequestScope | None]:
    """Make ``scope`` current for this context. Pass the token to :func:`deactivate`.

    A Preview scope counts as open from here until the matching :func:`deactivate`.
    """
    token = _current.set(scope)
    if scope.rollback:
        with _open_lock:
            _open.setdefault(id(scope), [scope, 0])[1] += 1
    return token


def deactivate(token: Token[RequestScope | None]) -> None:
    """Restore the previous scope."""
    scope = _current.get()
    _current.reset(token)
    if scope is not None and scope.rollback:
        with _open_lock:
            entry = _open.get(id(scope))
            if entry is not None and entry[0] is scope:
                entry[1] -= 1
                if entry[1] <= 0:
                    del _open[id(scope)]


def open_previews() -> list[RequestScope]:
    """Every Preview currently open in this process."""
    with _open_lock:
        return [entry[0] for entry in _open.values()]


def attributed() -> bool:
    """Whether the running code belongs to a request the adapter saw, or to host-marked background work.

    Store hooks use it to tell a write that some request made from one that nothing can attribute,
    such as a thread a handler started without copying its context.
    """
    return _current.get() is not None or _attribution.get() is not None


@contextmanager
def request_context() -> Iterator[None]:
    """Mark the ``with`` body as part of an ordinary request. The framework adapters wrap every request in it."""
    token = _attribution.set("request")
    try:
        yield
    finally:
        _attribution.reset(token)


def enter_request() -> Token[str | None]:
    """Mark the current context as part of an ordinary request until :func:`leave_request`."""
    return _attribution.set("request")


def leave_request(token: Token[str | None]) -> None:
    """End :func:`enter_request`. Tolerates a token from another context (a server that never closed the body)."""
    try:
        _attribution.reset(token)
    except ValueError:
        pass


@contextmanager
def detached() -> Iterator[None]:
    """Mark background work that belongs to no request, such as a worker thread or a scheduled job.

    While a Preview is open, a store write that no request and no ``detached()`` block accounts
    for fails every open Preview with 500: it may come from a handler's own thread, which a
    Preview cannot roll back. Wrap genuine background work in this so it never does::

        def refresh_cache():
            with detached():
                cache.set("rates", fetch_rates())
    """
    token = _attribution.set("detached")
    try:
        yield
    finally:
        _attribution.reset(token)


def install_logging_capture() -> None:
    """Attach the capture handler to the root logger once.

    Records reach it only when their logger propagates to the root logger and its effective
    level allows them, as with any other root handler.
    """
    global _handler
    if _handler is None:
        _handler = CaptureLogHandler(current_scope)
        logging.getLogger().addHandler(_handler)

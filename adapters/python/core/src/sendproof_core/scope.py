"""Request scope shared between adapters, providers and application code."""

from __future__ import annotations

import logging
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any

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

    @property
    def rollback(self) -> bool:
        """Whether this scope is a rollback-only preview."""
        return self.capture.rollback


_current: ContextVar[RequestScope | None] = ContextVar("sendproof_scope", default=None)
_handler: CaptureLogHandler | None = None


def current_scope() -> RequestScope | None:
    """Return the preview or observed scope of the running request, if any."""
    return _current.get()


def activate(scope: RequestScope) -> Token[RequestScope | None]:
    """Make ``scope`` current for this context. Pass the token to :func:`deactivate`."""
    return _current.set(scope)


def deactivate(token: Token[RequestScope | None]) -> None:
    """Restore the previous scope."""
    _current.reset(token)


def install_logging_capture() -> None:
    """Attach the capture handler to the root logger once.

    Records reach it only when their logger propagates to the root logger and its effective
    level allows them, as with any other root handler.
    """
    global _handler
    if _handler is None:
        _handler = CaptureLogHandler(current_scope)
        logging.getLogger().addHandler(_handler)

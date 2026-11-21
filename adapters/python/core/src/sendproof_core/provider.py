"""Contracts implemented by data-layer integrations such as ``sendproof-sqlalchemy``."""

from __future__ import annotations

import asyncio
import contextvars
import functools
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from .scope import RequestScope

T = TypeVar("T")


class PreviewRollbackError(RuntimeError):
    """Raised by a session that cannot confirm that all writes were rolled back."""


class PreviewUnavailable(RuntimeError):
    """Raised by ``begin`` when the data layer cannot enroll the operation."""


@dataclass(frozen=True)
class PreviewChange:
    """One captured row change. Values must be JSON-compatible."""

    operation: str
    table: str
    key: Any
    before: dict[str, Any] | None
    after: dict[str, Any] | None


class PreviewSession(ABC):
    """Transaction scope and change capture for one preview request.

    ``begin`` must be cheap and synchronous, and it must not touch the database until the
    application does. The adapter calls :meth:`rollback` after the handler finished, then
    :meth:`close` on every path, including failures.
    """

    @property
    @abstractmethod
    def changes(self) -> list[PreviewChange]:
        """Captured changes, available after rollback until close."""

    @property
    def changes_truncated(self) -> bool:
        """Whether changes were omitted because of a capture limit."""
        return False

    @abstractmethod
    def rollback(self) -> None:
        """Roll back all writes. Raise :class:`PreviewRollbackError` if that cannot be confirmed."""

    @abstractmethod
    def close(self) -> None:
        """Release every resource, including those partially acquired. Must be idempotent."""

    async def arollback(self) -> None:
        """Async variant of :meth:`rollback`. The default runs it in a worker thread."""
        await run_in_thread(self.rollback)

    async def aclose(self) -> None:
        """Async variant of :meth:`close`. The default runs it in a worker thread."""
        await run_in_thread(self.close)


class PreviewObservation(ABC):
    """Change capture for an observed send. It never manages a transaction."""

    @property
    @abstractmethod
    def changes(self) -> list[PreviewChange]:
        """Captured changes."""

    @property
    def changes_truncated(self) -> bool:
        """Whether changes were omitted because of a capture limit."""
        return False

    @abstractmethod
    def close(self) -> None:
        """Stop observing."""


class PreviewProvider(ABC):
    """Opens a rollback-only scope for the selected API operation."""

    #: Public database label, never a connection string.
    database: str | None = None

    @property
    def is_available(self) -> bool:
        """Whether the provider currently supports rollback previews."""
        return True

    @abstractmethod
    def begin(self, scope: RequestScope) -> PreviewSession:
        """Start a rollback scope bound to ``scope``. Clean up after yourself if it fails."""

    def begin_observation(self, scope: RequestScope) -> PreviewObservation | None:
        """Optionally observe changes without a transaction."""
        return None


async def run_in_thread(function: Callable[..., T], *args: Any) -> T:
    """Run a blocking callable in the default executor, preserving context variables."""
    context = contextvars.copy_context()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(context.run, function, *args))

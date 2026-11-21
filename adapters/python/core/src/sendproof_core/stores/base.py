"""The contract every data-store hook implements, and the stand-in provider for apps without SQL.

A :class:`DataStore` is what ``redis_store(...)``, ``dynamodb_store(...)`` and ``mongo_store(...)``
return. The framework adapters pass the list they were given (``data_stores=[...]``) to the
Preview pipeline:

1. ``begin(scope)`` runs before the handler. A ``preview``-mode store (MongoDB on a replica set)
   starts its transaction here.
2. The handler runs. Hooks call :func:`~sendproof_core.stores.guard.guard` before sending.
3. ``finish(scope)`` runs after the handler and before the SQL rollback. A ``preview``-mode store
   captures its changes and aborts its transaction; a failure here answers 500.

Every method has a synchronous and an ``a``-prefixed asynchronous form, so the ASGI adapter never
blocks its event loop on a synchronous client and the WSGI adapters never need an event loop.
"""

from __future__ import annotations

from typing import Any, Optional

from ..provider import PreviewChange, PreviewObservation, PreviewProvider, PreviewSession, run_in_thread
from ..scope import RequestScope


class DataStore:
    """A hooked data store. Subclasses override what they need; the defaults do nothing."""

    #: Short store id: ``mongodb``, ``redis`` or ``dynamodb``.
    system: str = ""

    def describe(self) -> dict[str, Any]:
        """The capabilities ``dataStores`` entry: ``system``, optional ``name``, ``mode``, optional ``reason``."""
        raise NotImplementedError

    async def adescribe(self) -> dict[str, Any]:
        """Async form of :meth:`describe`; the default runs it in a worker thread."""
        return await run_in_thread(self.describe)

    def begin(self, scope: RequestScope) -> None:
        """Prepare a Preview, for example start a transaction. Called before the handler."""

    async def abegin(self, scope: RequestScope) -> None:
        """Async form of :meth:`begin`; the default runs it in a worker thread."""
        await run_in_thread(self.begin, scope)

    def finish(self, scope: RequestScope) -> None:
        """Capture changes and abort the store's transaction. Called after the handler, even if it failed."""

    async def afinish(self, scope: RequestScope) -> None:
        """Async form of :meth:`finish`; the default runs it in a worker thread."""
        await run_in_thread(self.finish, scope)


class _NoChanges(PreviewSession, PreviewObservation):
    """A session and an observation that capture no SQL changes and roll back nothing."""

    @property
    def changes(self) -> list[PreviewChange]:
        return []

    def rollback(self) -> None:
        """Nothing to roll back."""

    def close(self) -> None:
        """Nothing to release."""

    async def arollback(self) -> None:
        """Nothing to roll back."""

    async def aclose(self) -> None:
        """Nothing to release."""


class StoresOnlyProvider(PreviewProvider):
    """Lets an app Preview with data stores alone, when it registered no SQL provider.

    The stores do their own rolling back and guarding, so the dispatch needs no SQL transaction.
    A SQL database the host gave no provider for is then not covered, like any unhooked client.
    """

    database: Optional[str] = None
    system: Optional[str] = None

    def begin(self, scope: RequestScope) -> PreviewSession:
        return _NoChanges()

    def begin_observation(self, scope: RequestScope) -> PreviewObservation | None:
        return _NoChanges()


def validate_stores(stores: Any) -> list[DataStore]:
    """Check a ``data_stores`` argument and return it as a list."""
    items = list(stores or ())
    if any(not isinstance(item, DataStore) for item in items):
        raise TypeError("data_stores takes stores made by redis_store, dynamodb_store or mongo_store.")
    return items

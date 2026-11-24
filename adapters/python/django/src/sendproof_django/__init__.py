"""Sendproof workbench, rollback previews and observed sends for Django."""

from sendproof_core import AuthProvider, Identity
from sendproof_core.marker import apply_marker

from .orm import DjangoOrmPreview

__all__ = ["AuthProvider", "DjangoOrmPreview", "Identity", "close_sessions", "preview"]
__version__ = "0.1.0a3"


def close_sessions() -> None:
    """Roll back held Preview sessions during worker shutdown."""
    from .conf import get_bench

    get_bench().engine.sessions.close()


def preview(view=True, *, methods=None, reason=None, stores=None):
    """Mark a view, or a handler method of a class-based view, as eligible for previews.

    A function view lists the methods it accepts for previews (default: the write methods
    ``POST``, ``PUT``, ``PATCH``, ``DELETE``)::

        @preview(methods=["POST"])
        def create_item(request): ...

    On a class-based view, DRF ``APIView``/``ViewSet`` or Django Ninja operation, decorate the
    handler (``post``, ``create``, the Ninja function) directly, below the route decorator::

        @api.post("/items")
        @preview
        def create_item(request, payload: ItemIn): ...

    An operation you know writes to a store a Preview cannot roll back, such as one that clears a
    Redis session, can be marked ``preview: false``. The workbench then shows "Preview
    unavailable" with your reason before anyone tries, a Preview of it is refused (never
    confirmed) without running the view, and Send still runs it::

        @preview(False, methods=["DELETE"], reason="Clears the Redis session", stores=["redis"])
        def delete_session(request, id): ...

    Without ``reason`` the published reason names the first of ``stores``. The binding never
    infers the mark: without it the operation is advertised and the write guard decides at run time.
    """
    return apply_marker(view, True, reason=reason, stores=stores, methods=methods)

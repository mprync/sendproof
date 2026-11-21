"""Sendproof workbench, rollback previews and observed sends for Django."""

from sendproof_core import AuthProvider, Identity
from sendproof_core.marker import mark

from .orm import DjangoOrmPreview

__all__ = ["AuthProvider", "DjangoOrmPreview", "Identity", "preview"]
__version__ = "0.1.0a1"


def preview(view=None, *, methods=None):
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
    """
    if view is None:
        return lambda target: mark(target, tuple(methods) if methods else None)
    return mark(view, tuple(methods) if methods else None)

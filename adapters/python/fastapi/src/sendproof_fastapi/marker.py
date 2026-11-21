"""The ``@preview`` marker for FastAPI and Starlette path operation functions."""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from sendproof_core.marker import MARKER, is_marked, mark

F = TypeVar("F", bound=Callable[..., Any])


def preview(endpoint: F) -> F:
    """Mark a path operation function as eligible for Sendproof previews.

    Apply it directly to the function, below the route decorator::

        @app.post("/items")
        @preview
        def create_item(item: Item, db: Session = Depends(get_db)): ...

    Only marked operations are advertised and accepted. The function keeps its signature, so
    FastAPI's dependency injection and OpenAPI generation are unchanged.
    """
    return mark(endpoint)


__all__ = ["MARKER", "is_marked", "preview"]

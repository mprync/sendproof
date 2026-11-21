"""The ``@preview`` marker for FastAPI and Starlette path operation functions."""

from __future__ import annotations

from typing import Any, Callable, Iterable, TypeVar

from sendproof_core.marker import MARKER, apply_marker, is_marked, is_previewable, unavailable_info

F = TypeVar("F", bound=Callable[..., Any])


def preview(
    endpoint: Any = True, *, reason: str | None = None, stores: Iterable[str] | None = None
) -> Any:
    """Mark a path operation function as eligible for Sendproof previews, or as ``preview: false``.

    Apply it directly to the function, below the route decorator::

        @app.post("/items")
        @preview
        def create_item(item: Item, db: Session = Depends(get_db)): ...

    Only marked operations are advertised and accepted. The function keeps its signature, so
    FastAPI's dependency injection and OpenAPI generation are unchanged.

    An operation you know writes to a store a Preview cannot roll back, such as one that clears a
    Redis session, can be marked ``preview: false``. The workbench then shows "Preview unavailable"
    with your reason before anyone tries, a Preview of it is refused (never confirmed) without
    running the handler, and Send still runs it::

        @app.delete("/sessions/{id}")
        @preview(False, reason="Clears the Redis session", stores=["redis"])
        def delete_session(id: str): ...

    Without ``reason`` the published reason names the first of ``stores``. The binding never
    infers the mark: without it the operation is advertised and the write guard decides at run time.
    """
    return apply_marker(endpoint, True, reason=reason, stores=stores)


__all__ = ["MARKER", "is_marked", "is_previewable", "preview", "unavailable_info"]

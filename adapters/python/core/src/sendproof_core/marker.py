"""The ``@preview`` marker that opts a view or endpoint into rollback previews and observed sends."""

from __future__ import annotations

import functools
import inspect
import types
from typing import Any, Callable, TypeVar

from .scope import current_scope

F = TypeVar("F", bound=Callable[..., Any])
MARKER = "__sendproof_preview__"
METHODS = "__sendproof_methods__"
WRITE_METHODS = ("DELETE", "PATCH", "POST", "PUT")


def enter() -> None:
    """Record that routing, authentication and validation passed and the handler runs."""
    scope = current_scope()
    if scope is not None:
        scope.entered = True
        scope.capture.handler_started()


def mark(endpoint: F, methods: tuple[str, ...] | None = None) -> F:
    """Wrap a function so that calling it records handler entry, and tag it as previewable.

    The wrapper keeps the signature (``functools.wraps``), stays a coroutine function when the
    original is one, and shares the original's module globals so that frameworks resolving
    string annotations (``from __future__ import annotations``) still find your types.
    """
    record_entry = enter  # a closure variable: the wrapper must not need its own module globals

    if inspect.iscoroutinefunction(endpoint):

        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            record_entry()
            return await endpoint(*args, **kwargs)

    else:

        def wrapper(*args: Any, **kwargs: Any) -> Any:  # type: ignore[misc]
            record_entry()
            return endpoint(*args, **kwargs)

    globals_ = getattr(endpoint, "__globals__", None)
    if globals_ is not None:
        clone = types.FunctionType(wrapper.__code__, globals_, wrapper.__name__, wrapper.__defaults__, wrapper.__closure__)
        clone.__kwdefaults__ = wrapper.__kwdefaults__
        wrapper = clone
    functools.update_wrapper(wrapper, endpoint)
    setattr(wrapper, MARKER, True)
    if methods is not None:
        setattr(wrapper, METHODS, tuple(m.upper() for m in methods))
    return wrapper  # type: ignore[return-value]


def is_marked(endpoint: Any) -> bool:
    """Whether a callable carries the preview marker."""
    return bool(getattr(endpoint, MARKER, False))


def marked_methods(endpoint: Any) -> tuple[str, ...]:
    """HTTP methods a marked callable accepts for previews (write methods by default)."""
    return tuple(getattr(endpoint, METHODS, WRITE_METHODS))

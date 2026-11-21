"""The ``@preview`` marker that opts a view or endpoint into rollback previews and observed sends."""

from __future__ import annotations

import functools
import inspect
import types
from dataclasses import dataclass
from typing import Any, Callable, Iterable, TypeVar

from .scope import current_scope

F = TypeVar("F", bound=Callable[..., Any])
MARKER = "__sendproof_preview__"
METHODS = "__sendproof_methods__"
UNAVAILABLE = "__sendproof_unavailable__"
WRITE_METHODS = ("DELETE", "PATCH", "POST", "PUT")


def enter() -> None:
    """Record that routing, authentication and validation passed and the handler runs."""
    scope = current_scope()
    if scope is not None:
        scope.entered = True
        scope.capture.handler_started()


@dataclass(frozen=True)
class Unavailable:
    """An operation marked ``preview: false``: Preview refuses it, Send still runs it."""

    #: The sentence the workbench shows before anyone tries.
    reason: str
    #: Store ids the operation writes to, such as ``("redis",)``.
    stores: tuple[str, ...] = ()


def unavailable_reason(reason: str | None, stores: Iterable[str]) -> str:
    """The published reason: the author's own, else one built from the first named store."""
    from .stores.guard import write_reason

    if reason is not None and reason.strip():
        return reason
    names = list(stores)
    return write_reason(names[0]) if names else "Preview unavailable: this operation is marked preview: false"


def mark(endpoint: F, methods: tuple[str, ...] | None = None, unavailable: Unavailable | None = None) -> F:
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
    if unavailable is not None:
        setattr(wrapper, UNAVAILABLE, unavailable)
    return wrapper  # type: ignore[return-value]


def apply_marker(
    target: Any, enabled: Any = True, *, reason: str | None = None, stores: Iterable[str] | None = None,
    methods: Iterable[str] | None = None,
) -> Any:
    """Implement the framework ``preview`` decorators, which share one calling convention.

    ``@preview`` marks a handler as previewable; ``@preview(False, reason="...", stores=["redis"])``
    marks it ``preview: false`` instead: the workbench shows "Preview unavailable" with the reason
    before anyone tries, a Preview of it is refused (never confirmed) without running the handler,
    and Send still runs it. ``target`` is the decorated function, or the flag when written with
    arguments, in which case a decorator is returned.
    """
    kept = tuple(methods) if methods else None
    if callable(target) and enabled is True and reason is None and stores is None:
        return mark(target, kept)
    flag = target if not callable(target) else enabled
    if not isinstance(flag, bool):
        raise TypeError("preview takes a handler, or True or False followed by keyword options.")
    names = tuple(stores or ())
    if any(not isinstance(name, str) or not name for name in names):
        raise TypeError("stores takes store ids such as 'redis'.")

    def decorate(handler: F) -> F:
        if flag:
            return mark(handler, kept)
        return mark(handler, kept, Unavailable(unavailable_reason(reason, names), names))

    return decorate if not callable(target) else decorate(target)


def is_marked(endpoint: Any) -> bool:
    """Whether a callable carries the preview marker (previewable, or marked ``preview: false``)."""
    return bool(getattr(endpoint, MARKER, False))


def unavailable_info(endpoint: Any) -> Unavailable | None:
    """The ``preview: false`` mark of a callable, if it has one."""
    found = getattr(endpoint, UNAVAILABLE, None)
    return found if isinstance(found, Unavailable) else None


def is_previewable(endpoint: Any) -> bool:
    """Whether a Preview may run the callable: marked, and not marked ``preview: false``."""
    return is_marked(endpoint) and unavailable_info(endpoint) is None


def marked_methods(endpoint: Any) -> tuple[str, ...]:
    """HTTP methods a marked callable accepts for previews (write methods by default)."""
    return tuple(getattr(endpoint, METHODS, WRITE_METHODS))

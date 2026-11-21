"""Finds previewable operations in a Django URLconf.

Three kinds of views are understood:

* plain function views decorated with :func:`sendproof_django.preview`;
* class-based views and Django REST framework views or viewsets whose handler methods
  (``post``, ``create``...) are decorated;
* Django Ninja operations, whose handler functions are decorated.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Iterator

from django.urls import URLPattern, URLResolver
from django.urls.resolvers import RoutePattern

from sendproof_core.marker import is_marked, is_previewable, marked_methods, unavailable_info

_CONVERTER = re.compile(r"<(?:[^:<>]+:)?([^<>]+)>")
_HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def _ninja_operations(callback: Any) -> Any:
    """The operations of a Django Ninja path view, found on the bound view or in its closure."""
    owners = [getattr(callback, "__self__", None)]
    for cell in getattr(callback, "__closure__", None) or ():
        try:
            owners.append(cell.cell_contents)
        except ValueError:  # an empty cell
            continue
    for owner in owners:
        operations = getattr(owner, "operations", None)
        if isinstance(operations, (list, tuple)):
            return operations
    return None


def view_methods(callback: Any, *, unavailable: bool = False, observed: bool = False) -> set[str]:
    """HTTP methods for which ``callback`` has a handler a Preview may run.

    With ``unavailable`` true, the methods whose handler is marked ``preview: false`` instead;
    with ``observed`` true, every marked handler, since an observed Send may trace both.
    """
    def wanted(handler: Any) -> bool:
        if observed:
            return is_marked(handler)
        return (unavailable_info(handler) is not None) if unavailable else is_previewable(handler)

    methods: set[str] = set()
    operations = _ninja_operations(callback)
    if operations is not None:  # Django Ninja path view
        for operation in operations:
            if wanted(getattr(operation, "view_func", None)):
                methods.update(m.upper() for m in operation.methods)
        return methods
    cls = getattr(callback, "view_class", None) or getattr(callback, "cls", None)
    if cls is not None:
        actions = getattr(callback, "actions", None)  # DRF viewset: {"post": "create"}
        for method in _HTTP_METHODS:
            name = actions.get(method) if actions is not None else method
            if name and wanted(getattr(cls, name, None)):
                methods.add(method.upper())
        return methods
    if wanted(callback):
        methods.update(marked_methods(callback))
    return methods


def _walk(patterns: Iterable[Any], prefix: str) -> Iterator[tuple[str, Any]]:
    for entry in patterns:
        if not isinstance(entry.pattern, RoutePattern):
            continue  # regex routes have no portable OpenAPI template
        route = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            yield from _walk(entry.url_patterns, route)
        elif isinstance(entry, URLPattern):
            yield route, entry.callback


def _reason(callback: Any) -> Any:
    """The ``preview: false`` mark of the first handler of ``callback`` that has one."""
    operations = _ninja_operations(callback)
    if operations is not None:
        handlers = [getattr(operation, "view_func", None) for operation in operations]
    else:
        cls = getattr(callback, "view_class", None) or getattr(callback, "cls", None)
        actions = getattr(callback, "actions", None)
        handlers = (
            [getattr(cls, (actions.get(m) if actions is not None else m) or "", None) for m in _HTTP_METHODS]
            if cls is not None else [callback]
        )
    return next((info for info in map(unavailable_info, handlers) if info is not None), None)


def unavailable_operations(patterns: Iterable[Any]) -> list[tuple[str, str, str, tuple[str, ...]]]:
    """Method, path, reason and stores of every operation marked ``preview: false``."""
    found = []
    for route, callback in _walk(patterns, ""):
        methods = view_methods(callback, unavailable=True)
        marked = _reason(callback) if methods else None
        if marked is not None:
            path = "/" + _CONVERTER.sub(r"{\1}", route).lstrip("/")
            found.extend((method, path, marked.reason, marked.stores) for method in sorted(methods))
    return found


def preview_operations(patterns: Iterable[Any]) -> list[tuple[str, str]]:
    """Method and OpenAPI path template of every operation a Preview may run."""
    found = []
    for route, callback in _walk(patterns, ""):
        methods = view_methods(callback)
        if methods:
            path = "/" + _CONVERTER.sub(r"{\1}", route).lstrip("/")
            found.extend((method, path) for method in sorted(methods))
    return found

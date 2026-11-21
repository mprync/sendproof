"""Finds previewable operations in a Django URLconf.

Three kinds of views are understood:

* plain function views decorated with :func:`testbench_django.preview`;
* class-based views and Django REST framework views or viewsets whose handler methods
  (``post``, ``create``...) are decorated;
* Django Ninja operations, whose handler functions are decorated.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Iterator

from django.urls import URLPattern, URLResolver
from django.urls.resolvers import RoutePattern

from testbench_core.marker import is_marked, marked_methods

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


def view_methods(callback: Any) -> set[str]:
    """HTTP methods for which ``callback`` has a marked handler."""
    methods: set[str] = set()
    operations = _ninja_operations(callback)
    if operations is not None:  # Django Ninja path view
        for operation in operations:
            if is_marked(getattr(operation, "view_func", None)):
                methods.update(m.upper() for m in operation.methods)
        return methods
    cls = getattr(callback, "view_class", None) or getattr(callback, "cls", None)
    if cls is not None:
        actions = getattr(callback, "actions", None)  # DRF viewset: {"post": "create"}
        for method in _HTTP_METHODS:
            name = actions.get(method) if actions is not None else method
            if name and is_marked(getattr(cls, name, None)):
                methods.add(method.upper())
        return methods
    if is_marked(callback):
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


def preview_operations(patterns: Iterable[Any]) -> list[tuple[str, str]]:
    """Method and OpenAPI path template of every marked operation."""
    found = []
    for route, callback in _walk(patterns, ""):
        methods = view_methods(callback)
        if methods:
            path = "/" + _CONVERTER.sub(r"{\1}", route).lstrip("/")
            found.extend((method, path) for method in sorted(methods))
    return found

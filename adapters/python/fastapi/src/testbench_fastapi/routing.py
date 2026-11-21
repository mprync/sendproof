"""Finds the application's own route for a request, using the framework's routing rules."""

from __future__ import annotations

from typing import Any, Iterable

from starlette.routing import Match, Mount

from .marker import is_marked


def route_path(scope: dict[str, Any]) -> str:
    """The request path without the ASGI ``root_path`` (the mount prefix)."""
    path: str = scope["path"]
    root: str = scope.get("root_path", "")
    if root and path.startswith(root):
        stripped = path[len(root):]
        return stripped if stripped.startswith("/") else "/" + stripped
    return path


def find_route(routes: Iterable[Any], scope: dict[str, Any]) -> tuple[Any, Match] | None:
    """Return the first fully matching route, else the first partial (wrong method) match."""
    partial: tuple[Any, Match] | None = None
    for route in routes:
        match, child = route.matches(scope)
        if match == Match.FULL:
            if isinstance(route, Mount) and getattr(route, "routes", None):
                nested = find_route(route.routes, {**scope, **child})
                if nested is not None and nested[1] == Match.FULL:
                    return nested
                continue
            return route, Match.FULL
        if match == Match.PARTIAL and partial is None:
            partial = (route, Match.PARTIAL)
    return partial


def preview_operations(routes: Iterable[Any]) -> list[tuple[str, str]]:
    """Method and OpenAPI path template of every marked operation."""
    operations = []
    for route in routes:
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None or not is_marked(endpoint):
            continue
        path = getattr(route, "path_format", None) or route.path
        for method in sorted(route.methods or ()):
            if method not in ("HEAD", "OPTIONS"):
                operations.append((method, path))
    return operations

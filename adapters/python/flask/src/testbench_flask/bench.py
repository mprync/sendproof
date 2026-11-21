"""The public ``TestBench`` object for Flask applications."""

from __future__ import annotations

import re
import time
from typing import Any, Callable, Iterable, TypeVar

from flask import Flask, Request
from flask import got_request_exception
from werkzeug.routing import Rule

from testbench_core import AuthProvider, BenchOptions, Identity, OpenApiDocument, PreviewProvider
from testbench_core.assets import UiAssets
from testbench_core.marker import is_marked, mark, marked_methods
from testbench_core.scope import current_scope, install_logging_capture
from testbench_core.sync_engine import SyncBench
from testbench_core.workbench import Workbench

from .middleware import PREVIEW_VIEW, TestBenchWsgi

F = TypeVar("F", bound=Callable[..., Any])
IdentityResolver = Callable[[Request], "Identity | None"]
Authorizer = Callable[[Request, "Identity | None"], bool]


def preview(view: F) -> F:
    """Mark a Flask view function as eligible for Test Bench previews.

    Apply it below the route decorator::

        @app.post("/items")
        @preview
        def create_item(): ...
    """
    return mark(view)


def _template(rule: Rule) -> str:
    """Convert a Werkzeug rule (``/items/<int:id>``) to an OpenAPI path (``/items/{id}``)."""
    return re.sub(r"<(?:[^:<>]+:)?([^<>]+)>", r"{\1}", rule.rule)


class TestBench:
    """Adds the Test Bench workbench to a Flask application.

    The workbench is **off** unless ``environment`` is listed in ``environments`` (default
    ``("Development",)``). ``environment`` defaults to ``$TESTBENCH_ENVIRONMENT`` and then to
    ``"Production"``.

    Args:
        app: The Flask application. Create the ``TestBench`` after registering your routes or
            before; operations are discovered per request.
        provider: A data-layer provider such as ``testbench_sqlalchemy.SQLAlchemyPreview``.
        identity: ``(request) -> Identity | None``. Runs inside a request context, so
            ``flask.session`` and ``flask_login`` work. Used for discovery and to own traces.
        authorize: Optional ``(request, identity) -> bool`` policy for the workbench.
        api_name, openapi_url, documents, auth_providers, field_modules,
        include_sql_parameter_values, trace_ttl, clock: See ``testbench_fastapi.TestBench``.
            Flask has no built-in OpenAPI route; ``openapi_url`` defaults to ``/openapi.json``.
    """

    __test__ = False

    def __init__(
        self,
        app: Flask,
        *,
        provider: PreviewProvider | None = None,
        identity: IdentityResolver | None = None,
        authorize: Authorizer | None = None,
        api_name: str | None = None,
        openapi_url: str | None = None,
        documents: Iterable[OpenApiDocument] = (),
        environment: str | None = None,
        environments: Iterable[str] = ("Development",),
        auth_providers: Iterable[AuthProvider] = (),
        field_modules: Iterable[str] = (),
        include_sql_parameter_values: bool | None = None,
        trace_ttl: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
        assets: UiAssets | None = None,
    ) -> None:
        self.app = app
        self.provider = provider
        self.options = BenchOptions(
            api_name=api_name, openapi_url=openapi_url, documents=list(documents), environment=environment,
            environments=tuple(environments), auth_providers=list(auth_providers), field_modules=list(field_modules),
            include_sql_parameter_values=include_sql_parameter_values, trace_ttl=trace_ttl, clock=clock, identity=identity,
        )
        self.workbench = Workbench(self.options, provider, assets)
        self.engine = SyncBench(self.options, provider, self.workbench, authorize)
        app.wsgi_app = TestBenchWsgi(app.wsgi_app, self)  # type: ignore[method-assign]
        # First in line, so no host hook or view runs for a preview that no longer targets the
        # marked view it was checked against.
        app.before_request_funcs.setdefault(None, []).insert(0, self._verify_preview_target)
        got_request_exception.connect(_remember_unhandled, app, weak=False)
        install_logging_capture()

    @property
    def enabled(self) -> bool:
        return self.options.enabled

    def _verify_preview_target(self) -> Any:
        """Last check of a re-dispatched preview, after every WSGI middleware has run.

        Middleware may have changed the method (method override) or the path. Unless the request
        still routes to the marked view and method checked earlier, nothing else runs and the
        preview answers 409. Routing errors are left to Flask (404, 405).
        """
        from flask import request

        expected = request.environ.get(PREVIEW_VIEW)
        if expected is None or request.routing_exception is not None:
            return None
        view = self.app.view_functions.get(request.endpoint)
        if view is expected and request.method in marked_methods(view):
            return None
        return self.app.response_class(
            '{"status":409,"title":"This operation is unavailable for preview."}',
            status=409, content_type="application/problem+json",
        )

    def operations(self) -> list[tuple[str, str]]:
        """Method and OpenAPI path of every marked view."""
        found = []
        for rule in self.app.url_map.iter_rules():
            view = self.app.view_functions.get(rule.endpoint)
            if view is None or not is_marked(view):
                continue
            allowed = set(marked_methods(view))
            for method in sorted((rule.methods or set()) & allowed):
                found.append((method, _template(rule)))
        return found


def _remember_unhandled(sender: Any, exception: BaseException, **extra: Any) -> None:
    """Flask turns unhandled errors into 500 responses; remember them so a preview can fail."""
    scope = current_scope()
    if scope is not None:
        scope.extensions["unhandled"] = exception

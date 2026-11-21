"""The public ``Sendproof`` object for Flask applications."""

from __future__ import annotations

import re
import time
from typing import Any, Callable, Iterable, TypeVar

from flask import Flask, Request
from flask import got_request_exception
from werkzeug.routing import Rule

from sendproof_core import AuthProvider, BenchOptions, Identity, OpenApiDocument, PreviewProvider
from sendproof_core.assets import UiAssets
from sendproof_core.marker import apply_marker, is_previewable, marked_methods, unavailable_info
from sendproof_core.scope import current_scope, install_logging_capture
from sendproof_core.stores.base import DataStore, StoresOnlyProvider, validate_stores
from sendproof_core.sync_engine import SyncBench
from sendproof_core.workbench import Workbench

from .middleware import PREVIEW_VIEW, SendproofWsgi

F = TypeVar("F", bound=Callable[..., Any])
IdentityResolver = Callable[[Request], "Identity | None"]
Authorizer = Callable[[Request, "Identity | None"], bool]


def preview(
    view: Any = True, *, reason: str | None = None, stores: Iterable[str] | None = None,
    methods: Iterable[str] | None = None,
) -> Any:
    """Mark a Flask view function as eligible for Sendproof previews, or as ``preview: false``.

    Apply it below the route decorator::

        @app.post("/items")
        @preview
        def create_item(): ...

    An operation you know writes to a store a Preview cannot roll back, such as one that clears a
    Redis session, can be marked ``preview: false``. The workbench then shows "Preview
    unavailable" with your reason before anyone tries, a Preview of it is refused (never
    confirmed) without running the view, and Send still runs it::

        @app.delete("/sessions/<id>")
        @preview(False, reason="Clears the Redis session", stores=["redis"])
        def delete_session(id): ...

    Without ``reason`` the published reason names the first of ``stores``. The binding never
    infers the mark: without it the operation is advertised and the write guard decides at run time.

    A view is previewable for its write methods (``POST``, ``PUT``, ``PATCH``, ``DELETE``) unless
    ``methods`` lists others, for example ``@preview(methods=["GET"])`` for a read that touches a store.
    """
    return apply_marker(view, True, reason=reason, stores=stores, methods=methods)


def _template(rule: Rule) -> str:
    """Convert a Werkzeug rule (``/items/<int:id>``) to an OpenAPI path (``/items/{id}``)."""
    return re.sub(r"<(?:[^:<>]+:)?([^<>]+)>", r"{\1}", rule.rule)


class Sendproof:
    """Adds the Sendproof workbench to a Flask application.

    The workbench is **off** unless ``environment`` is listed in ``environments`` (default
    ``("Development",)``). ``environment`` defaults to ``$SENDPROOF_ENVIRONMENT`` and then to
    ``"Production"``.

    Args:
        app: The Flask application. Create the ``Sendproof`` after registering your routes or
            before; operations are discovered per request.
        provider: A data-layer provider such as ``sendproof_sqlalchemy.SQLAlchemyPreview``.
        data_stores: Hooked data stores (``mongo_store``, ``redis_store``, ``dynamodb_store`` from
            ``sendproof_core.stores``). MongoDB rolls back in its own transaction, and Redis and
            DynamoDB block a write during a Preview. They also let an app with no SQL ``provider``
            Preview: a SQL database you give no provider for is then not covered. Only hooked
            clients are covered. Use synchronous clients (PyMongo, redis-py, boto3).
        identity: ``(request) -> Identity | None``. Runs inside a request context, so
            ``flask.session`` and ``flask_login`` work. Used for discovery and to own traces.
        authorize: Optional ``(request, identity) -> bool`` policy for the workbench.
        api_name, openapi_url, documents, auth_providers, field_modules,
        include_sql_parameter_values, trace_ttl, clock: See ``sendproof_fastapi.Sendproof``.
            Flask has no built-in OpenAPI route; ``openapi_url`` defaults to ``/openapi.json``.
    """

    __test__ = False

    def __init__(
        self,
        app: Flask,
        *,
        provider: PreviewProvider | None = None,
        data_stores: Iterable[DataStore] = (),
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
        stores = validate_stores(data_stores)
        # Without a SQL provider, hooked stores alone can carry a Preview (see sendproof_fastapi).
        if provider is None and stores:
            provider = StoresOnlyProvider()
        self.provider = provider
        self.options = BenchOptions(
            api_name=api_name, openapi_url=openapi_url, documents=list(documents), environment=environment,
            environments=tuple(environments), auth_providers=list(auth_providers), field_modules=list(field_modules),
            include_sql_parameter_values=include_sql_parameter_values, trace_ttl=trace_ttl, clock=clock, identity=identity,
            framework="Flask",
        )
        self.workbench = Workbench(self.options, provider, assets)
        self.engine = SyncBench(self.options, provider, self.workbench, authorize, stores)
        app.wsgi_app = SendproofWsgi(app.wsgi_app, self)  # type: ignore[method-assign]
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
        """Method and OpenAPI path of every view a Preview may run."""
        found = []
        for rule in self.app.url_map.iter_rules():
            view = self.app.view_functions.get(rule.endpoint)
            if view is None or not is_previewable(view):
                continue
            allowed = set(marked_methods(view))
            for method in sorted((rule.methods or set()) & allowed):
                found.append((method, _template(rule)))
        return found

    def unavailable(self) -> list[tuple[str, str, str, tuple[str, ...]]]:
        """Method, path, reason and stores of every view marked ``preview: false``."""
        found = []
        for rule in self.app.url_map.iter_rules():
            marked = unavailable_info(self.app.view_functions.get(rule.endpoint))
            if marked is None:
                continue
            allowed = set(marked_methods(self.app.view_functions[rule.endpoint]))
            for method in sorted((rule.methods or set()) & allowed):
                found.append((method, _template(rule), marked.reason, marked.stores))
        return found


def _remember_unhandled(sender: Any, exception: BaseException, **extra: Any) -> None:
    """Flask turns unhandled errors into 500 responses; remember them so a preview can fail."""
    scope = current_scope()
    if scope is not None:
        scope.extensions["unhandled"] = exception

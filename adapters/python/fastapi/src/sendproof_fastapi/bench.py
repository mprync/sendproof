"""The public ``Sendproof`` object for FastAPI and Starlette applications."""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Iterable

from starlette.middleware import Middleware
from starlette.requests import Request

from sendproof_core import AuthProvider, BenchOptions, Identity, OpenApiDocument, PreviewProvider
from sendproof_core.assets import UiAssets
from sendproof_core.scope import install_logging_capture
from sendproof_core.stores.base import DataStore, StoresOnlyProvider, validate_stores
from sendproof_core.workbench import Workbench

from .middleware import SendproofMiddleware

IdentityResolver = Callable[[Request], "Identity | None | Awaitable[Identity | None]"]
Authorizer = Callable[[Request, "Identity | None"], "bool | Awaitable[bool]"]


class Sendproof:
    """Adds the Sendproof workbench to a FastAPI (or Starlette) application.

    The workbench is **off** unless ``environment`` is listed in ``environments``
    (default ``("Development",)``). ``environment`` defaults to ``$SENDPROOF_ENVIRONMENT`` and
    then to ``"Production"``, so installing the package never exposes it by accident.

    Args:
        app: The application. Create the ``Sendproof`` before the first request is served.
        provider: A data-layer provider such as ``sendproof_sqlalchemy.SQLAlchemyPreview``.
            Without one, and without ``data_stores``, no operation is advertised and previews
            answer 503.
        data_stores: Hooked data stores (``mongo_store``, ``redis_store``, ``dynamodb_store`` from
            ``sendproof_core.stores``). MongoDB rolls back in its own transaction, and Redis and
            DynamoDB block a write during a Preview. They also let an app with no SQL ``provider``
            Preview: a SQL database you give no provider for is then not covered. Only hooked
            clients are covered.
        identity: Returns the caller's :class:`~sendproof_core.Identity` for a request, or
            ``None``. Used for the capabilities ``identity`` and to own observed-send traces.
            It reads what your authentication already established, such as a session.
        authorize: Optional workbench policy, ``(request, identity) -> bool``. When it returns
            false the workbench, previews and traces answer 401 or 403.
        api_name: Display name. Defaults to the application's ``title``.
        openapi_url: Defaults to the application's ``openapi_url``.
        documents: Extra named OpenAPI documents.
        auth_providers: Sign-in integrations to advertise, for example
            ``AuthProvider("Password", "cookie", "/auth/sign-in")``.
        field_modules: Same-origin ES module URLs that register custom field renderers.
        include_sql_parameter_values: Show SQL parameter values. Defaults to Development only.
        trace_ttl: Seconds an observed-send trace is kept (default 300).
        clock: Monotonic clock used by the trace store, injectable for tests.
    """

    __test__ = False  # not a pytest test class

    def __init__(
        self,
        app: Any,
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
        self.stores = validate_stores(data_stores)
        # Without a SQL provider, hooked stores alone can carry a Preview: MongoDB aborts its own
        # transaction and the guarded stores block writes, so no SQL transaction is needed.
        if provider is None and self.stores:
            provider = StoresOnlyProvider()
        self.provider = provider
        self.authorize = authorize
        self.options = BenchOptions(
            api_name=api_name,
            openapi_url=openapi_url,
            documents=list(documents),
            environment=environment,
            environments=tuple(environments),
            auth_providers=list(auth_providers),
            field_modules=list(field_modules),
            include_sql_parameter_values=include_sql_parameter_values,
            trace_ttl=trace_ttl,
            clock=clock,
            identity=identity,
            framework="FastAPI",
        )
        self.workbench = Workbench(self.options, provider, assets)
        if getattr(app, "middleware_stack", None) is not None:
            raise RuntimeError("Create Sendproof before the application starts serving requests.")
        # Appended last so the host's own middleware (sessions, authentication) runs first.
        app.user_middleware.append(Middleware(SendproofMiddleware, bench=self))
        install_logging_capture()

    @property
    def enabled(self) -> bool:
        """Whether the workbench is active in the configured environment."""
        return self.options.enabled

"""Builds the Sendproof engine from ``settings.SENDPROOF``."""

from __future__ import annotations

import threading
from typing import Any, Callable

from django.conf import settings
from django.utils.module_loading import import_string

from sendproof_core import AuthProvider, BenchOptions, Identity, OpenApiDocument
from sendproof_core.stores.base import DataStore, StoresOnlyProvider, validate_stores
from sendproof_core.sync_engine import SyncBench
from sendproof_core.workbench import Workbench

_lock = threading.Lock()
_bench: "DjangoBench | None" = None

KEYS = {
    "API_NAME", "OPENAPI_URL", "DOCUMENTS", "ENVIRONMENT", "ENVIRONMENTS", "PROVIDER", "IDENTITY",
    "AUTHORIZE", "AUTH_PROVIDERS", "FIELD_MODULES", "INCLUDE_SQL_PARAMETER_VALUES", "TRACE_TTL", "DATA_STORES",
    "JOURNEY_FILES", "SESSION_IDLE_TIMEOUT", "SESSION_MAX_LIFETIME",
}


def default_identity(request: Any) -> Identity | None:
    """Identity of ``request.user`` when Django authentication has established one."""
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        return None
    name = user.get_full_name() or user.get_username()
    return Identity(name, None, str(user.pk), "django")


def _resolve(value: Any) -> Any:
    return import_string(value) if isinstance(value, str) else value


class DjangoBench:
    """The configured engine plus the hooks supplied in settings."""

    def __init__(self, config: dict[str, Any]) -> None:
        unknown = set(config) - KEYS
        if unknown:
            raise ValueError(f"Unknown SENDPROOF setting(s): {', '.join(sorted(unknown))}")
        provider = _resolve(config.get("PROVIDER"))
        if callable(provider) and not hasattr(provider, "begin"):
            provider = provider()
        stores = []
        for entry in config.get("DATA_STORES", ()):
            store = _resolve(entry)
            stores.append(store() if callable(store) and not isinstance(store, DataStore) else store)
        stores = validate_stores(stores)
        # Without a SQL provider, hooked stores alone can carry a Preview (see sendproof_fastapi).
        if provider is None and stores:
            provider = StoresOnlyProvider()
        self.identity: Callable[[Any], Identity | None] = _resolve(config.get("IDENTITY")) or default_identity
        authorize = _resolve(config.get("AUTHORIZE"))
        providers = [
            p if isinstance(p, AuthProvider) else AuthProvider(p["label"], p["kind"], p.get("url"))
            for p in config.get("AUTH_PROVIDERS", [])
        ]
        documents = [
            d if isinstance(d, OpenApiDocument) else OpenApiDocument(d["name"], d["url"])
            for d in config.get("DOCUMENTS", [])
        ]
        self.options = BenchOptions(
            api_name=config.get("API_NAME"), openapi_url=config.get("OPENAPI_URL"), documents=documents,
            environment=config.get("ENVIRONMENT"), environments=tuple(config.get("ENVIRONMENTS", ("Development",))),
            auth_providers=providers, field_modules=list(config.get("FIELD_MODULES", [])),
            include_sql_parameter_values=config.get("INCLUDE_SQL_PARAMETER_VALUES"),
            trace_ttl=float(config.get("TRACE_TTL", 300.0)), identity=self.identity, framework="Django",
            journey_files=tuple(config.get("JOURNEY_FILES", ())),
            session_idle_timeout=config.get("SESSION_IDLE_TIMEOUT", 300),
            session_max_lifetime=config.get("SESSION_MAX_LIFETIME", 1800),
        )
        self.provider = provider
        self.workbench = Workbench(self.options, provider)
        self.engine = SyncBench(self.options, provider, self.workbench, authorize, stores)


def get_bench() -> DjangoBench:
    """The process-wide engine, built on first use from ``settings.SENDPROOF``."""
    global _bench
    with _lock:
        if _bench is None:
            _bench = DjangoBench(dict(getattr(settings, "SENDPROOF", {})))
        return _bench


def reset() -> None:
    """Forget the cached engine (tests)."""
    global _bench
    with _lock:
        if _bench is not None:
            _bench.engine.sessions.close()
        _bench = None

"""Configuration shared by every framework adapter."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .identity import Identity


def _is_local_url(url: str) -> bool:
    from urllib.parse import unquote

    path = url.split("?", 1)[0]
    decoded = unquote(path)
    return (
        path.startswith("/")
        and not path.startswith("//")
        and "\\" not in url
        and "#" not in url
        and not any(c.isspace() or ord(c) < 32 for c in url)
        and not decoded.startswith("//")
        and "\\" not in decoded
        # Browsers treat "%2e%2e" as "..", so dot segments are checked after decoding.
        and not any(part in (".", "..") for part in decoded.split("/"))
    )


def require_local_url(url: str) -> str:
    """Validate an application-relative, same-origin URL."""
    if not isinstance(url, str) or not _is_local_url(url):
        raise ValueError("Use an application-relative, same-origin path such as '/openapi.json'.")
    return url


def require_display_label(label: str) -> str:
    """Validate a public database label: a bare name such as ``PostgreSQL``.

    Connection strings, URLs, hosts, credentials and file paths are refused so that a
    misconfigured label never publishes them in discovery.
    """
    if (
        not isinstance(label, str)
        or not label.strip()
        or len(label) > 128
        or any(c in label for c in "/\\@=;:?#")
        or any(ord(c) < 32 for c in label)
    ):
        raise ValueError("Use a bare display name for the database label, such as 'PostgreSQL'.")
    return label


@dataclass(frozen=True)
class AuthProvider:
    """A sign-in integration advertised in discovery."""

    label: str
    kind: str
    url: str | None


@dataclass(frozen=True)
class OpenApiDocument:
    """A named OpenAPI document."""

    name: str
    url: str


@dataclass
class BenchOptions:
    """Framework-neutral options.

    The workbench is off unless ``environment`` is one of ``environments``. With no
    ``environment`` the value of ``SENDPROOF_ENVIRONMENT`` is used, and without that the
    environment is ``Production``.
    """

    api_name: str | None = None
    openapi_url: str | None = None
    documents: list[OpenApiDocument] = field(default_factory=list)
    environment: str | None = None
    environments: tuple[str, ...] = ("Development",)
    auth_providers: list[AuthProvider] = field(default_factory=list)
    field_modules: list[str] = field(default_factory=list)
    include_sql_parameter_values: bool | None = None
    trace_ttl: float = 300.0
    clock: Callable[[], float] = time.monotonic
    identity: Callable[..., Identity | None] | None = None
    #: The web framework serving the workbench, published as capabilities ``binding.framework``
    #: so the workbench shows the ``preview: false`` snippet in the host's own language.
    framework: str | None = None

    def __post_init__(self) -> None:
        if self.environment is None:
            self.environment = os.environ.get("SENDPROOF_ENVIRONMENT") or "Production"
        self.environments = tuple(self.environments)
        if self.openapi_url is not None:
            require_local_url(self.openapi_url)
        for url in self.field_modules:
            require_local_url(url)
        for document in self.documents:
            require_local_url(document.url)
        for provider in self.auth_providers:
            if provider.url is not None:
                require_local_url(provider.url)

    @property
    def enabled(self) -> bool:
        """Whether the workbench and previews are available in this environment."""
        assert self.environment is not None
        return any(self.environment.lower() == name.lower() for name in self.environments)

    @property
    def show_sql_values(self) -> bool:
        """Whether SQL parameter values are shown (Development by default)."""
        if self.include_sql_parameter_values is not None:
            return self.include_sql_parameter_values
        return (self.environment or "").lower() == "development"


def normalize_environments(values: Iterable[str]) -> tuple[str, ...]:
    """Validate environment names."""
    names = tuple(values)
    if any(not isinstance(name, str) or not name.strip() for name in names):
        raise ValueError("Environment names must be non-empty strings.")
    return names

"""Supported versions of the client libraries whose hooks reach into private internals.

The Cosmos DB hook swaps the transport at ``client_connection.pipeline_client._pipeline._transport``
and the Firestore hook overrides ``_firestore_api_helper``. Neither is public API, so each hook
checks the installed version at registration and refuses one outside the range it was verified
against, rather than leave the client unguarded. The ranges match the extras in
``adapters/python/core/pyproject.toml``; a test fails when the two differ.
"""

from __future__ import annotations

import re
from importlib import metadata

#: Distribution name: (lowest supported version, first unsupported version).
SUPPORTED = {
    "azure-cosmos": ("4.17", "4.18"),
    "google-cloud-firestore": ("2.34", "2.35"),
}


def _release(version: str) -> tuple[int, ...]:
    """The numeric release of a version string: ``4.17.1`` is ``(4, 17, 1)``, ``2.35.0rc1`` is ``(2, 35, 0)``."""
    found = re.match(r"\d+(?:\.\d+)*", version.strip())
    if not found:
        raise ValueError(f"not a version: {version!r}")
    return tuple(int(part) for part in found.group(0).split("."))


def installed(distribution: str) -> str | None:
    """The installed version of ``distribution``, or ``None`` when it isn't installed."""
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def require_supported(distribution: str, factory: str) -> None:
    """Refuse to register a hook when ``distribution``'s installed version is outside its supported range."""
    lowest, beyond = SUPPORTED[distribution]
    found = installed(distribution)
    if found is not None and _release(lowest) <= _release(found) < _release(beyond):
        return
    raise TypeError(
        f"{factory} supports {distribution}>={lowest},<{beyond}, but {found or 'no version'} is installed. "
        "Its hook relies on the client's internals, so it refuses an unverified version rather than leave the client unguarded.")

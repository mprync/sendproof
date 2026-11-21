"""The embedded workbench UI.

The files come from the shared packer (``node tools/pack-ui.mjs``). It writes a
``manifest.json`` with a SHA-256 for every file. This module serves only files listed there and
verifies each digest before first use, so an incomplete or edited bundle is never served.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Asset:
    """A verified file and its media type."""

    content: bytes
    content_type: str


class UiBundleError(RuntimeError):
    """The UI bundle is missing or fails verification."""


class UiAssets:
    """Lazy, verified access to a packed UI directory."""

    def __init__(self, directory: str | os.PathLike[str] | None = None) -> None:
        configured = directory or os.environ.get("SENDPROOF_UI_DIR")
        self._directory = Path(configured) if configured else Path(__file__).parent / "ui"
        self._manifest: dict | None = None
        self._cache: dict[str, Asset] = {}

    @property
    def version(self) -> str:
        """The bundle version recorded in the manifest."""
        return str(self._load()["version"])

    def get(self, path: str) -> Asset | None:
        """Return the asset at a manifest-relative path or ``None`` if it is not part of the bundle."""
        files = self._load()["files"]
        entry = files.get(path)
        if entry is None:
            return None
        cached = self._cache.get(path)
        if cached is not None:
            return cached
        content = (self._directory / path).read_bytes()
        if hashlib.sha256(content).hexdigest() != entry["sha256"] or len(content) != entry["bytes"]:
            raise UiBundleError(f"UI asset '{path}' does not match its manifest digest.")
        asset = Asset(content, entry["contentType"])
        self._cache[path] = asset
        return asset

    def _load(self) -> dict:
        if self._manifest is None:
            manifest = self._directory / "manifest.json"
            if not manifest.is_file():
                raise UiBundleError(
                    "The Sendproof UI bundle is not embedded. Run adapters/python/scripts/embed_ui.py "
                    "or set SENDPROOF_UI_DIR to a directory produced by tools/pack-ui.mjs."
                )
            data = json.loads(manifest.read_text("utf-8"))
            if not isinstance(data.get("files"), dict) or "version" not in data:
                raise UiBundleError("The UI manifest is malformed.")
            self._manifest = data
        return self._manifest

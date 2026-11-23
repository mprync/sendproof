"""File-backed journey documents, registered explicitly by the host."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .options import require_local_url

_SUFFIX = ".arazzo.json"
_PREFIX = "/sendproof/journeys/"


@dataclass(frozen=True)
class Journey:
    name: str
    arazzo: dict[str, Any]
    expectations: dict[str, Any]

    def describe(self, base: str) -> dict[str, str]:
        info = self.arazzo.get("info")
        title = info.get("title") if isinstance(info, dict) else None
        return {
            "name": title if isinstance(title, str) and title else self.name,
            "source": "file",
            "arazzoUrl": base + _PREFIX + self.name + _SUFFIX,
            "expectationsUrl": base + _PREFIX + self.name + ".expect.json",
        }


def load_journeys(paths: Iterable[str | Path]) -> dict[str, Journey]:
    """Load paired documents at configuration time. Routes never resolve a user-supplied path."""
    journeys = {}
    for path in map(Path, paths):
        name = path.name.removesuffix(_SUFFIX)
        if name == path.name or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*", name):
            raise ValueError("Journey files must be named '<name>.arazzo.json'.")
        if name in journeys:
            raise ValueError(f"Journey '{name}' is registered twice.")
        arazzo = json.loads(path.read_bytes())
        expectations = json.loads(path.with_name(name + ".expect.json").read_bytes())
        if not isinstance(arazzo, dict) or not isinstance(expectations, dict):
            raise ValueError("Journey documents must be JSON objects.")
        journeys[name] = Journey(name, arazzo, expectations)
    return journeys


def journey_document(path: str, journeys: dict[str, Journey], base: str) -> dict[str, Any] | None:
    """Resolve a registered document and rebase local OpenAPI source paths."""
    name, _, kind = path.rpartition(".")
    name, _, extension = name.rpartition(".")
    journey = journeys.get(name)
    if journey is None or kind != "json":
        return None
    if extension == "expect":
        return journey.expectations
    if extension != "arazzo":
        return None
    sources = journey.arazzo.get("sourceDescriptions")
    if not base or not isinstance(sources, list):
        return journey.arazzo
    served = []
    for source in sources:
        try:
            url = require_local_url(source.get("url") if isinstance(source, dict) else None)
        except ValueError:
            served.append(source)
        else:
            served.append({**source, "url": base + url})
    return {**journey.arazzo, "sourceDescriptions": served}

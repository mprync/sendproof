"""Load registered journey documents and serve them from the same routes."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Literal

from .journey_builder import JourneyBuilder, JourneyDefinitionError, openapi_operations
from .options import require_local_url

_SUFFIX = ".arazzo.json"
_PREFIX = "/sendproof/journeys/"
_NAME = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]*")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Journey:
    name: str
    arazzo: dict[str, Any]
    expectations: dict[str, Any]
    source: Literal["file", "code"] = "file"

    def describe(self, base: str) -> dict[str, str]:
        info = self.arazzo.get("info")
        title = info.get("title") if isinstance(info, dict) else None
        return {
            "name": title if isinstance(title, str) and title else self.name,
            "source": self.source,
            "arazzoUrl": base + _PREFIX + self.name + _SUFFIX,
            "expectationsUrl": base + _PREFIX + self.name + ".expect.json",
        }


def load_journeys(paths: Iterable[str | Path]) -> dict[str, Journey]:
    """Load paired documents at configuration time. Routes never resolve a user-supplied path."""
    journeys = {}
    for path in map(Path, paths):
        name = path.name.removesuffix(_SUFFIX)
        if name == path.name or not _NAME.fullmatch(name):
            raise ValueError("Journey files must be named '<name>.arazzo.json'.")
        if name in journeys:
            raise ValueError(f"Journey '{name}' is registered twice.")
        arazzo = json.loads(path.read_bytes())
        expectations = json.loads(path.with_name(name + ".expect.json").read_bytes())
        if not isinstance(arazzo, dict) or not isinstance(expectations, dict):
            raise ValueError("Journey documents must be JSON objects.")
        journeys[name] = Journey(name, arazzo, expectations)
    return journeys


def register_code_journeys(
    documents: dict[str, Journey], definitions: tuple[JourneyBuilder, ...], *,
    openapi: Callable[[], dict[str, Any]] | None, openapi_url: str, sql_store: str,
    development: bool,
) -> None:
    """Compile code journeys once, keeping valid documents in other enabled environments."""
    if not definitions:
        return
    problems = []
    try:
        if openapi is None:
            raise JourneyDefinitionError("Code journeys require a provider for the served OpenAPI document.")
        operations = openapi_operations(openapi())
    except Exception as error:
        problems.append(f"Could not read OpenAPI at {openapi_url}: {error}")
    else:
        workflow_ids = {
            workflow["workflowId"] for document in documents.values()
            for workflow in (document.arazzo.get("workflows") or [])
            if isinstance(workflow, dict) and isinstance(workflow.get("workflowId"), str)
        }
        for definition in definitions:
            name = definition.file_name
            try:
                if not _NAME.fullmatch(name):
                    raise JourneyDefinitionError(f"Invalid journey document name {name!r}.")
                if name in documents:
                    raise JourneyDefinitionError(f"Journey document '{name}' is registered twice.")
                if definition.workflow_id in workflow_ids:
                    raise JourneyDefinitionError(f"Workflow '{definition.workflow_id}' is registered twice.")
                arazzo, expectations = definition._build(operations, openapi_url, sql_store)
            except (TypeError, ValueError) as error:
                problems.append(f"{definition.workflow_id}: {error}")
                continue
            documents[name] = Journey(name, arazzo, expectations, source="code")
            workflow_ids.add(definition.workflow_id)
    if problems and development:
        raise JourneyDefinitionError("Invalid Sendproof journeys:\n" + "\n".join(problems))
    for problem in problems:
        logger.warning("Skipped a code journey: %s", problem)


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

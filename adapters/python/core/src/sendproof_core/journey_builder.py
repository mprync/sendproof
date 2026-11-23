"""Declare a Sendproof journey using Python and compile it into paired JSON documents."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal, Protocol

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

_UNSET = object()
_REFERENCES = re.compile(r"(?:^|\{)(\$(?:inputs|steps)\.[^{}\s]+)(?=$|\})")
_HTTP_METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace", "query"}


class JourneyDefinitionError(ValueError):
    """A registered code journey could not be published."""


class InputModel(Protocol):
    """A model class that provides a JSON Schema, such as a Pydantic v2 BaseModel."""

    @classmethod
    def model_json_schema(cls) -> dict[str, Any]: ...


class Match:
    """Expectations for generated values and field transitions."""

    @staticmethod
    def any(type_: Literal["any", "string", "number", "integer", "boolean", "date-time", "uuid"] = "any") -> dict[str, str]:
        return {"type": type_}

    @staticmethod
    def pattern(pattern: str) -> dict[str, str]:
        return {"pattern": pattern}

    @staticmethod
    def changed(before: Any, after: Any) -> dict[str, Any]:
        return {"from": before, "to": after}


@dataclass
class StepWrites:
    """Expected writes and effects for one step. An empty set expects neither."""

    _writes: list[dict[str, Any]] = field(default_factory=list, init=False)
    _effects: list[dict[str, Any]] = field(default_factory=list, init=False)

    def sql(self, table: str, op: Literal["insert", "update", "delete"], *,
            key: dict[str, Any] | None = None, values: dict[str, Any] | None = None,
            store: str | None = None) -> None:
        """Default to the SQL system advertised by the adapter's preview provider."""
        self.store(store, op, table=table, key=key, values=values)

    def mongo(self, collection: str, op: Literal["insert", "update", "delete"], *,
              key: dict[str, Any] | None = None, values: dict[str, Any] | None = None) -> None:
        self.store("mongodb", op, collection=collection, key=key, values=values)

    def redis(self, key: str, op: str) -> None:
        self.store("redis", op, key=key)

    def store(self, store: str | None, op: str, **target: Any) -> None:
        """Expect a write using the store's table, collection or key and optional values."""
        self._writes.append({"store": store, "op": op, **{k: v for k, v in target.items() if v is not None}})

    def effect(self, kind: str, **data: Any) -> None:
        self._effects.append({"kind": kind, **data})

    def email(self, *, to: Any, subject: Any) -> None:
        self.effect("email", to=to, subject=subject)

    def _describe(self, sql_store: str) -> dict[str, Any]:
        writes = [{**write, "store": write["store"] or sql_store} for write in self._writes]
        expected: dict[str, Any] = {"writes": writes, "unlisted": "fail"}
        if self._effects or not writes:
            expected["effects"] = self._effects
        return expected


@dataclass(frozen=True)
class ApprovedDifference:
    """A reviewed exception for one finding in this journey."""

    id: str
    step: str
    target: dict[str, str]
    reason: str
    approved_by: str
    approved_on: date
    kind: Literal["value", "missing", "extra"] = "value"
    expected: Any = _UNSET
    actual: Any = _UNSET
    expires: date | None = None
    link: str | None = None

    def _describe(self, workflow_id: str) -> dict[str, Any]:
        record = {
            "id": self.id, "journey": workflow_id, "step": self.step, "target": self.target,
            "kind": self.kind, "reason": self.reason, "approvedBy": self.approved_by,
            "approvedOn": self.approved_on.isoformat(),
        }
        if self.expires is not None:
            record["expires"] = self.expires.isoformat()
        if self.link is not None:
            record["link"] = self.link
        return {**record, **{k: v for k, v in (("expected", self.expected), ("actual", self.actual)) if v is not _UNSET}}


class JourneyStep:
    """Describe one operation, its request bindings and the response it should produce."""

    def __init__(self, step_id: str, operation_id: str, *, run_as: str | None = None) -> None:
        self.step_id = step_id
        self.operation_id = operation_id
        self.run_as = run_as
        self._request: dict[str, Any] = {}
        self._parameters: dict[tuple[str, str], Any] = {}
        self._criteria: list[dict[str, Any]] = []
        self._outputs: dict[str, str] = {}
        self._writes: StepWrites | None = None

    def set(self, name: str, value: Any, *, in_: Literal["path", "query", "header", "cookie"]) -> None:
        self._parameters[in_, name] = value

    def request_body(self, payload: Any, *, content_type: str = "application/json") -> None:
        """Set the request payload, including runtime expressions inside nested fields."""
        self._request = {"contentType": content_type, "payload": payload}

    def output(self, name: str, pointer: str = "", *, expression: str | None = None) -> str:
        """Read a JSON Pointer in the response body, or supply another Arazzo expression."""
        self._outputs[name] = expression if expression is not None else "$response.body#" + pointer
        return f"$steps.{self.step_id}.outputs.{name}"

    def succeeds_with(self, status_code: int) -> None:
        self.success_criterion(f"$statusCode == {status_code}")

    def success_criterion(self, condition: str, **options: Any) -> None:
        """Add an Arazzo success criterion, with optional context and type."""
        self._criteria.append({"condition": condition, **options})

    def expect_writes(self) -> StepWrites:
        if self._writes is None:
            self._writes = StepWrites()
        return self._writes


class JourneyBuilder:
    """Describe a workflow and its expectations before registering it with the adapter."""

    def __init__(self, workflow_id: str, *, name: str | None = None, summary: str | None = None,
                 description: str | None = None, group: str | None = None, run_as: str | None = None,
                 inputs: dict[str, Any] | type[InputModel] | None = None, file_name: str | None = None,
                 source_name: str = "api") -> None:
        self.workflow_id = workflow_id
        self.name = name if name is not None else workflow_id
        self.summary = summary if summary is not None else self.name
        self.description = description
        self.group = group
        self.run_as = run_as
        self.inputs = inputs
        self.file_name = file_name if file_name is not None else workflow_id
        self.source_name = source_name
        self._steps: list[JourneyStep] = []
        self._send_only_reason: str | None = None
        self._approved: list[ApprovedDifference] = []

    def input(self, name: str) -> str:
        return f"$inputs.{name}"

    def step(self, step_id: str, operation_id: str, *, run_as: str | None = None) -> JourneyStep:
        step = JourneyStep(step_id, operation_id, run_as=run_as)
        self._steps.append(step)
        return step

    def send_only(self, reason: str) -> None:
        self._send_only_reason = reason

    def approve(self, difference: ApprovedDifference) -> None:
        self._approved.append(difference)

    def _build(self, operations: dict[str, int], openapi_url: str,
               sql_store: str) -> tuple[dict[str, Any], dict[str, Any]]:
        inputs = self.inputs if isinstance(self.inputs, dict) or self.inputs is None else self.inputs.model_json_schema()
        if inputs is not None:
            try:
                Draft202012Validator.check_schema(inputs)
            except SchemaError as error:
                raise JourneyDefinitionError(f"Invalid inputs schema: {error.message}") from error
        properties = inputs.get("properties", {}) if inputs is not None else {}
        problems = []
        if not self.workflow_id.strip() or not self.name.strip() or not self._steps:
            problems.append("A journey needs an ID, a name and at least one step.")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", self.source_name):
            problems.append(f"Invalid source name {self.source_name!r}.")
        if self._send_only_reason is not None and not self._send_only_reason.strip():
            problems.append("A Send-only journey needs a reason.")

        steps = []
        expected_steps = {}
        outputs: dict[str, dict[str, str]] = {}
        for step in self._steps:
            if not step.step_id or step.step_id in outputs:
                problems.append(f"Missing or duplicate step ID {step.step_id!r}.")
            count = operations.get(step.operation_id, 0)
            if count != 1:
                problem = "Unknown" if not count else "Ambiguous"
                problems.append(f"Step '{step.step_id}': {problem} operationId '{step.operation_id}'.")

            values = [*step._parameters.values(), step._request, step._outputs]
            problems.extend(_reference_problems(step.step_id, values, properties, outputs))
            steps.append({"stepId": step.step_id, "operationId": step.operation_id, **{
                key: value for key, value in (
                    ("parameters", [{"name": name, "in": location, "value": value}
                                    for (location, name), value in step._parameters.items()]),
                    ("requestBody", step._request), ("successCriteria", step._criteria), ("outputs", step._outputs),
                ) if value
            }})
            outputs[step.step_id] = step._outputs
            expected = step._writes._describe(sql_store) if step._writes is not None else {}
            problems.extend(_reference_problems(step.step_id, expected, properties, outputs))
            if step.run_as is not None:
                expected["persona"] = step.run_as
            if expected:
                expected_steps[step.step_id] = expected

        approvals = []
        approval_ids = set()
        for difference in self._approved:
            if not all(value.strip() for value in (difference.id, difference.reason, difference.approved_by)):
                problems.append("An approved difference needs an ID, a reason and an approver.")
            if difference.id in approval_ids:
                problems.append(f"Duplicate approved difference '{difference.id}'.")
            if difference.step not in outputs:
                problems.append(f"Approved difference '{difference.id}' names unknown step '{difference.step}'.")
            approval_ids.add(difference.id)
            approvals.append(difference._describe(self.workflow_id))
        if problems:
            raise JourneyDefinitionError("\n".join(dict.fromkeys(problems)))

        workflow: dict[str, Any] = {"workflowId": self.workflow_id, "summary": self.summary, "steps": steps}
        if self.description is not None:
            workflow["description"] = self.description
        if inputs is not None:
            workflow["inputs"] = inputs
        arazzo = {
            "arazzo": "1.1.0", "info": {"title": self.name, "version": "1.0.0"},
            "sourceDescriptions": [{"name": self.source_name, "url": openapi_url, "type": "openapi"}],
            "workflows": [workflow],
        }
        entry: dict[str, Any] = {
            key: value for key, value in (("group", self.group), ("runAs", self.run_as)) if value is not None
        }
        if self._send_only_reason is not None:
            entry.update(sendOnly=True, sendOnlyReason=self._send_only_reason)
        entry["steps"] = expected_steps
        expectations = {
            "sendproofExpectations": "1.0", "arazzo": self.file_name + ".arazzo.json",
            "journeys": {self.workflow_id: entry}, "approvedDifferences": approvals,
        }
        # Snapshot the definition at startup and reject values that cannot be served as JSON.
        arazzo, expectations = json.loads(json.dumps([arazzo, expectations], allow_nan=False))
        return arazzo, expectations


def openapi_operations(document: dict[str, Any]) -> dict[str, int]:
    """Index the addressable operations in the OpenAPI document published by the app."""
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise JourneyDefinitionError("The OpenAPI document must contain a paths object.")
    operations: dict[str, int] = {}
    for methods in paths.values():
        if not isinstance(methods, dict):
            continue
        for method, operation in methods.items():
            if method in _HTTP_METHODS and isinstance(operation, dict):
                name = operation.get("operationId")
                if isinstance(name, str) and name:
                    operations[name] = operations.get(name, 0) + 1
    return operations


def _reference_problems(step: str, value: Any, inputs: dict[str, Any],
                        outputs: dict[str, dict[str, str]]) -> list[str]:
    if isinstance(value, dict):
        value = list(value.values())
    if isinstance(value, (list, tuple)):
        return [problem for item in value for problem in _reference_problems(step, item, inputs, outputs)]
    problems = []
    if isinstance(value, str):
        for reference in _REFERENCES.findall(value):
            source, name, *parts = reference.split(".")
            if source == "$inputs" and name not in inputs:
                problems.append(f"Step '{step}': Unknown input '{name}' in '{reference}'.")
            if source == "$steps" and (len(parts) < 2 or parts[0] != "outputs" or parts[1] not in outputs.get(name, {})):
                problems.append(f"Step '{step}': Bad step reference '{reference}'. Use an available step output.")
    return problems

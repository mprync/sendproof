"""Bounded conversion of host-provided values to JSON-compatible data."""

from __future__ import annotations

import base64
import dataclasses
import datetime as dt
import decimal
import enum
import ipaddress
import json
import uuid
from typing import Any

from . import limits

_MISSING = object()


class Unserializable(Exception):
    """Raised when a value cannot be represented within the capture limits."""


def to_jsonable(value: Any, depth: int = 0) -> Any:
    """Convert ``value`` to JSON-compatible data or raise :class:`Unserializable`.

    Strings, collections and nesting are bounded by :mod:`sendproof_core.limits`.
    Objects that expose ``model_dump`` (pydantic) or are dataclasses are expanded.
    """
    if depth > limits.MAX_DEPTH:
        raise Unserializable("depth")
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return str(value)
        return value
    if isinstance(value, str):
        if len(value) > limits.TEXT:
            raise Unserializable("string")
        return value
    if isinstance(value, enum.Enum):
        return to_jsonable(value.value, depth + 1)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, (decimal.Decimal, uuid.UUID, ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)[: limits.TEXT // 2]
        return raw.hex()
    if isinstance(value, dict):
        if len(value) > limits.PARAMETERS:
            raise Unserializable("object")
        result = {}
        for key, item in value.items():
            name = key if isinstance(key, str) else str(key)
            if len(name) > limits.NAME:
                raise Unserializable("name")
            result[name] = to_jsonable(item, depth + 1)
        return result
    if isinstance(value, (list, tuple, set, frozenset)):
        if len(value) > limits.PARAMETERS:
            raise Unserializable("array")
        return [to_jsonable(item, depth + 1) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return to_jsonable(dump(mode="json"), depth + 1)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return to_jsonable(dataclasses.asdict(value), depth + 1)
    raise Unserializable(type(value).__name__)


def snapshot(value: Any) -> Any:
    """Return a bounded JSON-compatible copy of ``value`` or ``_MISSING`` when it does not fit."""
    try:
        data = to_jsonable(value)
        if len(json.dumps(data, separators=(",", ":"))) > limits.PAYLOAD_BYTES:
            return _MISSING
        return data
    except (Unserializable, TypeError, ValueError, RecursionError):
        return _MISSING


def is_missing(value: Any) -> bool:
    """Whether :func:`snapshot` rejected the value."""
    return value is _MISSING


def body_from_bytes(content_type: str, payload: bytes) -> Any:
    """Decode a captured response body for the preview envelope."""
    if not payload:
        return None
    media = content_type.split(";", 1)[0].strip().lower()
    if media == "application/json" or media.endswith("+json"):
        try:
            return json.loads(payload)
        except ValueError:
            return payload.decode("utf-8", errors="replace")
    if not media or media.startswith("text/"):
        return payload.decode("utf-8", errors="replace")
    return base64.b64encode(payload).decode("ascii")

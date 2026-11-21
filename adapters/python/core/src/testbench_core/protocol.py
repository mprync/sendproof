"""Protocol v1 constants and request predicates, independent of any web framework."""

from __future__ import annotations

import json
from typing import Callable, Sequence

PREVIEW_PREFIX = "/bench/_preview"
BENCH_PREFIX = "/bench"
ROLLBACK_PREFERENCE = "tx=rollback"
TRACE_HEADER = "X-TestBench-Trace"
PROTOCOL_VERSION = 1

#: Returns every value of a request header, case-insensitively.
HeaderGetter = Callable[[str], Sequence[str]]

# Hop-by-hop and private headers that never travel in a preview envelope.
PRIVATE_HEADERS = frozenset(
    {"set-cookie", "location", "content-length", "transfer-encoding", "connection", "upgrade", "trailer"}
)


def has_exact_preference(get: HeaderGetter) -> bool:
    """Whether ``Prefer`` is exactly one ``tx=rollback`` value."""
    values = get("prefer")
    return len(values) == 1 and values[0].strip().lower() == ROLLBACK_PREFERENCE


def requests_rollback(get: HeaderGetter) -> bool:
    """Whether any ``Prefer`` token asks for ``tx=rollback``."""
    for value in get("prefer"):
        for part in value.replace(";", ",").split(","):
            name, _, setting = part.partition("=")
            if name.strip().lower() == "tx" and setting.strip().strip('"').lower() == "rollback":
                return True
    return False


def requests_trace(get: HeaderGetter) -> bool:
    """Whether ``Prefer`` contains the ``trace`` token."""
    for value in get("prefer"):
        for part in value.split(","):
            if part.split(";", 1)[0].strip().lower() == "trace":
                return True
    return False


def is_same_origin(get: HeaderGetter, scheme: str, host: str) -> bool:
    """Reject cross-site fetches and mismatching ``Origin`` headers."""
    site = get("sec-fetch-site")
    if site and site[0].lower() == "cross-site":
        return False
    origins = get("origin")
    if not origins:
        return True
    if len(origins) != 1:
        return False
    origin = _normalize_origin(origins[0])
    # "Origin: null" and malformed values never match, even when the Host header is malformed too.
    return origin is not None and origin == _normalize_origin(f"{scheme}://{host}")


def _normalize_origin(value: str) -> str | None:
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(value.strip())
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
            return None
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        return None
    return f"{parts.scheme}://{parts.hostname.lower()}:{port}"


def is_valid_preview_target(target: str) -> bool:
    """Whether the path after ``/bench/_preview`` is a safe in-app target."""
    from urllib.parse import unquote

    if not target or not target.startswith("/") or target.startswith("//"):
        return False
    decoded = unquote(target)
    if decoded.startswith("//") or "\\" in decoded or any(ord(c) < 32 or ord(c) == 127 for c in decoded):
        return False
    if any(segment in (".", "..") for segment in decoded.split("/")):
        return False
    return not (target == BENCH_PREFIX or target.startswith(BENCH_PREFIX + "/"))


def problem(status: int, title: str) -> tuple[int, list[tuple[str, str]], bytes]:
    """Build an ``application/problem+json`` response."""
    body = json.dumps({"status": status, "title": title}, separators=(",", ":")).encode()
    return status, [("content-type", "application/problem+json"), ("cache-control", "no-store")], body


def classify_unexecuted(status: int) -> tuple[int, str]:
    """Map the status of a request that never reached the handler to a transport rejection."""
    titles = {
        401: "Authentication is required for this preview.",
        403: "This preview is forbidden.",
        404: "The preview target was not found for this method.",
        405: "The preview target was not found for this method.",
        503: "Preview requires one available preview provider.",
    }
    if 300 <= status < 400:
        return 401, "Preview redirects are disabled. Sign in through the workbench first."
    if status in titles:
        return status, titles[status]
    if 400 <= status < 500 and status != 409:
        return status, "The host rejected the preview request."
    return 409, "This operation is unavailable for preview."


# Statuses returned by the framework for a request that fails validation before the endpoint
# runs. They describe the application's answer, so they stay inside the envelope.
VALIDATION_STATUSES = frozenset({400, 422})


# A 401 or 403 is treated as an authentication or authorization denial even when the handler
# produced it, because the transport cannot tell the two apart. Denials never yield an envelope.
DENIAL_STATUSES = frozenset({401, 403})


def is_application_response(entered: bool, status: int) -> bool:
    """Whether a response is the application's own answer rather than a transport-level denial.

    It is when the handler was entered, or when the framework rejected the request body
    (400 or 422) before the handler; a 401 or 403 never is.
    """
    return status not in DENIAL_STATUSES and (entered or status in VALIDATION_STATUSES)

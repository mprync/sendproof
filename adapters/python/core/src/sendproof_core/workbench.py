"""Framework-neutral implementation of the workbench HTTP surface.

Adapters translate their request type into the arguments of these methods and the returned
:class:`Response` back into a framework response.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from . import limits, protocol
from .assets import Asset, UiAssets, UiBundleError
from .capture import CaptureSnapshot, CaptureTiming
from .identity import Identity
from .journeys import journey_document, load_journeys, register_code_journeys
from .jsonsafe import body_from_bytes
from .options import BenchOptions, OpenApiDocument, require_display_label
from .provider import PreviewChange, PreviewProvider
from .redaction import REDACTED, looks_secret, redact_deep
from .trace_store import Owner, TraceStore


@dataclass
class Response:
    """A complete, buffered HTTP response."""

    status: int
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""

    def with_content_type(self, content_type: str) -> "Response":
        """This response with its ``Content-Type`` replaced."""
        kept = [(k, v) for k, v in self.headers if k.lower() != "content-type"]
        return Response(self.status, [("content-type", content_type), *kept], self.body)


def json_response(value: Any, status: int = 200, headers: Iterable[tuple[str, str]] = ()) -> Response:
    """Serialize ``value`` as a non-cacheable JSON response."""
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return Response(
        status,
        [("content-type", "application/json; charset=utf-8"), ("cache-control", "no-store"), *headers],
        payload,
    )


def problem_response(status: int, title: str, headers: Iterable[tuple[str, str]] = ()) -> Response:
    """Build a problem+json rejection."""
    code, base, body = protocol.problem(status, title)
    return Response(code, [*base, *headers], body)


def blocked_response(blocked: dict[str, str]) -> Response:
    """The 409 answer for a Preview the write guard stopped: an RFC 9457 problem, never a confirmation.

    The body names the store and the refused operation, never its arguments, and carries neither
    the handler's response nor ``Preference-Applied``, so no client can mistake it for a rollback.
    """
    return json_response(
        {
            "type": "about:blank",
            "title": "Preview unavailable",
            "status": 409,
            "code": "preview_unavailable",
            "detail": blocked["detail"],
            "store": blocked["store"],
            "operation": blocked["operation"],
            "rolledBack": False,
        },
        409,
    ).with_content_type("application/problem+json")


def trace_owner(identity: Identity | None, path_base: str) -> Owner | None:
    """Return the stable owner of traces for an identity, or ``None`` when it has no subject.

    The owner is (authentication type, issuer, subject, path base), so the same subject issued by
    two identity providers, or signed in through two schemes, never shares traces.
    """
    if identity is None or not identity.subject or len(identity.subject) > 256 or len(path_base) > 4096:
        return None
    issuer = identity.issuer or ""
    if len(issuer) > 4096:
        return None
    return (identity.authentication_type, issuer, identity.subject, path_base)


def redact_row(row: Any) -> Any:
    """Replace the values of secret-named columns (``password_hash``, ``api_key``...) in a snapshot.

    Change snapshots are shown in every enabled environment, so a column the SQL log would
    redact is redacted here too, whatever the SQL parameter setting. Documents from a data store
    are redacted at any depth.
    """
    return redact_deep(row) if isinstance(row, dict) else row


class Workbench:
    """Discovery, UI assets, trace retrieval and envelope construction."""

    def __init__(self, options: BenchOptions, provider: PreviewProvider | None = None, assets: UiAssets | None = None,
                 *, journey_openapi: Callable[[], dict[str, Any]] | None = None,
                 default_openapi_url: str = "/openapi.json"):
        if provider is not None and provider.database is not None:
            require_display_label(provider.database)
        self.options = options
        self.provider = provider
        self.assets = assets or UiAssets()
        self.traces = TraceStore(options.trace_ttl, options.clock)
        self.journeys = load_journeys(options.journey_files) if options.enabled else {}
        if options.enabled and options.journeys:
            register_code_journeys(
                self.journeys, options.journeys, openapi=journey_openapi,
                openapi_url=options.openapi_url or default_openapi_url,
                sql_store=(provider.system if provider is not None else None) or "sql",
                development=(options.environment or "").lower() == "development",
            )

    # ---------------------------------------------------------------- discovery
    def capabilities(
        self,
        path_base: str,
        identity: Identity | None,
        operations: Iterable[tuple[str, str]],
        default_openapi_url: str,
        default_api_name: str,
        unavailable: Iterable[tuple[str, str, str, tuple[str, ...]]] = (),
        data_stores: Iterable[dict[str, Any]] = (),
        preview_sessions: bool = False,
    ) -> Response:
        """Build ``GET /sendproof/_api/capabilities``.

        ``unavailable`` lists the operations marked ``preview: false`` as ``(method, path, reason,
        stores)``; ``data_stores`` holds the description of each hooked store.
        """
        options = self.options
        provider = self.provider if self.provider is not None and self.provider.is_available else None
        api_name = options.api_name or default_api_name
        openapi = path_base + (options.openapi_url or default_openapi_url)
        documents = [{"name": d.name, "url": path_base + d.url} for d in options.documents]
        if all(d["url"] != openapi for d in documents):
            documents.insert(0, {"name": api_name, "url": openapi})
        listed = (
            sorted({(m.upper(), p) for m, p in operations if m.upper() not in ("HEAD", "OPTIONS")}, key=lambda o: (o[1], o[0]))
            if provider
            else []
        )
        database: Any = None
        if provider is not None:
            database = {"name": provider.database, "system": provider.system} if provider.system else provider.database
        marked = (
            sorted({(m.upper(), p, r, tuple(st)) for m, p, r, st in unavailable if m.upper() not in ("HEAD", "OPTIONS")},
                   key=lambda o: (o[1], o[0]))
            if provider
            else []
        )
        who = None
        if identity is not None:
            who = {"name": identity.name}
            if identity.role:
                who["role"] = identity.role
        return json_response(
            {
                "protocolVersion": protocol.PROTOCOL_VERSION,
                "openApiUrl": openapi,
                "fieldModules": [path_base + url for url in options.field_modules],
                "apiName": api_name,
                "environment": options.environment,
                "database": database,
                **({"binding": {"language": "python", "framework": options.framework}} if options.framework else {}),
                "identity": who,
                "authProviders": [
                    {"label": a.label, "kind": a.kind, "url": None if a.url is None else path_base + a.url}
                    for a in options.auth_providers
                ],
                "previewOperations": [{"method": m, "path": p} for m, p in listed],
                **(
                    {"previewUnavailable": [
                        {"method": m, "path": p, "reason": r, **({"stores": list(st)} if st else {})}
                        for m, p, r, st in marked
                    ]}
                    if marked else {}
                ),
                **({"dataStores": list(data_stores)} if data_stores else {}),
                "observedSend": bool(listed),
                "previewSessions": preview_sessions,
                **({"journeys": [j.describe(path_base) for j in self.journeys.values()]} if self.journeys else {}),
                "documents": documents,
            },
            headers=[("x-content-type-options", "nosniff")],
        )

    def asset(self, path: str, path_base: str = "") -> Response:
        """Serve a UI file."""
        if path.startswith("journeys/") and path.endswith((".arazzo.json", ".expect.json")):
            document = journey_document(path.removeprefix("journeys/"), self.journeys, path_base)
            return (json_response(document, headers=[("x-content-type-options", "nosniff")]) if document is not None
                    else Response(404, [("cache-control", "no-store")]))
        try:
            found: Asset | None = self.assets.get(path)
        except UiBundleError as error:
            return problem_response(503, str(error))
        if found is None:
            return Response(404, [("cache-control", "no-store")])
        return Response(
            200,
            [("content-type", found.content_type), ("cache-control", "no-cache"), ("x-content-type-options", "nosniff")],
            found.content,
        )

    def trace(self, trace_id: str, owner: Owner | None) -> Response:
        """Serve ``GET /sendproof/_api/traces/{id}`` (blocks briefly for an in-flight trace)."""
        headers = [("cache-control", "no-store"), ("x-content-type-options", "nosniff")]
        trace = None if owner is None else self.traces.read(trace_id, owner)
        if trace is None:
            return Response(404, headers)
        return json_response(trace, headers=[("x-content-type-options", "nosniff")])

    # ---------------------------------------------------------------- envelopes
    @staticmethod
    def changes_payload(changes: Iterable[PreviewChange]) -> tuple[list[dict[str, Any]], bool]:
        """Convert provider changes to JSON, enforcing the change cap and byte budget."""
        from . import jsonsafe

        result: list[dict[str, Any]] = []
        items = list(changes)
        truncated = len(items) > limits.CHANGES
        remaining = limits.CHANGE_BUDGET
        for change in items[: limits.CHANGES]:
            key = jsonsafe.snapshot(change.key)
            before = None if change.before is None else jsonsafe.snapshot(change.before)
            after = None if change.after is None else jsonsafe.snapshot(change.after)
            if any(jsonsafe.is_missing(v) for v in (key, before, after)):
                truncated = True
                key = None if jsonsafe.is_missing(key) else key
                before = None if jsonsafe.is_missing(before) else before
                after = None if jsonsafe.is_missing(after) else after
            key, before, after = redact_row(key), redact_row(before), redact_row(after)
            remaining -= len(json.dumps([key, before, after]))
            if remaining < 0:
                truncated = True
                break
            record: dict[str, Any] = {
                "operation": limits.clip(change.operation, limits.NAME),
                "table": limits.clip(change.table, limits.NAME),
                "key": key,
                "before": before,
                "after": after,
            }
            if change.store:
                record["store"] = limits.clip(change.store, limits.NAME)
            if change.namespace:
                record["namespace"] = limits.clip(change.namespace, limits.NAME)
            if change.via in ("upsert", "replace"):
                record["via"] = change.via
            result.append(record)
        return result, truncated

    def preview_envelope(
        self,
        status: int,
        headers: Iterable[tuple[str, str]],
        body: bytes,
        changes: Iterable[PreviewChange],
        changes_truncated: bool,
        capture: CaptureSnapshot,
    ) -> dict[str, Any]:
        """Build the confirmed preview envelope for a captured inner response."""
        kept: dict[str, str] = {}
        content_type = ""
        for name, value in headers:
            lowered = name.lower()
            if lowered == "content-type":
                content_type = value
            if lowered in protocol.PRIVATE_HEADERS or len(lowered) > limits.NAME:
                continue
            if len(kept) >= limits.PARAMETERS and lowered not in kept:
                continue
            kept[lowered] = limits.clip(f"{kept[lowered]}, {value}" if lowered in kept else value)
        payload, truncated = self.changes_payload(changes)
        envelope: dict[str, Any] = {
            "status": status,
            "headers": kept,
            "body": body_from_bytes(content_type, body),
            "changes": payload,
            "effects": capture.effects,
            "logs": capture.logs,
            "rolledBack": True,
        }
        for name, flag in (
            ("changesTruncated", truncated or changes_truncated),
            ("effectsTruncated", capture.effects_truncated),
            ("logsTruncated", capture.logs_truncated),
        ):
            if flag:
                envelope[name] = True
        return envelope

    def trace_document(
        self, changes: Iterable[PreviewChange], changes_truncated: bool, capture: CaptureSnapshot, timing: CaptureTiming
    ) -> dict[str, Any]:
        """Build the document stored for an observed send."""
        payload, truncated = self.changes_payload(changes)
        document: dict[str, Any] = {
            "changes": payload,
            "effects": capture.effects,
            "logs": capture.logs,
            "timing": timing.as_trace(),
        }
        for name, flag in (
            ("changesTruncated", truncated or changes_truncated),
            ("effectsTruncated", capture.effects_truncated),
            ("logsTruncated", capture.logs_truncated),
        ):
            if flag:
                document[name] = True
        return document


def monotonic_ms() -> float:
    """Current ``perf_counter`` in milliseconds."""
    return time.perf_counter() * 1000


__all__ = ["OpenApiDocument", "Response", "Workbench", "json_response", "problem_response", "trace_owner"]

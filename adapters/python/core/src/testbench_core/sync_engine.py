"""Preview, observed send and workbench logic for synchronous (WSGI-style) frameworks.

The Django and Flask adapters translate their request and response types into the arguments
of :class:`SyncBench` and supply a ``dispatch`` callable that runs the real application. The
ASGI adapter has its own async implementation of the same rules.
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator

from . import protocol
from .capture import Capture
from .identity import Identity
from .options import BenchOptions
from .provider import PreviewProvider, PreviewUnavailable
from .scope import RequestScope, activate, deactivate
from .trace_store import Reservation
from .workbench import Response, Workbench, problem_response, trace_owner

logger = logging.getLogger("testbench")


class ResponseTooLarge(Exception):
    """The inner response exceeded the 1 MiB preview cap."""


@dataclass
class Inner:
    """A buffered inner response."""

    status: int
    headers: list[tuple[str, str]]
    body: bytes

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        return next((v for k, v in self.headers if k.lower() == lowered), None)


def is_application_response(scope: RequestScope, status: int) -> bool:
    """Whether a response is the application's own answer rather than a transport-level denial."""
    return protocol.is_application_response(scope.entered, status)


def new_scope(options: BenchOptions, rollback: bool, started: float) -> RequestScope:
    """Create the per-request scope."""
    return RequestScope(Capture(rollback=rollback, started=started), options.environment or "", options.show_sql_values)


class Observed:
    """An in-flight observed send. Use :meth:`headers` on the response and call :meth:`finish`."""

    def __init__(self, bench: "SyncBench", scope: RequestScope, observation: Any, reservation: Reservation) -> None:
        self._bench, self.scope, self._observation, self._reservation = bench, scope, observation, reservation
        self._token = activate(scope)

    def headers(self) -> list[tuple[str, str]]:
        """Headers to add when the response is the application's own answer."""
        return [
            (protocol.TRACE_HEADER, self._reservation.id),
            ("Cache-Control", "no-store"),
            ("Server-Timing", self.scope.capture.timing().server_timing()),
        ]

    def finish(self, completed: bool) -> None:
        """Publish the trace (or discard it) and release the observation."""
        deactivate(self._token)
        capture, workbench = self.scope.capture, self._bench.workbench
        capture.handler_finished()
        try:
            if completed:
                began = time.perf_counter()
                snapshot = capture.finish()
                workbench.traces.complete(
                    self._reservation,
                    workbench.trace_document(
                        self._observation.changes, self._observation.changes_truncated, snapshot,
                        capture.timing((time.perf_counter() - began) * 1000),
                    ),
                )
            else:
                capture.finish()
                workbench.traces.discard(self._reservation)
        except Exception:
            logger.warning("Test Bench could not collect the observed send.", exc_info=True)
            workbench.traces.discard(self._reservation)
        finally:
            try:
                self._observation.close()
            except Exception:
                logger.warning("Test Bench could not release the send observation.", exc_info=True)


class SyncBench:
    """Framework-neutral engine used by the synchronous adapters."""

    def __init__(self, options: BenchOptions, provider: PreviewProvider | None, workbench: Workbench,
                 authorize: Callable[..., bool] | None = None) -> None:
        self.options, self.provider, self.workbench, self.authorize = options, provider, workbench, authorize

    # ------------------------------------------------------------------ helpers
    @property
    def provider_available(self) -> bool:
        return self.provider is not None and self.provider.is_available

    @staticmethod
    def is_reserved(path: str) -> bool:
        return path == protocol.BENCH_PREFIX or path.startswith(protocol.BENCH_PREFIX + "/")

    @staticmethod
    def is_preview_path(path: str) -> bool:
        return path == protocol.PREVIEW_PREFIX or path.startswith(protocol.PREVIEW_PREFIX + "/")

    # ---------------------------------------------------------------- workbench
    def serve_workbench(
        self, *, method: str, path: str, path_base: str, query: str, identity: Identity | None,
        authorized: bool, origin_ok: bool, operations: Callable[[], Iterable[tuple[str, str]]],
        default_openapi_url: str, default_api_name: str,
    ) -> Response:
        """Serve every ``/bench/*`` route except the preview prefix."""
        if method not in ("GET", "HEAD"):
            return Response(405, [("allow", "GET, HEAD")])
        if not authorized:
            return problem_response(403 if identity else 401, "Access to the workbench is denied.")
        workbench = self.workbench
        if path == protocol.BENCH_PREFIX:
            return Response(307, [("location", f"{path_base}/bench/" + (f"?{query}" if query else "")), ("cache-control", "no-store")])
        if path in ("/bench/", "/bench/signin.html"):
            return workbench.asset("index.html")
        if path == "/bench/_api/capabilities":
            return workbench.capabilities(path_base, identity, operations(), default_openapi_url, default_api_name)
        if path.startswith("/bench/_api/traces/"):
            owner = trace_owner(identity, path_base) if origin_ok else None
            return workbench.trace(path.rsplit("/", 1)[1], owner)
        if path.startswith("/bench/_api/"):
            return Response(404, [("cache-control", "no-store")])
        return workbench.asset(path[len("/bench/"):])

    # ------------------------------------------------------------------ preview
    def check_preview_request(self, *, method: str, path: str, get_header: protocol.HeaderGetter, origin_ok: bool) -> Response | None:
        """Validate the transport rules. Returns a rejection or ``None``."""
        if not protocol.has_exact_preference(get_header):
            return problem_response(400, "A Test Bench preview requires Prefer: tx=rollback.")
        if method == "HEAD":
            return problem_response(405, "A preview requires a response body.")
        if not protocol.is_valid_preview_target(path[len(protocol.PREVIEW_PREFIX):]):
            return problem_response(400, "The Test Bench preview target is invalid.")
        if not origin_ok:
            return problem_response(403, "This preview is forbidden.")
        return None

    def preview(self, *, dispatch: Callable[[RequestScope], Inner], started: float, method: str, path: str) -> Response:
        """Run ``dispatch`` inside a rollback scope and wrap its response in the envelope."""
        provider = self.provider
        if provider is None or not provider.is_available:
            return problem_response(503, "Preview requires one available preview provider.")
        scope = new_scope(self.options, True, started)
        token = activate(scope)
        inner: Inner | None = None
        failure: BaseException | None = None
        exceeded = False
        envelope: dict[str, Any] | None = None
        try:
            try:
                session = provider.begin(scope)
            except PreviewUnavailable as error:
                logger.warning("Test Bench preview unavailable: %s", error)
                return problem_response(503, "Preview requires one available preview provider.")
            except Exception:
                logger.exception("A Test Bench preview could not begin for %s %s.", method, path)
                return problem_response(500, "The preview could not be completed safely.")
            try:
                inner = dispatch(scope)
            except ResponseTooLarge:
                exceeded = True
            except Exception as error:
                failure = error
            scope.capture.handler_finished()
            try:
                session.rollback()
                if failure is None and not exceeded and inner is not None and is_application_response(scope, inner.status):
                    envelope = self.workbench.preview_envelope(
                        inner.status, inner.headers, inner.body, list(session.changes), session.changes_truncated,
                        scope.capture.finish(),
                    )
            except Exception as error:
                failure = failure or error
            finally:
                scope.capture.finish()
                try:
                    session.close()
                except Exception as error:
                    failure = failure or error
        finally:
            deactivate(token)

        if failure is not None or exceeded:
            if failure is not None:
                logger.error("A Test Bench preview failed for %s %s.", method, path, exc_info=failure)
            return problem_response(413, "The preview response exceeds the 1 MiB limit.") if exceeded \
                else problem_response(500, "The preview could not be completed safely.")
        if envelope is None:
            if inner is None:
                return problem_response(500, "The preview operation did not finish.")
            status, title = protocol.classify_unexecuted(inner.status)
            challenge = inner.header("www-authenticate")
            return problem_response(status, title, [("www-authenticate", challenge)] if challenge else [])
        began = time.perf_counter()
        body = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        timing = scope.capture.timing((time.perf_counter() - began) * 1000)
        return Response(200, [
            ("content-type", "application/json; charset=utf-8"), ("cache-control", "no-store"),
            ("preference-applied", protocol.ROLLBACK_PREFERENCE), ("server-timing", timing.server_timing()),
        ], body)

    # ----------------------------------------------------------------- observed
    def begin_observed(self, *, identity: Identity | None, path_base: str, started: float, authorized: bool) -> Observed | None:
        """Start an observed send, or return ``None`` when the request should proceed untraced."""
        provider = self.provider
        owner = trace_owner(identity, path_base)
        if provider is None or not provider.is_available or owner is None or not authorized:
            return None
        scope = new_scope(self.options, False, started)
        try:
            observation = provider.begin_observation(scope)
        except Exception:
            logger.warning("Test Bench could not start observing the send.", exc_info=True)
            return None
        if observation is None:
            return None
        return Observed(self, scope, observation, self.workbench.traces.reserve(owner))


@contextmanager
def bounded(maximum: int) -> Iterator[Callable[[bytes], None]]:
    """Yield a writer that raises :class:`ResponseTooLarge` once ``maximum`` bytes are exceeded."""
    total = 0

    def write(chunk: bytes) -> None:
        nonlocal total
        total += len(chunk)
        if total > maximum:
            raise ResponseTooLarge
    yield write

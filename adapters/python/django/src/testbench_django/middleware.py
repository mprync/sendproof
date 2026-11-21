"""Django middleware that serves the workbench and runs previews and observed sends.

Add it **last** in ``MIDDLEWARE`` so that sessions, authentication and your own middleware have
already run when it asks for an identity, and so that the real URL resolution, view middleware
and view of the target run for a preview.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from django.http import HttpRequest, HttpResponse
from django.urls import Resolver404, get_script_prefix, get_urlconf, get_resolver, resolve

from testbench_core import limits, protocol
from testbench_core.scope import install_logging_capture
from testbench_core.sync_engine import Inner, ResponseTooLarge, is_application_response
from testbench_core.workbench import Response, problem_response

from . import conf
from .discovery import preview_operations, view_methods

logger = logging.getLogger("testbench_django")


def _to_http(response: Response, head: bool = False) -> HttpResponse:
    result = HttpResponse(b"" if head else response.body, status=response.status)
    for name, value in response.headers:
        result[name] = value
    return result


class TestBenchMiddleware:
    """Intercepts ``/bench/*`` and Preview/Observed requests; everything else passes through."""

    __test__ = False

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        bench = conf.get_bench()
        if bench.options.enabled:
            install_logging_capture()

    def __call__(self, request: HttpRequest) -> HttpResponse:
        bench = conf.get_bench()
        if not bench.options.enabled:
            return self.get_response(request)
        started = time.perf_counter()
        path, engine = request.path_info, bench.engine
        if engine.is_reserved(path):
            if engine.is_preview_path(path):
                return _to_http(self._preview(request, bench, path, started))
            return _to_http(self._workbench(request, bench, path), request.method == "HEAD")
        headers = _Headers(request)
        if protocol.requests_rollback(headers.getlist):
            return _to_http(problem_response(400, "Use the Test Bench preview URL for rollback requests."))
        if request.method != "HEAD" and protocol.requests_trace(headers.getlist):
            observed = self._observed(request, bench, headers, started)
            if observed is not None:
                return self._run_observed(request, observed)
        return self.get_response(request)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _origin_ok(request: HttpRequest, headers: "_Headers") -> bool:
        return protocol.is_same_origin(headers.getlist, request.scheme, request.get_host())

    @staticmethod
    def _identity(request: HttpRequest, bench: Any) -> Any:
        try:
            return bench.identity(request)
        except Exception:
            logger.exception("The Test Bench identity resolver failed; treating the caller as anonymous.")
            return None

    @staticmethod
    def _authorized(request: HttpRequest, bench: Any, identity: Any) -> bool:
        hook = bench.engine.authorize
        if hook is None:
            return True
        try:
            return bool(hook(request, identity))
        except Exception:
            logger.exception("The Test Bench authorization hook failed; denying access.")
            return False

    @staticmethod
    def _path_base() -> str:
        return get_script_prefix().rstrip("/")

    def _match(self, request: HttpRequest, path: str) -> tuple[Any, int | None]:
        """Resolve ``path`` with Django's own router: (match or None, failing status)."""
        try:
            return resolve(path, getattr(request, "urlconf", None) or get_urlconf()), None
        except Resolver404:
            return None, 404

    # ---------------------------------------------------------------- workbench
    def _workbench(self, request: HttpRequest, bench: Any, path: str) -> Response:
        headers = _Headers(request)
        identity = self._identity(request, bench)
        conf_module = getattr(request, "urlconf", None) or get_urlconf()
        return bench.engine.serve_workbench(
            method=request.method or "GET", path=path, path_base=self._path_base(),
            query=request.META.get("QUERY_STRING", ""), identity=identity,
            authorized=self._authorized(request, bench, identity), origin_ok=self._origin_ok(request, headers),
            operations=lambda: preview_operations(get_resolver(conf_module).url_patterns),
            default_openapi_url="/openapi.json", default_api_name="API",
        )

    # ------------------------------------------------------------------ preview
    def _preview(self, request: HttpRequest, bench: Any, path: str, started: float) -> Response:
        engine, headers, method = bench.engine, _Headers(request), request.method or "GET"
        rejection = engine.check_preview_request(
            method=method, path=path, get_header=headers.getlist, origin_ok=self._origin_ok(request, headers)
        )
        if rejection is not None:
            return rejection
        target = path[len(protocol.PREVIEW_PREFIX):]
        match, _ = self._match(request, target)
        if match is None:
            return problem_response(404, "The preview target was not found for this method.")
        if method not in view_methods(match.func):
            return problem_response(409, "This operation is unavailable for preview.")
        identity = self._identity(request, bench)
        if not self._authorized(request, bench, identity):
            return problem_response(403 if identity else 401, "This preview is forbidden.")

        original = (request.path_info, request.path, request.META.get("PATH_INFO"),
                    request.META.get("HTTP_ACCEPT_ENCODING"), request.META.get("HTTP_CACHE_CONTROL"))

        def dispatch(scope: Any) -> Inner:
            request.path_info = target
            request.path = self._path_base() + target
            request.META["PATH_INFO"] = target
            request.META.pop("HTTP_ACCEPT_ENCODING", None)
            request.META["HTTP_CACHE_CONTROL"] = "no-cache, no-store"
            request.resolver_match = None
            response = self.get_response(request)
            body = _bounded_body(response)
            unhandled = scope.extensions.get("unhandled")
            if unhandled is not None:
                raise unhandled if isinstance(unhandled, BaseException) else RuntimeError("Unhandled application error.")
            return Inner(response.status_code, [(k, v) for k, v in response.items()], body)

        try:
            return engine.preview(dispatch=dispatch, started=started, method=method, path=path)
        finally:
            request.path_info, request.path, meta_path = original[0], original[1], original[2]
            request.META["PATH_INFO"] = meta_path
            for key, value in (("HTTP_ACCEPT_ENCODING", original[3]), ("HTTP_CACHE_CONTROL", original[4])):
                if value is None:
                    request.META.pop(key, None)
                else:
                    request.META[key] = value

    # ----------------------------------------------------------------- observed
    def _observed(self, request: HttpRequest, bench: Any, headers: "_Headers", started: float) -> Any:
        if not bench.engine.provider_available or not self._origin_ok(request, headers):
            return None
        match, _ = self._match(request, request.path_info)
        if match is None or (request.method or "") not in view_methods(match.func):
            return None
        identity = self._identity(request, bench)
        return bench.engine.begin_observed(
            identity=identity, path_base=self._path_base(), started=started,
            authorized=self._authorized(request, bench, identity),
        )

    def _run_observed(self, request: HttpRequest, observed: Any) -> HttpResponse:
        try:
            response = self.get_response(request)
        except BaseException:
            observed.finish(False)
            raise
        if is_application_response(observed.scope, response.status_code):
            for name, value in observed.headers():
                response[name] = value
        if response.streaming:
            response._resource_closers.append(lambda: observed.finish(True))
        else:
            observed.finish(True)
        return response


class _Headers:
    """Adapts Django's merged header view to the protocol helpers."""

    def __init__(self, request: HttpRequest) -> None:
        self._headers = request.headers

    def getlist(self, name: str) -> list[str]:
        value = self._headers.get(name)
        return [] if value is None else [value]


def _bounded_body(response: HttpResponse) -> bytes:
    if getattr(response, "streaming", False):
        chunks, size = [], 0
        for chunk in response.streaming_content:
            size += len(chunk)
            if size > limits.RESPONSE_BYTES:
                raise ResponseTooLarge
            chunks.append(chunk)
        return b"".join(chunks)
    if len(response.content) > limits.RESPONSE_BYTES:
        raise ResponseTooLarge
    return response.content

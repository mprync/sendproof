"""WSGI middleware that serves the workbench and runs previews and observed sends."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Iterable

from werkzeug.datastructures import EnvironHeaders
from werkzeug.exceptions import HTTPException
from werkzeug.routing import RequestRedirect

from sendproof_core import Identity, limits, protocol
from sendproof_core.marker import is_marked, is_previewable, marked_methods
from sendproof_core.sync_engine import Inner, ResponseTooLarge, is_application_response
from sendproof_core.workbench import Response, problem_response

logger = logging.getLogger("sendproof_flask")
StartResponse = Callable[..., Callable[[bytes], Any]]

#: WSGI environ key of a re-dispatched preview: the view checked before the handler runs.
#: Only this middleware sets it; HTTP clients can only add ``HTTP_*`` keys.
PREVIEW_VIEW = "sendproof.preview_view"


class SendproofWsgi:
    """Intercepts ``/sendproof/*`` and Preview/Observed requests; everything else passes through."""

    __test__ = False

    def __init__(self, app: Callable[..., Iterable[bytes]], bench: Any) -> None:
        self.app, self.bench = app, bench

    def __call__(self, environ: dict, start_response: StartResponse) -> Iterable[bytes]:
        bench = self.bench
        if not bench.options.enabled or PREVIEW_VIEW in environ:
            # A re-dispatched preview passes straight through; Flask checks it in before_request.
            return self.app(environ, start_response)
        started = time.perf_counter()
        path = environ.get("PATH_INFO", "") or "/"
        headers = EnvironHeaders(environ)
        engine = bench.engine
        if engine.is_reserved(path):
            if engine.is_preview_path(path):
                return self._respond(start_response, self._preview(environ, headers, path, started), environ)
            return self._respond(start_response, self._workbench(environ, headers, path), environ)
        if protocol.requests_rollback(headers.getlist):
            return self._respond(start_response, problem_response(400, "Use the Sendproof preview URL for rollback requests."), environ)
        if environ["REQUEST_METHOD"] != "HEAD" and protocol.requests_trace(headers.getlist):
            observed = self._observed(environ, headers, started)
            if observed is not None:
                return self._run_observed(observed, environ, start_response)
        return self.app(environ, start_response)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _respond(start_response: StartResponse, response: Response, environ: dict) -> Iterable[bytes]:
        head = environ["REQUEST_METHOD"] == "HEAD"
        headers = [(k, v) for k, v in response.headers if k.lower() != "content-length"]
        headers.append(("Content-Length", str(len(response.body))))
        from http import HTTPStatus

        try:
            phrase = HTTPStatus(response.status).phrase
        except ValueError:
            phrase = "Status"
        start_response(f"{response.status} {phrase}", headers)
        return [b"" if head else response.body]

    def _hook(self, environ: dict, call: Callable[[Any], Any]) -> Any:
        """Run an identity or authorization hook inside a Flask request context."""
        with self.bench.app.request_context(dict(environ)):
            from flask import request

            return call(request)

    def _identity(self, environ: dict) -> Identity | None:
        resolver = self.bench.options.identity
        if resolver is None:
            return None
        try:
            return self._hook(environ, resolver)
        except Exception:
            logger.exception("The Sendproof identity resolver failed; treating the caller as anonymous.")
            return None

    def _authorized(self, environ: dict, identity: Identity | None) -> bool:
        hook = self.bench.engine.authorize
        if hook is None:
            return True
        try:
            return bool(self._hook(environ, lambda request: hook(request, identity)))
        except Exception:
            logger.exception("The Sendproof authorization hook failed; denying access.")
            return False

    @staticmethod
    def _origin_ok(environ: dict, headers: EnvironHeaders) -> bool:
        return protocol.is_same_origin(headers.getlist, environ.get("wsgi.url_scheme", "http"), headers.get("Host", ""))

    def _match(self, environ: dict, path: str) -> tuple[Any, int | None]:
        """Resolve ``path`` with Flask's own router: (view or None, failing status)."""
        adapter = self.bench.app.url_map.bind_to_environ({**environ, "PATH_INFO": path})
        try:
            endpoint, _ = adapter.match(method=environ["REQUEST_METHOD"])
        except RequestRedirect:
            return None, 308
        except HTTPException as error:
            return None, error.code
        return self.bench.app.view_functions.get(endpoint), None

    # ---------------------------------------------------------------- workbench
    def _workbench(self, environ: dict, headers: EnvironHeaders, path: str) -> Response:
        bench = self.bench
        identity = self._identity(environ)
        return bench.engine.serve_workbench(
            method=environ["REQUEST_METHOD"], path=path, path_base=environ.get("SCRIPT_NAME", ""),
            query=environ.get("QUERY_STRING", ""), identity=identity, authorized=self._authorized(environ, identity),
            origin_ok=self._origin_ok(environ, headers), operations=bench.operations,
            default_openapi_url="/openapi.json", default_api_name=bench.app.name, unavailable=bench.unavailable,
        )

    # ------------------------------------------------------------------ preview
    def _preview(self, environ: dict, headers: EnvironHeaders, path: str, started: float) -> Response:
        bench, engine = self.bench, self.bench.engine
        method = environ["REQUEST_METHOD"]
        rejection = engine.check_preview_request(
            method=method, path=path, get_header=headers.getlist, origin_ok=self._origin_ok(environ, headers)
        )
        if rejection is not None:
            return rejection
        target = path[len(protocol.PREVIEW_PREFIX):]
        view, failure = self._match(environ, target)
        if view is None:
            return problem_response(404 if failure in (404, None) else 405 if failure == 405 else 404,
                                    "The preview target was not found for this method.")
        if not is_previewable(view) or method not in marked_methods(view):
            return problem_response(409, "This operation is unavailable for preview.")
        identity = self._identity(environ)
        if not self._authorized(environ, identity):
            return problem_response(403 if identity else 401, "This preview is forbidden.")

        inner_env = dict(environ)
        inner_env["PATH_INFO"] = target
        inner_env.pop("HTTP_ACCEPT_ENCODING", None)
        inner_env["HTTP_CACHE_CONTROL"] = "no-cache, no-store"
        inner_env[PREVIEW_VIEW] = view

        def dispatch(scope: Any) -> Inner:
            captured: dict[str, Any] = {}

            def start(status: str, response_headers: list[tuple[str, str]], exc_info: Any = None):
                captured["status"] = int(status.split(" ", 1)[0])
                captured["headers"] = list(response_headers)
                return lambda data: None

            chunks, size = [], 0
            # Dispatch through the application's whole WSGI chain (``app.wsgi_app`` as it is now,
            # including middleware wrapped around Sendproof later), so path-based host
            # middleware sees the target path rather than /sendproof/_preview.
            iterable = bench.app.wsgi_app(inner_env, start)
            try:
                for chunk in iterable:
                    size += len(chunk)
                    if size > limits.RESPONSE_BYTES:
                        raise ResponseTooLarge
                    chunks.append(chunk)
            finally:
                close = getattr(iterable, "close", None)
                if close:
                    close()
            unhandled = scope.extensions.get("unhandled")
            if unhandled is not None:
                raise unhandled
            return Inner(captured["status"], captured["headers"], b"".join(chunks))

        return engine.preview(dispatch=dispatch, started=started, method=method, path=path)

    # ----------------------------------------------------------------- observed
    def _observed(self, environ: dict, headers: EnvironHeaders, started: float):
        bench = self.bench
        if not bench.engine.provider_available or not self._origin_ok(environ, headers):
            return None
        view, failure = self._match(environ, environ.get("PATH_INFO", "/"))
        if view is None or not is_marked(view) or environ["REQUEST_METHOD"] not in marked_methods(view):
            return None
        identity = self._identity(environ)
        return bench.engine.begin_observed(
            identity=identity, path_base=environ.get("SCRIPT_NAME", ""), started=started,
            authorized=self._authorized(environ, identity),
        )

    def _run_observed(self, observed: Any, environ: dict, start_response: StartResponse) -> Iterable[bytes]:
        state = {"started": False}

        def start(status: str, response_headers: list[tuple[str, str]], exc_info: Any = None):
            state["started"] = True
            if is_application_response(observed.scope, int(status.split(" ", 1)[0])):
                dropped = {"cache-control", "server-timing"}
                response_headers = [(k, v) for k, v in response_headers if k.lower() not in dropped] + observed.headers()
            return start_response(status, response_headers, exc_info)

        try:
            body = self.app(environ, start)
        except BaseException:
            observed.finish(False)
            raise
        return _ObservedBody(body, observed, state)


class _ObservedBody:
    """Publishes the trace once the server has consumed and closed the response."""

    def __init__(self, body: Iterable[bytes], observed: Any, state: dict) -> None:
        self._body, self._observed, self._state, self._done = body, observed, state, False

    def __iter__(self):
        try:
            yield from self._body
        except BaseException:
            self._finish(False)
            raise

    def close(self) -> None:
        try:
            close = getattr(self._body, "close", None)
            if close:
                close()
        finally:
            self._finish(self._state["started"])

    def _finish(self, completed: bool) -> None:
        if not self._done:
            self._done = True
            self._observed.finish(completed)

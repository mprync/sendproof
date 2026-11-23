"""Pure ASGI middleware that serves the workbench and runs previews and observed sends."""

from __future__ import annotations

import inspect
import json
import logging
import time
from typing import Any, Awaitable, Callable

import anyio
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.routing import Match

from sendproof_core import Identity, PreviewUnavailable, RequestScope, protocol
from sendproof_core.capture import Capture
from sendproof_core.marker import enter, unavailable_info
from sendproof_core.provider import run_in_thread
from sendproof_core.scope import activate, deactivate, request_context
from sendproof_core.sessions import HEADER, Call, HeldSession, SessionError, arun, is_route, not_found, session_id
from sendproof_core.sync_engine import Inner, ResponseTooLarge
from sendproof_core.workbench import Response, Workbench, blocked_response, json_response, problem_response, trace_owner

from .capture_send import BufferedResponse
from .marker import is_marked, is_previewable
from .routing import find_route, preview_operations, route_path, unavailable_operations

logger = logging.getLogger("sendproof_fastapi")
ASGIApp = Callable[..., Awaitable[None]]

#: Scope key of a re-dispatched preview: the route that was checked before the handler runs.
#: Only this middleware sets it; HTTP clients cannot place keys in the ASGI scope.
PREVIEW_ROUTE = "sendproof.preview_route"


class SendproofMiddleware:
    """Intercepts ``/sendproof/*`` and Preview/Observed requests; everything else passes through."""

    __test__ = False

    def __init__(self, app: ASGIApp, bench: "Any") -> None:
        self.app = app
        self.bench = bench

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] == "lifespan":
            async def lifecycle():
                message = await receive()
                if message["type"] == "lifespan.shutdown":
                    with anyio.CancelScope(shield=True):
                        await arun(self.bench.sessions.shutdown())
                return message

            await self.app(scope, lifecycle, send)
            return
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        # Every request is attributed, so a store write that no request accounts for (a thread a
        # Preview handler started without its context) can fail the open Previews.
        with request_context():
            await self._handle(scope, receive, send)

    async def _handle(self, scope: dict, receive: Callable, send: Callable) -> None:
        bench = self.bench
        if scope["type"] != "http" or not bench.options.enabled:
            await self.app(scope, receive, send)
            return
        if PREVIEW_ROUTE in scope:
            await self._inner_preview(scope, receive, send)
            return
        started = time.perf_counter()
        path = route_path(scope)
        if path == protocol.BENCH_PREFIX or path.startswith(protocol.BENCH_PREFIX + "/"):
            if path == protocol.PREVIEW_PREFIX or path.startswith(protocol.PREVIEW_PREFIX + "/"):
                await self._preview(scope, receive, send, path, started)
            else:
                await self._workbench(scope, receive, send, path)
            return
        headers = Headers(scope=scope)
        if protocol.requests_rollback(headers.getlist):
            await _send(send, problem_response(400, "Use the Sendproof preview URL for rollback requests."))
            return
        if scope["method"] != "HEAD" and protocol.requests_trace(headers.getlist):
            if await self._observed(scope, receive, send, headers, started):
                return
        await self.app(scope, receive, send)

    # ------------------------------------------------------------------ helpers
    async def _identity(self, scope: dict, receive: Callable) -> Identity | None:
        resolver = self.bench.options.identity
        if resolver is None:
            return None
        try:
            result = resolver(Request(scope, receive))
            return await result if inspect.isawaitable(result) else result
        except Exception:
            logger.exception("The Sendproof identity resolver failed; treating the caller as anonymous.")
            return None

    async def _authorized(self, scope: dict, receive: Callable, identity: Identity | None) -> bool:
        hook = self.bench.authorize
        if hook is None:
            return True
        try:
            result = hook(Request(scope, receive), identity)
            return bool(await result if inspect.isawaitable(result) else result)
        except Exception:
            logger.exception("The Sendproof authorization hook failed; denying access.")
            return False

    @staticmethod
    def _origin_ok(scope: dict, headers: Headers) -> bool:
        return protocol.is_same_origin(headers.getlist, scope.get("scheme", "http"), headers.get("host", ""))

    async def _describe_stores(self) -> list[dict]:
        described = []
        for store in self.bench.stores:
            try:
                described.append(await store.adescribe())
            except Exception:
                logger.warning("Sendproof could not describe a data store.", exc_info=True)
        return described

    # ---------------------------------------------------------------- workbench
    async def _workbench(self, scope: dict, receive: Callable, send: Callable, path: str) -> None:
        bench: Any = self.bench
        method = scope["method"]
        session_route = is_route(path)
        if not session_route and method not in ("GET", "HEAD"):
            await _send(send, Response(405, [("allow", "GET, HEAD")]), head=False)
            return
        identity = await self._identity(scope, receive)
        authorized = await self._authorized(scope, receive, identity)
        if not session_route and not authorized:
            await _send(send, problem_response(403 if identity else 401, "Access to the workbench is denied."), head=method == "HEAD")
            return
        root = scope.get("root_path", "")
        workbench: Workbench = bench.workbench
        app = scope["app"]
        openapi = getattr(app, "openapi_url", None) or "/openapi.json"
        if session_route:
            async def read_body() -> bytes:
                body = bytearray()
                async for chunk in Request(scope, receive).stream():
                    body.extend(chunk[:4097 - len(body)])
                    if len(body) > 4096:
                        return b""
                return bytes(body)

            with anyio.CancelScope(shield=True):
                response = await arun(bench.sessions.route(
                    path, method, identity, root, authorized, self._origin_ok(scope, Headers(scope=scope)),
                    Call(None, async_call=self._describe_stores), Call(None, async_call=read_body),
                ))
        elif path == protocol.BENCH_PREFIX:
            query = scope.get("query_string", b"").decode("latin-1")
            location = f"{root}/sendproof/" + (f"?{query}" if query else "")
            response = Response(307, [("location", location), ("cache-control", "no-store")])
        elif path in ("/sendproof/", "/sendproof/signin.html"):
            response = workbench.asset("index.html")
        elif path == "/sendproof/_api/capabilities":
            described = await self._describe_stores()
            response = workbench.capabilities(
                root, identity, preview_operations(app.router.routes), openapi, getattr(app, "title", "API"),
                unavailable_operations(app.router.routes), described, bench.sessions.supported(described),
            )
        elif path.startswith("/sendproof/_api/traces/"):
            headers = Headers(scope=scope)
            owner = trace_owner(identity, root) if self._origin_ok(scope, headers) else None
            response = await run_in_thread(workbench.trace, path.rsplit("/", 1)[1], owner)
        elif path.startswith("/sendproof/_api/"):
            response = Response(404, [("cache-control", "no-store")])
        else:
            response = workbench.asset(path[len("/sendproof/"):], root)
        await _send(send, response, head=method == "HEAD")

    # ------------------------------------------------------------------ preview
    async def _preview(self, scope: dict, receive: Callable, send: Callable, path: str, started: float) -> None:
        headers = Headers(scope=scope)
        id = session_id(headers.getlist(HEADER))
        if not protocol.has_exact_preference(headers.getlist):
            await _send(send, problem_response(400, "A Sendproof preview requires Prefer: tx=rollback."))
            return
        if scope["method"] == "HEAD":
            await _send(send, problem_response(405, "A preview requires a response body."))
            return
        target = path[len(protocol.PREVIEW_PREFIX):]
        if not protocol.is_valid_preview_target(target):
            await _send(send, problem_response(400, "The Sendproof preview target is invalid."))
            return
        if not self._origin_ok(scope, headers):
            await _send(send, not_found().response if id is not None else problem_response(403, "This preview is forbidden."))
            return
        identity = await self._identity(scope, receive)
        held = None
        try:
            if id is not None:
                held = self.bench.sessions.acquire(id, identity, scope.get("root_path", ""), True)
            response = await self._dispatch_preview(scope, receive, send, path, target, started, identity, held)
        except SessionError as error:
            response = error.response
        finally:
            if held is not None:
                with anyio.CancelScope(shield=True):
                    await arun(self.bench.sessions.release(held))
        if response is not None:
            await _send(send, response)

    async def _dispatch_preview(self, scope: dict, receive: Callable, send: Callable, path: str, target: str,
                                started: float, identity: Identity | None, held: HeldSession | None) -> Response | None:
        bench: Any = self.bench
        prefix = scope["path"][: len(scope["path"]) - len(path)]
        inner = dict(scope)
        inner["path"] = prefix + target
        raw = scope.get("raw_path")
        if raw is not None:
            marker = protocol.PREVIEW_PREFIX.encode()
            index = raw.find(marker)
            inner["raw_path"] = raw[:index] + raw[index + len(marker):] if index >= 0 else inner["path"].encode()
        inner["headers"] = [
            (k, v) for k, v in scope["headers"] if k.lower() != b"accept-encoding"
        ] + [(b"cache-control", b"no-cache, no-store")]
        inner.pop("endpoint", None)
        # The host's middleware runs again for the inner request. Give it its own per-request
        # dictionaries so that session or state changes made during the preview never reach the
        # outer response (for example a session cookie written by SessionMiddleware).
        for key in ("state", "session"):
            if isinstance(inner.get(key), dict):
                inner[key] = dict(inner[key])

        found = find_route(scope["app"].router.routes, inner)
        if found is None or found[1] != Match.FULL:
            return problem_response(404 if found is None else 405, "The preview target was not found for this method.")
        endpoint = getattr(found[0], "endpoint", None)
        read_step = held is not None and scope["method"] == "GET"
        if unavailable_info(endpoint) is not None or (not read_step and not is_previewable(endpoint)):
            return problem_response(409, "This operation is unavailable for preview.")
        inner[PREVIEW_ROUTE] = (found[0], read_step)
        if not await self._authorized(scope, receive, identity):
            return problem_response(403 if identity else 401, "This preview is forbidden.")
        provider = bench.provider
        if provider is None or not provider.is_available:
            return problem_response(503, "Preview requires one available preview provider.")
        if held is None:
            await self._run_preview(inner, receive, send, provider, started, scope["method"], path)
            return

        async def dispatch() -> Inner:
            buffered = BufferedResponse()
            await inner["app"](inner, receive, buffered)
            if buffered.exceeded:
                raise ResponseTooLarge
            if not buffered.started:
                raise RuntimeError("The Preview did not produce a response.")
            return Inner(buffered.status, buffered.headers, buffered.body)

        request_scope = RequestScope(Capture(rollback=True, started=started), bench.options.environment or "",
                                     bench.options.show_sql_values)
        # The held step can be interrupted during dispatch. The driver still completes the
        # rewind/cleanup commands before the session lease is returned.
        with anyio.CancelScope(shield=True):
            return await arun(held.preview(request_scope, Call(None, async_call=dispatch), bench.workbench))

    async def _inner_preview(self, scope: dict, receive: Callable, send: Callable) -> None:
        """Last check of a re-dispatched preview, after every host middleware has run.

        Host middleware may have changed the method (method override) or the path. The handler
        runs only when the request still routes to the marked route checked earlier; otherwise
        nothing executes and the preview answers 409.
        """
        found = find_route(scope["app"].router.routes, scope)
        expected, read_step = scope[PREVIEW_ROUTE]
        if (found is None or found[1] != Match.FULL or found[0] is not expected
                or (read_step and scope["method"] != "GET")):
            await _send(send, problem_response(409, "This operation is unavailable for preview."))
            return
        if read_step:
            enter()
        await self.app(scope, receive, send)

    async def _run_preview(
        self, inner: dict, receive: Callable, send: Callable, provider: Any, started: float, method: str, path: str
    ) -> None:
        bench: Any = self.bench
        workbench: Workbench = bench.workbench
        capture = Capture(rollback=True, started=started)
        request_scope = RequestScope(capture, bench.options.environment or "", bench.options.show_sql_values)
        token = activate(request_scope)
        buffered = BufferedResponse()
        failure: BaseException | None = None
        unsafe = False  # a store abort or the SQL rollback failed: the Preview can never be confirmed
        envelope: dict[str, Any] | None = None
        session = None
        response: Response | None = None
        interrupted: BaseException | None = None
        begun: list[Any] = []
        try:
            try:
                session = provider.begin(request_scope)
            except PreviewUnavailable as error:
                logger.warning("Sendproof preview unavailable: %s", error)
                response = problem_response(503, "Preview requires one available preview provider.")
            except Exception:
                logger.exception("A Sendproof preview could not begin for %s %s.", method, path)
                response = problem_response(500, "The preview could not be completed safely.")
            if session is not None:
                try:
                    for store in bench.stores:
                        begun.append(store)  # finish runs for a store whose begin failed halfway, too
                        await store.abegin(request_scope)
                    # Dispatch through the whole application, as .NET does: the host middleware
                    # (authentication, path-based policies, method override) sees the target path
                    # rather than /sendproof/_preview, and _inner_preview re-checks the route last.
                    await inner["app"](inner, receive, buffered)
                except Exception as error:
                    failure = error
                except BaseException as error:  # cancellation or client abort: roll back first
                    failure = interrupted = error
                capture.handler_finished()
                # Pipeline order (spec/data-stores.md): abort every preview-mode store transaction,
                # then roll back SQL. A failure of either withholds confirmation.
                # Every cleanup step runs, shielded from the request's cancellation and whatever an
                # earlier step raised: an interrupt inside one store's abort must not skip the other
                # stores, the SQL rollback or the release (and a MySQL Preview's turn). The first
                # interrupt is re-raised once everything is cleaned up.
                with anyio.CancelScope(shield=True):
                    for store in reversed(begun):
                        try:
                            await store.afinish(request_scope)
                        except BaseException as error:
                            unsafe = True
                            interrupted = interrupted or (None if isinstance(error, Exception) else error)
                            logger.error("A Sendproof data store could not finish the preview.", exc_info=error)
                    try:
                        await session.arollback()
                        if (not unsafe and failure is None and not buffered.exceeded and buffered.started
                                and _is_application(request_scope, buffered)):
                            envelope = workbench.preview_envelope(
                                buffered.status, buffered.headers, buffered.body,
                                [*session.changes, *request_scope.store_changes],
                                session.changes_truncated or request_scope.store_changes_truncated, capture.finish(),
                            )
                    except BaseException as error:
                        unsafe = True
                        interrupted = interrupted or (None if isinstance(error, Exception) else error)
                        logger.error("A Sendproof preview could not roll back for %s %s.", method, path, exc_info=error)
                    finally:
                        capture.finish()
                        try:
                            await session.aclose()
                        except BaseException as error:
                            unsafe = True
                            interrupted = interrupted or (None if isinstance(error, Exception) else error)
                            logger.error("A Sendproof preview could not release its transaction.", exc_info=error)
        finally:
            deactivate(token)

        if interrupted is not None:
            raise interrupted
        if response is None:
            response = self._finish_preview(request_scope, buffered, failure, envelope, method, path, unsafe)
        await _send(send, response)

    def _finish_preview(
        self, scope: RequestScope, buffered: BufferedResponse, failure: BaseException | None,
        envelope: dict[str, Any] | None, method: str, path: str, unsafe: bool = False,
    ) -> Response:
        blocked, fault = scope.capture.blocked, scope.capture.fault
        if unsafe or fault is not None:
            # A failed rollback or abort, a handler COMMIT, or a write that escaped the MongoDB
            # session: nothing can be confirmed, and that outranks a blocked write.
            if fault is not None:
                logger.error("A Sendproof preview was not confirmed for %s %s: %s", method, path, fault)
            return problem_response(500, "The preview could not be completed safely.")
        if blocked is not None:
            # The mark decides, whatever the handler did with the refusal: it may have caught the
            # error and returned 200, or let it escape as a 500.
            return blocked_response(blocked)
        if failure is not None or buffered.exceeded:
            if failure is not None:
                logger.error("A Sendproof preview failed for %s %s.", method, path, exc_info=failure)
            if buffered.exceeded:
                return problem_response(413, "The preview response exceeds the 1 MiB limit.")
            return problem_response(500, "The preview could not be completed safely.")
        if envelope is None:
            if not buffered.started:
                return problem_response(500, "The preview operation did not finish.")
            status, title = protocol.classify_unexecuted(buffered.status if buffered.started else 500)
            extra = [("www-authenticate", challenge)] if (challenge := buffered.header("www-authenticate")) else []
            return problem_response(status, title, extra)
        started = time.perf_counter()
        body = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        timing = scope.capture.timing((time.perf_counter() - started) * 1000)
        return Response(
            200,
            [
                ("content-type", "application/json; charset=utf-8"),
                ("cache-control", "no-store"),
                ("preference-applied", protocol.ROLLBACK_PREFERENCE),
                ("server-timing", timing.server_timing()),
            ],
            body,
        )

    # ----------------------------------------------------------------- observed
    async def _observed(self, scope: dict, receive: Callable, send: Callable, headers: Headers, started: float) -> bool:
        """Run an observed send. Returns ``False`` when the request should proceed untraced."""
        bench: Any = self.bench
        provider = bench.provider
        if provider is None or not provider.is_available or not self._origin_ok(scope, headers):
            return False
        found = find_route(scope["app"].router.routes, scope)
        if found is None or found[1] != Match.FULL or not is_marked(getattr(found[0], "endpoint", None)):
            return False
        identity = await self._identity(scope, receive)
        owner = trace_owner(identity, scope.get("root_path", ""))
        if owner is None or not await self._authorized(scope, receive, identity):
            return False
        capture = Capture(rollback=False, started=started)
        request_scope = RequestScope(capture, bench.options.environment or "", bench.options.show_sql_values)
        try:
            observation = provider.begin_observation(request_scope)
        except Exception:
            logger.warning("Sendproof could not start observing the send.", exc_info=True)
            return False
        if observation is None:
            return False

        workbench: Workbench = bench.workbench
        reservation = workbench.traces.reserve(owner)
        completed = False
        response_started = False

        async def traced_send(message: dict) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start" and not response_started:
                response_started = True
                if protocol.is_application_response(request_scope.entered, message["status"]):
                    kept = [(k, v) for k, v in message.get("headers", []) if k.lower() not in (b"cache-control", b"server-timing")]
                    message = {**message, "headers": [
                        *kept,
                        (protocol.TRACE_HEADER.lower().encode(), reservation.id.encode()),
                        (b"cache-control", b"no-store"),
                        (b"server-timing", capture.timing().server_timing().encode()),
                    ]}
            await send(message)

        token = activate(request_scope)
        try:
            await self.app(scope, receive, traced_send)
            completed = response_started
        finally:
            deactivate(token)
            capture.handler_finished()
            try:
                if completed:
                    began = time.perf_counter()
                    snapshot = capture.finish()
                    document = workbench.trace_document(
                        observation.changes, observation.changes_truncated, snapshot,
                        capture.timing((time.perf_counter() - began) * 1000),
                    )
                    workbench.traces.complete(reservation, document)
                else:
                    capture.finish()
                    workbench.traces.discard(reservation)
            except Exception:
                logger.warning("Sendproof could not collect the observed send.", exc_info=True)
                workbench.traces.discard(reservation)
            finally:
                try:
                    observation.close()
                except Exception:
                    logger.warning("Sendproof could not release the send observation.", exc_info=True)
        return True


def _is_application(scope: RequestScope, buffered: BufferedResponse) -> bool:
    """Whether the response is the application's own answer rather than a transport-level denial."""
    return protocol.is_application_response(scope.entered, buffered.status)


async def _send(send: Callable, response: Response, head: bool = False) -> None:
    headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in response.headers]
    if not any(k == b"content-length" for k, _ in headers):
        headers.append((b"content-length", str(len(response.body)).encode()))
    await send({"type": "http.response.start", "status": response.status, "headers": headers})
    await send({"type": "http.response.body", "body": b"" if head else response.body})


__all__ = ["SendproofMiddleware", "json_response"]

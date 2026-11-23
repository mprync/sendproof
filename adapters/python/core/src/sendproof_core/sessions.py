"""Process-local Preview sessions and their held store transactions."""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import secrets
import threading
import time
import weakref
from dataclasses import dataclass, field
from typing import Any, Callable, Generator, Iterable

from .identity import Identity
from .provider import PreviewRollbackError, run_in_thread
from . import protocol
from .scope import RequestScope, activate, deactivate
from .workbench import Response, Workbench, blocked_response, json_response, problem_response, trace_owner

PATH = "/sendproof/_api/sessions"
HEADER = "sendproof-session"
_logger = logging.getLogger("sendproof")


class SessionError(RuntimeError):
    def __init__(self, code: str, status: int, title: str, **extra: Any) -> None:
        self.response = json_response(
            {"type": "about:blank", "code": code, "status": status, "title": title, **extra}, status,
        ).with_content_type("application/problem+json")
        super().__init__(title)


class StoreBusy(RuntimeError):
    """A store already holds a lock required by a new session."""


class StoreEnded(PreviewRollbackError):
    """The store ended a previously held transaction."""


class StepFailed(PreviewRollbackError):
    """A failed statement left the transaction requiring a rewind."""


def not_found() -> SessionError:
    return SessionError("session_not_found", 404, "The Preview session was not found.")


def failed() -> SessionError:
    return SessionError("session_failed", 409, "A required Preview session transaction is unavailable.")


def is_route(path: str) -> bool:
    return path == PATH or path.startswith(PATH + "/")


def session_id(values: list[str]) -> str | None:
    """Only a single header value can identify a session."""
    if not values:
        return None
    return values[0].strip() if len(values) == 1 else ""


def savepoint(step: int) -> str:
    return f"sendproof_step_{step}"


class HeldPart:
    """Store-specific work performed serially under a session lease."""

    def attach(self, scope: RequestScope, step: int) -> None:
        """Save and bind this store to the step's capture and request."""

    def collect(self, scope: RequestScope, step: int) -> None:
        """Confirm the store is still held and collect the step's changes."""

    def detach(self, scope: RequestScope) -> None:
        """Release request bindings while retaining the transaction."""

    def rewind(self, step: int) -> None:
        """Undo a step and all later steps."""

    def close(self) -> None:
        """Roll back and release the held transaction."""

    async def ainvoke(self, method: Callable, *args: Any) -> Any:
        return await run_in_thread(method, *args)


@dataclass
class Call:
    sync: Callable | None
    args: tuple = ()
    async_call: Callable | None = None


Operation = Generator[Call, Any, Any]


def run(operation: Operation) -> Any:
    """Drive shared lifecycle logic using the current WSGI request thread."""
    try:
        call = next(operation)
        while True:
            try:
                if call.sync is None:
                    raise RuntimeError("This Preview session operation requires an ASGI adapter.")
                result = call.sync(*call.args)
            except BaseException as error:
                call = operation.throw(error)
            else:
                call = operation.send(result)
    except StopIteration as end:
        return end.value


async def arun(operation: Operation) -> Any:
    """Drive the same lifecycle with the ASGI stores' native async entry points."""
    try:
        call = next(operation)
        while True:
            try:
                if call.async_call:
                    result = await call.async_call(*call.args)
                elif call.sync:
                    result = await run_in_thread(call.sync, *call.args)
                else:
                    raise RuntimeError("Missing Preview session operation.")
            except BaseException as error:
                call = operation.throw(error)
            else:
                call = operation.send(result)
    except StopIteration as end:
        return end.value


@dataclass
class HeldSession:
    id: str
    owner: tuple
    created: float
    last_used: float
    parts: list[HeldPart] = field(default_factory=list)
    step: int = 1
    busy: bool = True
    discard: bool = False
    timer: threading.Timer | asyncio.TimerHandle | None = None

    def apply(self, name: str, *args: Any, reverse: bool = False) -> Operation:
        for part in reversed(self.parts) if reverse else self.parts:
            method = getattr(part, name)
            yield Call(method, args, lambda *values: part.ainvoke(method, *values))

    def rewind(self) -> Operation:
        try:
            yield from self.apply("rewind", self.step, reverse=True)
        except BaseException:
            self.discard = True
            raise

    def finish_step(self, scope: RequestScope, keep: bool) -> Operation:
        """Collect a successful step or restore its savepoint before the next request."""
        try:
            if scope.capture.fault is not None:
                self.discard = True
                return
            if keep:
                try:
                    yield from self.apply("collect", scope, self.step, reverse=True)
                except StepFailed:
                    yield from self.rewind()
                    raise
            else:
                yield from self.rewind()
        finally:
            yield from self.apply("detach", scope, reverse=True)

    def preview(self, scope: RequestScope, dispatch: Call, workbench: Workbench) -> Operation:
        """Run a step with a fresh capture and advance only after a confirmed response."""
        from .sync_engine import ResponseTooLarge

        token = activate(scope)
        try:
            try:
                yield from self.apply("attach", scope, self.step)
            except BaseException:
                self.discard = True
                yield from self.apply("detach", scope, reverse=True)
                raise
            inner = None
            error = None
            try:
                inner = yield dispatch
            except BaseException as failure:
                error = failure
            scope.capture.handler_finished()
            keep = (
                error is None and inner is not None and inner.status < 500
                and scope.capture.blocked is None and scope.capture.fault is None
                and protocol.is_application_response(scope.entered, inner.status)
            )
            yield from self.finish_step(scope, keep)
            if error is not None and not isinstance(error, Exception):
                raise error
            if scope.capture.fault is not None:
                raise PreviewRollbackError(str(scope.capture.fault))
            if scope.capture.blocked is not None:
                return blocked_response(scope.capture.blocked)
            if isinstance(error, ResponseTooLarge):
                return problem_response(413, "The preview response exceeds the 1 MiB limit.")
            if error is not None or inner is None or inner.status >= 500:
                return problem_response(500, "The preview could not be completed safely.")
            if not keep:
                status, title = protocol.classify_unexecuted(inner.status)
                challenge = inner.header("www-authenticate")
                return problem_response(status, title, [("www-authenticate", challenge)] if challenge else [])
            began = time.perf_counter()
            try:
                envelope = workbench.preview_envelope(
                    inner.status, inner.headers, inner.body, scope.store_changes,
                    scope.store_changes_truncated, scope.capture.finish(),
                )
                envelope["session"] = self.envelope
                response = json_response(envelope, headers=[
                    ("preference-applied", protocol.ROLLBACK_PREFERENCE),
                ])
            except Exception:
                yield from self.rewind()
                raise StepFailed("The Preview result could not be serialized.")
            response.headers.append(("server-timing", scope.capture.timing((time.perf_counter() - began) * 1000).server_timing()))
            self.step += 1
            return response
        except StoreEnded:
            self.discard = True
            return failed().response
        except StepFailed:
            return problem_response(500, "The preview could not be completed safely.")
        except BaseException as error:
            self.discard = True
            if not isinstance(error, Exception):
                raise
            _logger.warning("The held Preview could not be confirmed.", exc_info=error)
            return problem_response(500, "The preview could not be completed safely.")
        finally:
            scope.capture.finish()
            deactivate(token)

    @property
    def envelope(self) -> dict[str, Any]:
        return {"id": self.id, "step": self.step}


class SessionRegistry:
    """Admission, ownership, expiry and exclusive use of a host's held sessions."""

    def __init__(self, options: Any, provider: Any, stores: Iterable, *, asynchronous: bool = False) -> None:
        self.options, self.provider, self.stores = options, provider, tuple(stores)
        self.asynchronous = asynchronous
        self._sessions: dict[str, HeldSession] = {}
        self._lock = threading.Lock()
        self._shutdown = False
        if not asynchronous:
            _wsgi_registries.add(self)

    def supported(self, described: Iterable[dict[str, Any]]) -> bool:
        modes = {store["system"]: store["mode"] for store in described}
        provider_support = getattr(self.provider, "supports_held", None)
        return bool(
            self.options.enabled and self.provider is not None and self.provider.is_available
            and provider_support is not None and provider_support(self.asynchronous)
            and all(
                store.supports_held(self.asynchronous) or modes.get(store.system) == "guard"
                for store in self.stores
            )
        )

    @property
    def idle(self) -> int:
        return self.options.session_idle_timeout

    @property
    def lifetime(self) -> int:
        return self.options.session_max_lifetime

    def _deadline(self, session: HeldSession) -> float:
        return min(session.last_used + self.idle, session.created + self.lifetime)

    def _schedule(self, session: HeldSession) -> None:
        delay = max(0, self._deadline(session) - self.options.clock())
        if self.asynchronous:
            loop = asyncio.get_running_loop()
            session.timer = loop.call_later(delay, lambda: loop.create_task(arun(self._expire(session))))
        else:
            timer = session.timer = threading.Timer(delay, lambda: run(self._expire(session)))
            timer.daemon = True
            timer.start()

    def _expire(self, session: HeldSession) -> Operation:
        with self._lock:
            if session.busy or self._sessions.get(session.id) is not session:
                return
            if self._deadline(session) > self.options.clock():
                if session.timer:
                    session.timer.cancel()
                self._schedule(session)
                return
            if session.timer:
                session.timer.cancel()
            session.busy = session.discard = True
        yield from self.release(session)

    @staticmethod
    def _owner(identity: Identity | None, base: str) -> tuple | None:
        return (base,) if identity is None else trace_owner(identity, base)

    def acquire(self, id: str, identity: Identity | None, base: str, origin_ok: bool) -> HeldSession:
        """Claim one request slot or raise the public protocol rejection."""
        with self._lock:
            session = self._sessions.get(id) if origin_ok else None
            if (session is None or session.discard or session.owner != self._owner(identity, base)
                    or (not session.busy and self._deadline(session) <= self.options.clock())):
                raise not_found()
            if session.busy:
                raise SessionError("session_busy", 409, "The Preview session is serving another request.")
            if session.timer:
                session.timer.cancel()
            session.busy = True
            return session

    def release(self, session: HeldSession) -> Operation:
        with self._lock:
            now = self.options.clock()
            if self._shutdown or session.discard or now >= session.created + self.lifetime:
                session.discard = True
            else:
                session.busy = False
                session.last_used = now
                self._schedule(session)
                return True
        clean = True
        interrupted = None
        try:
            for part in reversed(session.parts):
                try:
                    yield Call(part.close, async_call=lambda: part.ainvoke(part.close))
                except BaseException as error:
                    clean = False
                    if not isinstance(error, Exception) and interrupted is None:
                        interrupted = error
                    _logger.exception("A store could not close its Preview session.")
        finally:
            with self._lock:
                self._sessions.pop(session.id, None)
        if interrupted is not None:
            raise interrupted
        return clean

    def _open(self, owner: tuple, described: Iterable[dict[str, Any]]) -> Operation:
        if not self.supported(described):
            raise failed()
        with self._lock:
            expired = [s for s in self._sessions.values() if not s.busy and self._deadline(s) <= self.options.clock()]
        for old in expired:
            yield from self._expire(old)
        with self._lock:
            if self._shutdown:
                raise failed()
            if len(self._sessions) >= 16 or sum(s.owner == owner for s in self._sessions.values()) >= 4:
                raise SessionError("session_limit", 429, "Too many Preview sessions are open. End one first.")
            now = self.options.clock()
            session = HeldSession(secrets.token_hex(16), owner, now, now)
            self._sessions[session.id] = session
        try:
            for source in (self.provider, *self.stores):
                if source.supports_held(self.asynchronous):
                    part = yield Call(source.hold, async_call=source.ahold)
                    if part is not None:
                        session.parts.append(part)
        except BaseException as error:
            session.discard = True
            yield from self.release(session)
            if isinstance(error, StoreBusy):
                raise SessionError(
                    "store_busy", 409, f"Another transaction is holding {error}.",
                    detail=f"A Preview session ends after its idle timeout ({self.idle} seconds), or when it is ended.",
                    idleTimeoutSeconds=self.idle,
                ) from error
            if not isinstance(error, Exception):
                raise
            _logger.warning("A store could not open a Preview session.", exc_info=error)
            raise failed() from error
        yield from self.release(session)
        if session.discard:
            raise failed()
        return json_response(
            {"id": session.id, "idleTimeoutSeconds": self.idle, "maxLifetimeSeconds": self.lifetime}, 201,
        )

    def route(self, path: str, method: str, identity: Identity | None, base: str, authorized: bool,
              origin_ok: bool, describe: Call, read: Call) -> Operation:
        """Serve the session collection, rewind and delete endpoints."""
        opening = path == PATH
        resource = path[len(PATH) + 1:]
        id, slash, action = resource.partition("/")
        if not opening and (not id or (slash and action != "rewind")):
            return not_found().response
        allowed = "POST" if opening or slash else "DELETE"
        if method != allowed:
            return Response(405, [("allow", allowed), ("cache-control", "no-store")])
        if not origin_ok and not opening:
            return not_found().response
        if not authorized or not origin_ok:
            return problem_response(403 if identity or not origin_ok else 401, "Access to the workbench is denied.")
        try:
            if opening:
                owner = self._owner(identity, base)
                if owner is None:
                    return problem_response(403, "A Preview session needs one stable subject for the signed-in caller.")
                described = yield describe
                return (yield from self._open(owner, described))

            session = self.acquire(id, identity, base, origin_ok)
            try:
                if not slash:
                    session.discard = True
                else:
                    try:
                        payload = yield read
                        step = json.loads(payload)["step"] if len(payload) <= 4096 else None
                    except (ValueError, KeyError, TypeError):
                        step = None
                    if type(step) is not int or not 1 <= step <= session.step:
                        return problem_response(400, f"Rewind to a step from 1 through {session.step}.")
                    if step < session.step:
                        try:
                            yield from session.apply("rewind", step, reverse=True)
                        except BaseException:
                            session.discard = True
                            raise
                        session.step = step
            finally:
                clean = yield from self.release(session)
            if clean:
                return Response(204, [("cache-control", "no-store")])
            return problem_response(500, "The Preview session could not be rolled back cleanly.")
        except (SessionError, StoreEnded) as error:
            return error.response if isinstance(error, SessionError) else failed().response
        except Exception:
            _logger.exception("The Preview session could not rewind.")
            return problem_response(500, "The Preview session could not be rewound and was closed.")

    def shutdown(self) -> Operation:
        with self._lock:
            self._shutdown = True
            idle = [s for s in self._sessions.values() if not s.busy]
            for session in idle:
                session.busy = session.discard = True
                if session.timer:
                    session.timer.cancel()
        for session in idle:
            yield from self.release(session)

    def close(self) -> None:
        run(self.shutdown())


_wsgi_registries: weakref.WeakSet[SessionRegistry] = weakref.WeakSet()


@atexit.register
def _close_wsgi_registries() -> None:
    for registry in tuple(_wsgi_registries):
        registry.close()

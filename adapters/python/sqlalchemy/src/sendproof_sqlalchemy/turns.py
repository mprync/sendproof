"""Turns that keep MySQL previews from running at the same time.

InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the
same key and the first one rolls back, as every preview does, the waiters each hold that shared lock and
each need the exclusive one, so InnoDB aborts all but one with a deadlock (error 1213). Sent for real,
the first insert commits and the others get a duplicate-key error instead. No isolation level avoids it.

A preview therefore takes its engine's turn before it checks out a MySQL or MariaDB connection, and
hands it back once that connection's transaction has ended, as SQLite previews already queue behind
``BEGIN IMMEDIATE``. Engines of other dialects take no turn.
"""

from __future__ import annotations

import asyncio
import threading
import weakref
from collections.abc import Callable
from typing import Any

#: Dialects whose previews take turns.
SERIAL_DIALECTS = frozenset({"mysql", "mariadb"})

#: How long an async preview sleeps between attempts to take its turn, in seconds.
_ASYNC_POLL_SECONDS = 0.005

_turns: weakref.WeakKeyDictionary[Any, threading.Lock] = weakref.WeakKeyDictionary()
_turns_guard = threading.Lock()


def take_turn(engine: Any, *, nowait: bool = False) -> Callable[[], None] | None:
    """Wait for ``engine``'s preview turn and answer the callable that hands it back.

    Answers ``None`` for dialects whose previews run at the same time. An async engine runs this inside
    SQLAlchemy's greenlet on the event loop, where blocking would stall the preview that holds the turn,
    so it awaits between attempts instead of blocking.
    """
    if engine.dialect.name not in SERIAL_DIALECTS:
        return None
    with _turns_guard:
        lock = _turns.get(engine)
        if lock is None:
            lock = _turns[engine] = threading.Lock()
    if nowait:
        if not lock.acquire(blocking=False):
            from sendproof_core.sessions import StoreBusy

            raise StoreBusy(engine.dialect.name)
        return lock.release
    if getattr(engine.dialect, "is_async", False):
        from sqlalchemy.util import await_only

        while not lock.acquire(blocking=False):
            await_only(asyncio.sleep(_ASYNC_POLL_SECONDS))
    else:
        lock.acquire()
    return lock.release

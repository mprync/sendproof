"""Owner-scoped, short-lived storage for observed send traces."""

from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

PER_OWNER_LIMIT = 8
TOTAL_LIMIT = 32
DEFAULT_WAIT_SECONDS = 5.0

Owner = tuple[str, str, str]  # (authentication type, subject, path base)


@dataclass
class Reservation:
    """A trace slot created before the response starts and completed after the handler."""

    id: str
    owner: Owner
    start: float
    _done: threading.Event = field(default_factory=threading.Event, repr=False)
    _result: dict[str, Any] | None = field(default=None, repr=False)


class TraceStore:
    """Keeps up to 8 traces per owner and 32 per host for ``ttl`` seconds."""

    def __init__(self, ttl: float = 300.0, clock: Callable[[], float] | None = None) -> None:
        import time

        self._ttl = ttl
        self._clock = clock or time.monotonic
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, Reservation] = OrderedDict()

    def reserve(self, owner: Owner) -> Reservation:
        """Create a reservation, evicting the oldest entries when over the limits."""
        with self._lock:
            self._expire()
            mine = [entry for entry in self._entries.values() if entry.owner == owner]
            if len(mine) >= PER_OWNER_LIMIT:
                self._remove(mine[0])
            if len(self._entries) >= TOTAL_LIMIT:
                self._remove(next(iter(self._entries.values())))
            entry = Reservation(uuid.uuid4().hex, owner, self._clock())
            self._entries[entry.id] = entry
            return entry

    def complete(self, reservation: Reservation, trace: dict[str, Any] | None) -> None:
        """Publish the trace. ``None`` discards the reservation."""
        with self._lock:
            if self._entries.get(reservation.id) is reservation:
                if trace is None:
                    self._remove(reservation)
                    return
            reservation._result = trace
        reservation._done.set()

    def discard(self, reservation: Reservation) -> None:
        """Drop a reservation whose request did not complete."""
        with self._lock:
            self._remove(reservation)

    def read(self, trace_id: str, owner: Owner, timeout: float = DEFAULT_WAIT_SECONDS) -> dict[str, Any] | None:
        """Return the trace owned by ``owner`` or ``None``. Blocks until completion or timeout."""
        try:
            key = uuid.UUID(trace_id).hex
        except ValueError:
            return None
        with self._lock:
            self._expire()
            entry = self._entries.get(key)
            if entry is None or entry.owner != owner:
                return None
        if not entry._done.wait(timeout):
            return None
        return entry._result

    def _expire(self) -> None:
        now = self._clock()
        for entry in list(self._entries.values()):
            if now - entry.start >= self._ttl:
                self._remove(entry)

    def _remove(self, entry: Reservation) -> None:
        self._entries.pop(entry.id, None)
        entry._done.set()

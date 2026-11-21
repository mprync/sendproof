"""Identity of the caller as established by the host application."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Identity:
    """An authenticated caller.

    ``subject`` is a stable identifier issued by the host. Observed-send traces are owned by
    ``(authentication_type, subject)``, so callers without a subject cannot read traces.
    """

    name: str | None
    role: str | None = None
    subject: str | None = None
    authentication_type: str = "session"

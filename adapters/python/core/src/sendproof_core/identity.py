"""Identity of the caller as established by the host application."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Identity:
    """An authenticated caller.

    ``subject`` is a stable identifier issued by the host. Observed-send traces are owned by
    ``(authentication_type, issuer, subject)``, so callers without a subject cannot read traces.
    Set ``issuer`` when subjects come from more than one identity provider (for example the
    ``iss`` claim of a token), so equal subjects from different issuers stay separate.
    """

    name: str | None
    role: str | None = None
    subject: str | None = None
    authentication_type: str = "session"
    issuer: str | None = None

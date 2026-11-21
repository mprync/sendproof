"""Application-facing API for recording effects and logs during previews.

Call these at the boundary where the application would deliver an email, publish a message,
call another service or schedule a job. Each returns ``True`` when the delivery must be
skipped because the request is a rollback preview::

    if not sendproof_core.record_email("Welcome", sender, [to], [], subject, text):
        mailer.send(...)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from .scope import current_scope


def is_previewing() -> bool:
    """Whether the running request is a rollback-only preview."""
    scope = current_scope()
    return scope is not None and scope.rollback


def record_effect(kind: str, description: str, data: Any = None) -> bool:
    """Record an effect. Returns ``True`` if the caller must suppress its delivery."""
    scope = current_scope()
    return False if scope is None else scope.capture.record_effect(kind, description, data)


def record_email(
    description: str,
    sender: str,
    to: Iterable[str],
    cc: Iterable[str],
    subject: str,
    text: str,
    html: str | None = None,
) -> bool:
    """Record an email. Returns ``True`` if delivery must be suppressed."""
    return record_effect(
        "email",
        description,
        {"from": sender, "to": list(to), "cc": list(cc), "subject": subject, "text": text, "html": html},
    )


def record_http(description: str, method: str, url: str, status: int | None = None, body: Any = None) -> bool:
    """Record an outgoing HTTP call. Returns ``True`` if the call must be suppressed."""
    return record_effect("http", description, {"method": method, "url": url, "status": status, "body": body})


def record_job(
    description: str,
    name: str,
    arguments: Any = None,
    queue: str | None = None,
    run_at: datetime | None = None,
) -> bool:
    """Record a background job. Returns ``True`` if scheduling must be suppressed."""
    return record_effect(
        "job",
        description,
        {"name": name, "arguments": arguments, "queue": queue, "runAt": run_at.isoformat() if run_at else None},
    )


def record_message(description: str, topic: str, payload: Any = None, key: str | None = None) -> bool:
    """Record a published message. Returns ``True`` if publishing must be suppressed."""
    return record_effect("message", description, {"topic": topic, "payload": payload, "key": key})


def record_log(level: str, message: str) -> bool:
    """Record a log line directly. Returns whether a capture is active."""
    scope = current_scope()
    if scope is None:
        return False
    scope.capture.record_log(level, message)
    return True

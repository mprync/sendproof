"""Decides which SQL text and parameter names look like secrets.

Words are split at punctuation, underscores and camel-case boundaries. ``key`` alone is ordinary
(primary key, idempotency key) and counts only after qualifiers such as ``api`` or ``private``.
Session identifiers and payloads (``session_key``, ``session_data``, ``session_id``) are bearer
credentials, so they count as secrets too: a statement on Django's ``django_session`` table or a
Flask-Session table names them and has all of its values redacted.
"""

from __future__ import annotations

import re

REDACTED = "[REDACTED]"

_SECRET_WORDS = frozenset(
    {"password", "passwd", "pwd", "secret", "token", "hash", "salt", "credential", "credentials", "apikey"}
)
_KEY_QUALIFIERS = frozenset({"api", "private", "secret", "access", "signing", "encryption", "client"})
_SESSION_PARTS = frozenset({"key", "data", "id", "token"})
_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")


def looks_secret(text: str) -> bool:
    """Whether an identifier or statement names a secret, judged by whole words."""
    previous: str | None = None
    for match in _WORD.finditer(text):
        word = match.group(0).lower()
        if word in _SECRET_WORDS or (word == "key" and previous in _KEY_QUALIFIERS):
            return True
        if previous == "session" and word in _SESSION_PARTS:
            return True
        previous = word
    return False


def redact_deep(value: object) -> object:
    """Replace the value of every secret-named field, at any depth of a nested document.

    A secret-named field (``password_hash``, ``apiKey``) keeps its place but shows
    :data:`REDACTED`, even when its value is itself a document or a list. ``None`` is left as it
    is, so an absent secret stays distinguishable.
    """
    if isinstance(value, dict):
        return {
            name: (REDACTED if looks_secret(str(name)) and inner is not None else redact_deep(inner))
            for name, inner in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_deep(item) for item in value]
    return value


def python_type_name(value: object) -> str:
    """A database-neutral type label for a bound Python value."""
    return {str: "String", int: "Int64", float: "Double", bool: "Boolean", bytes: "Binary"}.get(
        type(value), type(value).__name__
    )


def describe_parameters(
    statement: str, named: "list[tuple[str, object, str]]", show_values: bool
) -> "tuple[list[tuple[str, str | None, str]], bool]":
    """Stringify and redact bound parameters for the log.

    ``named`` holds ``(name, value, type label)``. Values show only when ``show_values`` is true,
    a parameter named like a secret always shows :data:`REDACTED`, and a statement that mentions
    a secret word hides every value in it. Returns the entries and whether anything was clipped.
    """
    from . import limits

    redact_all = show_values and looks_secret(statement)
    result: list[tuple[str, str | None, str]] = []
    truncated = len(named) > limits.PARAMETERS
    for name, value, kind in named[: limits.PARAMETERS]:
        if not show_values or redact_all or looks_secret(name):
            result.append((name, REDACTED, kind))
        elif value is None:
            result.append((name, None, kind))
        elif isinstance(value, (bytes, bytearray, memoryview)):
            raw = bytes(value)
            result.append((name, raw[: limits.TEXT // 2].hex(), kind))
            truncated |= len(raw) > limits.TEXT // 2
        else:
            text = str(value)
            result.append((name, limits.clip(text), kind))
            truncated |= len(text) > limits.TEXT
    return result, truncated

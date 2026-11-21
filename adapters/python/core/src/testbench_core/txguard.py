"""Recognises SQL that would end, or escape, the transaction a rollback preview runs in.

A preview keeps every write inside one transaction that is rolled back at the end. Application
SQL that commits that transaction (``COMMIT``, ``END``, ``SET autocommit = 1``) or that the
database commits implicitly (DDL on MySQL, MariaDB and Oracle) would make earlier writes durable
before the rollback runs. Providers call :func:`escapes_transaction` before such a statement
executes and refuse it, so a preview fails closed instead of committing.

Savepoint statements (``SAVEPOINT``, ``RELEASE SAVEPOINT``, ``ROLLBACK TO SAVEPOINT``) stay
allowed because nested transactions use them; a provider that relies on a named savepoint of its
own passes that name as ``reserved`` so the application cannot release or reuse it.
"""

from __future__ import annotations

import re

# String literals, quoted identifiers, dollar-quoted bodies and comments, so that a ";" or a
# keyword inside them is never mistaken for the start of a statement.
_OPAQUE = re.compile(
    r"'(?:[^'\\]|\\.|'')*'|\"(?:[^\"]|\"\")*\"|`[^`]*`|\$([A-Za-z_][A-Za-z0-9_]*|)\$.*?\$\1\$"
    r"|/\*.*?\*/|--[^\n]*",
    re.DOTALL,
)
_HASH_COMMENT = re.compile(r"#[^\n]*")  # MySQL and MariaDB only; "#" is an operator elsewhere
_WORDS = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*|=|\S")

# Leading keywords that end the current transaction on every supported database.
_ENDS_TRANSACTION = frozenset({"commit", "end", "abort", "begin", "start", "xa"})
# Statements that MySQL, MariaDB and Oracle commit implicitly before running.
_IMPLICIT_COMMIT = frozenset({
    "alter", "analyze", "audit", "comment", "create", "drop", "flashback", "flush", "grant",
    "install", "lock", "noaudit", "optimize", "purge", "rename", "repair", "reset", "revoke",
    "truncate", "uninstall", "unlock",
})
_IMPLICIT_COMMIT_DIALECTS = frozenset({"mysql", "mariadb", "oracle"})


def _statements(sql: str, dialect: str) -> list[list[str]]:
    """Lower-cased leading words of each ``;``-separated statement.

    Literals and comments are blanked first. An unterminated literal is left as it is, which can
    only make the check stricter.
    """
    result = []
    text = _OPAQUE.sub(lambda m: " " if m.group(0)[:1] in "/-" else " '' ", sql)
    if dialect in ("mysql", "mariadb"):
        text = _HASH_COMMENT.sub(" ", text)
    for part in text.split(";"):
        words = [w.lower() for w in _WORDS.findall(part)[:8]]
        if words:
            result.append(words)
    return result


def escapes_transaction(sql: str, dialect: str, reserved: str | None = None) -> str | None:
    """Return why ``sql`` would end the preview transaction, or ``None`` when it is safe.

    Args:
        sql: The statement text the application is about to execute.
        dialect: The database dialect name (``sqlite``, ``postgresql``, ``mysql``...).
        reserved: A savepoint name the provider owns and the application must not touch.
    """
    dialect = dialect.lower()
    reserved_name = reserved.lower() if reserved else None
    for words in _statements(sql, dialect):
        if dialect == "oracle":
            # Look inside "BEGIN COMMIT; END;" style PL/SQL blocks at the first real statement.
            while words and words[0] in ("begin", "declare", "end"):
                words = words[1:]
            if not words:
                continue
        first = words[0]
        if first in _ENDS_TRANSACTION:
            return f"'{first.upper()}' would end the preview transaction."
        if first == "prepare" and words[1:2] == ["transaction"]:
            return "'PREPARE TRANSACTION' would end the preview transaction."
        if first == "rollback" and "to" not in words[1:3]:
            return "'ROLLBACK' would end the preview transaction."
        if first == "set" and "autocommit" in words[1:4]:
            return "Switching autocommit on would commit the preview transaction."
        if first == "set" and words[1:3] == ["session", "characteristics"]:
            continue
        if reserved_name and first in ("release", "savepoint", "rollback") and reserved_name in words:
            return "The preview savepoint is reserved for Test Bench."
        if dialect in _IMPLICIT_COMMIT_DIALECTS and first in _IMPLICIT_COMMIT:
            if words[1:2] == ["temporary"]:
                continue  # CREATE/DROP TEMPORARY TABLE do not commit on MySQL
            return f"'{first.upper()}' commits implicitly on {dialect} and cannot be previewed."
    return None


__all__ = ["escapes_transaction"]

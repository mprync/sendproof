"""Recognises SQL that would end, or escape, the transaction a rollback preview runs in.

A preview keeps every write inside one transaction that is rolled back at the end. Application
SQL that commits that transaction (``COMMIT``, ``END``, ``SET autocommit = 1``) or that the
database commits implicitly (DDL on MySQL, MariaDB and Oracle) would make earlier writes durable
before the rollback runs. Providers call :func:`escapes_transaction` before such a statement
executes and refuse it, so a preview fails closed instead of committing.

On MySQL and MariaDB ``CALL`` is refused too, because a stored procedure can commit, unless the
host declared that procedure safe by exact name (``safe_procedures``). SQL-level ``EXECUTE`` runs a
statement prepared from text the guard never saw, so it is refused there as well. Executable
comments (``/*! ... */``, ``/*M! ... */``) are read as the SQL they contain, because the server
runs them.

Savepoint statements (``SAVEPOINT``, ``RELEASE SAVEPOINT``, ``ROLLBACK TO SAVEPOINT``) stay
allowed because nested transactions use them; a provider that relies on a named savepoint of its
own passes that name as ``reserved`` so the application cannot release or reuse it.

Literals and comments are recognised the way each server reads them with its default settings:
backslash escapes inside MySQL strings, ``--`` followed by a space and ``#`` comments on MySQL,
dollar-quoted bodies and ``E'...'`` strings on PostgreSQL, and plain doubled quotes elsewhere. A
literal the guard ends too late could hide a statement the server runs, so these differ per
dialect.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

_MYSQL = frozenset({"mysql", "mariadb"})

# String literals, quoted identifiers, dollar-quoted bodies and comments, so that a ";" or a
# keyword inside them is never mistaken for the start of a statement. One pass, left to right,
# so a quote inside a comment (or a comment marker inside a literal) never starts anything.
_OPAQUE_MYSQL = re.compile(
    r"'(?:[^'\\]|\\.|'')*'"          # string with backslash escapes
    r'|"(?:[^"\\]|\\.|"")*"'         # double-quoted string (or ANSI_QUOTES identifier)
    r"|`(?:[^`]|``)*`"               # quoted identifier
    r"|/\*.*?\*/"                    # block comment, executable or not (see _comment)
    r"|--(?=\s|$)[^\n]*"             # "-- " comment; "--1" is arithmetic on MySQL
    r"|#[^\n]*",                     # hash comment
    re.DOTALL,
)
_OPAQUE_POSTGRESQL = re.compile(
    r"(?<![A-Za-z0-9_])[Ee]'(?:[^'\\]|\\.|'')*'"   # E'...' escape string
    r"|'(?:[^']|'')*'"                              # standard string: no backslash escapes
    r'|"(?:[^"]|"")*"'
    r"|\$(?P<tag>[A-Za-z_][A-Za-z0-9_]*|)\$.*?\$(?P=tag)\$"
    r"|/\*.*?\*/|--[^\n]*",
    re.DOTALL,
)
_OPAQUE_STANDARD = re.compile(
    r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|\[[^\]]*\]|/\*.*?\*/|--[^\n]*",
    re.DOTALL,
)
# The body of a MySQL or MariaDB executable comment: "/*!", "/*M!", an optional version, the SQL.
_EXECUTABLE = re.compile(r"/\*M?!(?:\d{5,6})?(.*)\*/\Z", re.DOTALL)
_PLAIN_IDENTIFIER = re.compile(r"[A-Za-z0-9_$]+\Z")
_WORDS = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*|=|\S")
_NAME = re.compile(r"[a-z_][a-z0-9_$]*")

# Leading keywords that end the current transaction on every supported database.
_ENDS_TRANSACTION = frozenset({"commit", "end", "abort", "begin", "start", "xa"})
# Statements that MySQL, MariaDB and Oracle commit implicitly before running.
_IMPLICIT_COMMIT = frozenset({
    "alter", "analyze", "audit", "comment", "create", "drop", "flashback", "flush", "grant",
    "install", "lock", "noaudit", "optimize", "purge", "rename", "repair", "reset", "revoke",
    "truncate", "uninstall", "unlock",
})
# The rest of MySQL's implicit-commit list: CACHE INDEX, CHANGE REPLICATION SOURCE / MASTER,
# CHECK TABLE, CLONE, IMPORT TABLE, STOP REPLICA / SLAVE / GROUP_REPLICATION.
_IMPLICIT_COMMIT_MYSQL = _IMPLICIT_COMMIT | {"cache", "change", "check", "clone", "import", "stop"}
_IMPLICIT_COMMIT_DIALECTS = frozenset({"mysql", "mariadb", "oracle"})


def _opaque(dialect: str) -> re.Pattern[str]:
    if dialect in _MYSQL:
        return _OPAQUE_MYSQL
    if dialect == "postgresql":
        return _OPAQUE_POSTGRESQL
    return _OPAQUE_STANDARD


def _blank(text: str, dialect: str) -> str:
    """Replace literals and comments with neutral tokens, keeping what the server would run.

    A MySQL executable comment becomes its body, blanked the same way. A backticked identifier
    becomes its name when that is a plain name (so ``CALL `proc`()`` matches a declared ``proc``),
    and an opaque token otherwise.
    """

    def replace(match: re.Match[str]) -> str:
        token = match.group(0)
        if dialect in _MYSQL:
            executable = _EXECUTABLE.match(token)
            if executable:
                return " " + _blank(executable.group(1), dialect) + " "
            if token[:1] == "`":
                name = token[1:-1]
                return f" {name} " if _PLAIN_IDENTIFIER.match(name) else " '' "
            if token[:1] == "#":
                return " "
        return " " if token[:2] in ("/*", "--") else " '' "

    return _opaque(dialect).sub(replace, text)


def _statements(sql: str, dialect: str) -> list[list[str]]:
    """Lower-cased words of each ``;``-separated statement.

    Literals and comments are blanked first. An unterminated literal is left as it is, which can
    only make the check stricter.
    """
    result = []
    for part in _blank(sql, dialect).split(";"):
        words = [w.lower() for w in _WORDS.findall(part)]
        if words:
            result.append(words)
    return result


def _procedure(words: list[str]) -> str:
    """The name a ``CALL`` names, qualified as written (``shop.refresh_totals``)."""
    name, index = [], 1
    while index < len(words) and _NAME.fullmatch(words[index]):
        name.append(words[index])
        if words[index + 1:index + 2] != ["."]:
            break
        name.append(".")
        index += 2
    return "".join(name)


def normalize_procedures(names: Iterable[str] | None) -> frozenset[str]:
    """Check and lower-case the host's declared safe procedures.

    MySQL and MariaDB procedure names are case-insensitive, so ``Refresh_Totals`` and
    ``refresh_totals`` are one procedure. Each entry must be an exact name, optionally qualified
    with its schema; wildcards and quoting are rejected rather than guessed at.
    """
    result = set()
    for name in names or ():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?", name):
            raise ValueError(f"A safe procedure must be an exact name such as 'refresh_totals', not {name!r}.")
        result.add(name.lower())
    return frozenset(result)


def escapes_transaction(sql: str, dialect: str, reserved: str | None = None,
                        safe_procedures: frozenset[str] = frozenset()) -> str | None:
    """Return why ``sql`` would end the preview transaction, or ``None`` when it is safe.

    Args:
        sql: The statement text the application is about to execute.
        dialect: The database dialect name (``sqlite``, ``postgresql``, ``mysql``...).
        reserved: A savepoint name the provider owns and the application must not touch.
        safe_procedures: Lower-cased procedure names the host declared never commit (see
            :func:`normalize_procedures`); ``CALL`` of any other procedure is refused on MySQL
            and MariaDB.
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
        if first == "set" and "autocommit" in words[1:]:
            return "Switching autocommit on would commit the preview transaction."
        if first == "set" and words[1:3] == ["session", "characteristics"]:
            continue
        if reserved_name and first in ("release", "savepoint", "rollback") and reserved_name in words:
            return "The preview savepoint is reserved for Sendproof."
        if dialect in _MYSQL:
            if first == "call":
                if _procedure(words) in safe_procedures:
                    continue
                return ("'CALL' can commit the preview transaction inside the procedure; declare the "
                        "procedure safe by exact name if it never commits.")
            if first == "execute":
                return "'EXECUTE' runs a prepared statement the preview cannot check, so it cannot be previewed."
            if first == "load" and words[1:2] == ["index"]:
                return "'LOAD INDEX INTO CACHE' commits implicitly and cannot be previewed."
            if first == "set" and (words[1:2] == ["password"] or words[1:3] == ["default", "role"]):
                return f"'SET {words[1].upper()}' commits implicitly on {dialect} and cannot be previewed."
        implicit = _IMPLICIT_COMMIT_MYSQL if dialect in _MYSQL else _IMPLICIT_COMMIT
        if dialect in _IMPLICIT_COMMIT_DIALECTS and first in implicit:
            if words[1:2] == ["temporary"]:
                continue  # CREATE/DROP TEMPORARY TABLE do not commit on MySQL
            return f"'{first.upper()}' commits implicitly on {dialect} and cannot be previewed."
    return None


__all__ = ["escapes_transaction", "normalize_procedures"]

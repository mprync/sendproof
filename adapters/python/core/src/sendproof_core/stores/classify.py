"""Write classification for the batch-one data stores, driven by the shared tables.

Each table of ``spec/data-stores/`` (embedded in :mod:`.tables`) lists reads and connection-level
commands. **Everything else, including a command the table has never heard of, is a write**, so
the guard fails closed when a store adds a command.

Every function here is pure. The shared vectors in
``spec/data-stores/classification-cases.json`` run through them in ``core/tests/test_stores.py``.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

from .tables import DYNAMODB_TABLE, MONGODB_TABLE, REDIS_TABLE

#: How the guard treats one store command. Only ``"write"`` can block a Preview.
READ, WRITE, SESSION, TRANSACTION = "read", "write", "session", "transaction"

_REDIS_READ = frozenset(REDIS_TABLE["read"]) | frozenset(REDIS_TABLE["moduleRead"])
_REDIS_SESSION = frozenset(REDIS_TABLE["session"])
_REDIS_TRANSACTION = frozenset(REDIS_TABLE["transaction"])

_MONGO_READ = frozenset(name.lower() for name in MONGODB_TABLE["read"])
_MONGO_SESSION = frozenset(name.lower() for name in MONGODB_TABLE["session"])
_MONGO_NOT_IN_TRANSACTION = frozenset(name.lower() for name in MONGODB_TABLE["notInTransaction"]["commands"])
_MONGO_STAGES: tuple[str, ...] = tuple(MONGODB_TABLE["notInTransaction"]["stages"])
_WRITING_STAGES = frozenset({"$out", "$merge"})

_DYNAMO_READ = frozenset(DYNAMODB_TABLE["read"])
_DYNAMO_PARTIQL = frozenset(DYNAMODB_TABLE["partiql"]["operations"])


def _text(value: Any) -> str:
    """An argument as text: bytes are decoded, everything else is stringified."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", errors="replace")
    return str(value)


def classify_redis(name: Any, args: Iterable[Any] = (), treat_as_read: Optional[frozenset[str]] = None) -> str:
    """Classify a Redis command as ``read``, ``write``, ``session`` or ``transaction``.

    ``name`` is the command name in any case and ``args`` its arguments, of which only the first
    is read, to form ``CONTAINER|SUBCOMMAND`` keys such as ``OBJECT|ENCODING``. ``treat_as_read``
    holds host-declared reads, compared exactly against the upper-case key.

    redis-py accepts a container command either as two arguments (``"OBJECT", "ENCODING"``) or as
    one space-separated name (``"CONFIG GET"``); both forms classify the same.
    """
    command = _text(name).strip().upper()
    arguments = list(args)
    if " " in command:  # "CONFIG GET" -> CONFIG with GET as its first argument
        command, _, rest = command.partition(" ")
        arguments.insert(0, rest.strip())
    with_sub = f"{command}|{_text(arguments[0]).upper()}" if arguments else command
    for key in (with_sub, command):
        if key in _REDIS_SESSION:
            return SESSION
        if key in _REDIS_TRANSACTION:
            return TRANSACTION
        if key in _REDIS_READ or (treat_as_read is not None and key in treat_as_read):
            return READ
    return WRITE


def _is_plain(value: Any) -> bool:
    """A plain mapping literal, as opposed to BSON values and class instances."""
    return isinstance(value, Mapping)


def pipeline_uses(value: Any, stages: frozenset[str]) -> bool:
    """Whether any key of an aggregation pipeline, at any depth (sub-pipelines included), is in ``stages``."""
    if isinstance(value, (list, tuple)):
        return any(pipeline_uses(item, stages) for item in value)
    if _is_plain(value):
        return any(key in stages or pipeline_uses(inner, stages) for key, inner in value.items())
    return False


def classify_mongo(command: Mapping[str, Any], treat_as_read: Optional[frozenset[str]] = None) -> tuple[str, Optional[str]]:
    """Classify a MongoDB command document by its first key, case-insensitively.

    Returns ``(kind, refused_in_transaction)``. ``aggregate`` is a write when any stage at any
    depth is ``$out`` or ``$merge``; ``explain`` takes the classification of the command inside
    it. ``refused_in_transaction`` names the command or stage MongoDB refuses inside a
    transaction (``$out``, ``count``...), which a ``preview``-mode Preview must block before
    sending. ``treat_as_read`` holds host-declared reads in lower case.
    """
    name = next(iter(command), "")
    lower = str(name).lower()
    if lower == "explain" and _is_plain(command[name]):
        return classify_mongo(command[name], treat_as_read)
    refused: Optional[str] = None
    if lower in _MONGO_NOT_IN_TRANSACTION:
        refused = str(name)
    if lower == "aggregate":
        pipeline = command.get("pipeline")
        refused = next((stage for stage in _MONGO_STAGES if pipeline_uses(pipeline, frozenset({stage}))), refused)
    if lower in _MONGO_SESSION:
        return SESSION, None
    if lower == "aggregate" and pipeline_uses(command.get("pipeline"), _WRITING_STAGES):
        return WRITE, refused
    if lower in _MONGO_READ or (treat_as_read is not None and lower in treat_as_read):
        return READ, refused
    return WRITE, refused


def partiql_verb(statement: Any) -> str:
    """Skip whitespace and SQL-style comments, then return the first word of a PartiQL statement in upper case."""
    text = "" if statement is None else str(statement)
    while True:
        trimmed = text.lstrip()
        if trimmed.startswith("--"):
            end = trimmed.find("\n")
            text = "" if end < 0 else trimmed[end + 1:]
            continue
        if trimmed.startswith("/*"):
            end = trimmed.find("*/")
            if end < 0:
                return ""
            text = trimmed[end + 2:]
            continue
        word = []
        for char in trimmed:
            if char.isascii() and char.isalpha():
                word.append(char)
            else:
                break
        return "".join(word).upper()


def classify_dynamo(operation: str, params: Optional[Mapping[str, Any]] = None,
                    treat_as_read: Optional[frozenset[str]] = None) -> str:
    """Classify a DynamoDB action and its input as ``read`` or ``write``.

    A PartiQL request is a read only when every statement in it is a ``SELECT``. ``treat_as_read``
    holds host-declared action names.
    """
    params = params or {}
    if operation in _DYNAMO_READ or (treat_as_read is not None and operation in treat_as_read):
        return READ
    if operation in _DYNAMO_PARTIQL:
        if operation == "ExecuteStatement":
            statements = [params.get("Statement")]
        else:
            listed = params.get("Statements") or params.get("TransactStatements")
            statements = [item.get("Statement") if isinstance(item, Mapping) else None for item in listed] \
                if isinstance(listed, (list, tuple)) else []
        if statements and all(partiql_verb(statement) == "SELECT" for statement in statements):
            return READ
        return WRITE
    return WRITE

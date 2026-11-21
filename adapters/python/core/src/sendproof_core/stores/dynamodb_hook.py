"""Sendproof write guard for DynamoDB (``spec/data-stores.md``, ``guard`` mode).

``dynamodb_store(target)`` registers botocore event handlers on a boto3 or aioboto3 session, a
botocore session, a client or a resource:

* ``before-parameter-build.dynamodb`` classifies the operation and its parameters and, in a
  Preview, refuses a write by raising :class:`~sendproof_core.stores.guard.PreviewWriteBlocked`.
  It runs before the request is serialized, signed or sent, so a refused operation never becomes
  an HTTP request, and credentials, the ``Authorization`` header and signatures never reach the hook.
* ``after-call.dynamodb`` and ``after-call-error.dynamodb`` log the operation as a ``Db`` entry.

The operation is the botocore operation model's name (``UpdateItem``). boto3 resources and tables,
PynamoDB and aioboto3 clients all call ``client._make_api_call``, so they all pass through the
handlers.

Registering on a **session** covers every client made from it *afterwards*; registering on a
**client** (or a resource, through its client) covers that client only. A client created from an
unhooked session, or inside a handler, is not covered.
"""

from __future__ import annotations

import re
import time
from typing import Any, Iterable, Mapping, Optional

from ..scope import current_scope
from .base import DataStore
from .classify import classify_dynamo
from .guard import guard, read_set, store_label

_UNIQUE_ID = "sendproof-dynamodb-guard"
_STARTED = "sendproof_started"
_EVENTS = ("before-parameter-build.dynamodb", "after-call.dynamodb", "after-call-error.dynamodb")


def sanitize_partiql(text: str) -> str:
    """Replace every literal in PartiQL text with ``?``.

    Single-quoted strings (with ``''`` escapes) and numbers are replaced; double-quoted
    identifiers (table and attribute names) are kept as written. A statement may inline values
    instead of using ``?`` parameters, and a value never appears in a ``Db`` entry.
    """
    out: list[str] = []
    index, length = 0, len(text)
    while index < length:
        char = text[index]
        if char == '"':
            end = text.find('"', index + 1)
            stop = length if end < 0 else end + 1
            out.append(text[index:stop])
            index = stop
        elif char == "'":
            end = index + 1
            while end < length and not (text[end] == "'" and text[end + 1:end + 2] != "'"):
                end += 2 if text[end] == "'" else 1
            out.append("?")
            index = end + 1
        elif char.isdigit() and not re.match(r"[\w.]", text[index - 1] if index else ""):
            number = re.match(r"[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", text[index:])
            out.append("?")
            index += number.end() if number else 1
        else:
            out.append(char)
            index += 1
    return "".join(out)


def _statement(params: Mapping[str, Any]) -> Optional[str]:
    """The PartiQL text of a request, with literals replaced by ``?``; other actions have no statement."""
    if isinstance(params.get("Statement"), str):
        return sanitize_partiql(params["Statement"])
    listed = params.get("Statements") or params.get("TransactStatements")
    if isinstance(listed, (list, tuple)):
        return "; ".join(sanitize_partiql(str(item.get("Statement", "")) if isinstance(item, Mapping) else "") for item in listed)
    return None


def _target(params: Mapping[str, Any], statement: Optional[str]) -> Optional[str]:
    """The table a command targets: ``TableName``, the first ``RequestItems`` table, a transaction item's table or the quoted PartiQL table."""
    if isinstance(params.get("TableName"), str):
        return params["TableName"]
    items = params.get("RequestItems")
    if isinstance(items, Mapping) and items:
        return str(next(iter(items)))
    transact = params.get("TransactItems")
    if isinstance(transact, (list, tuple)) and transact and isinstance(transact[0], Mapping):
        for body in transact[0].values():
            if isinstance(body, Mapping) and isinstance(body.get("TableName"), str):
                return body["TableName"]
    found = re.search(r'"([^"]+)"', statement) if statement else None
    return found.group(1) if found else None


def _rows(parsed: Any) -> Optional[int]:
    """Items matched, returned or written, when the reply says so."""
    if not isinstance(parsed, Mapping):
        return None
    if isinstance(parsed.get("Items"), list):
        return len(parsed["Items"])
    if isinstance(parsed.get("Count"), int):
        return parsed["Count"]
    return 1 if parsed.get("Item") or parsed.get("Attributes") else None


class DynamoDBStore(DataStore):
    """A hooked DynamoDB client or session, ready for ``data_stores``."""

    system = "dynamodb"

    def __init__(self, name: Optional[str], reads: Optional[frozenset[str]]) -> None:
        self.name = name
        self._reads = reads

    def describe(self) -> dict[str, Any]:
        return {"system": "dynamodb", **({"name": self.name} if self.name else {}), "mode": "guard"}

    # ------------------------------------------------------------- event handlers
    def before_parameter_build(self, params: Any = None, model: Any = None, context: Any = None, **_: Any) -> None:
        """Classify the operation before anything is built, signed or sent; refuse a write in a Preview."""
        operation = str(getattr(model, "name", "") or "")
        params = params if isinstance(params, Mapping) else {}
        guard("dynamodb", operation, classify_dynamo(operation, params, self._reads))
        if context is not None:
            statement = _statement(params)
            context[_STARTED] = (time.perf_counter(), operation, _target(params, statement), statement)

    def after_call(self, parsed: Any = None, context: Any = None, **_: Any) -> None:
        """Log the finished operation, with its error code when DynamoDB refused it."""
        error = parsed.get("Error", {}).get("Code") if isinstance(parsed, Mapping) and isinstance(parsed.get("Error"), Mapping) else None
        self._log(context, rows=None if error else _rows(parsed), error=error)

    def after_call_error(self, exception: Any = None, context: Any = None, **_: Any) -> None:
        """Log an operation that failed before DynamoDB answered (a connection error, for example)."""
        self._log(context, rows=None, error=type(exception).__name__ if exception is not None else "Error")

    @staticmethod
    def _log(context: Any, rows: Optional[int], error: Optional[str]) -> None:
        scope = current_scope()
        started = context.pop(_STARTED, None) if isinstance(context, dict) else None
        if scope is None or started is None:
            return
        began, operation, target, statement = started
        scope.capture.record_db(
            "dynamodb", operation, target=target, statement=statement, rows_affected=rows, error=error,
            elapsed_ms=(time.perf_counter() - began) * 1000,
        )

    def register(self, emitter: Any) -> None:
        """Add the handlers to a botocore event emitter or session. Hooking one twice is refused."""
        if _already_hooked(emitter):
            raise TypeError("This DynamoDB client or session is already hooked by dynamodb_store.")
        register = emitter.register
        register("before-parameter-build.dynamodb", self.before_parameter_build, unique_id=_UNIQUE_ID + "-guard")
        register("after-call.dynamodb", self.after_call, unique_id=_UNIQUE_ID + "-after")
        register("after-call-error.dynamodb", self.after_call_error, unique_id=_UNIQUE_ID + "-error")
        try:
            emitter._sendproof_dynamodb = True
        except AttributeError:  # an emitter without a __dict__ cannot be marked; the unique ids still prevent duplicates
            pass


def _already_hooked(emitter: Any) -> bool:
    """Whether the guard handlers are already registered on ``emitter``.

    botocore keeps registered ``unique_id`` values on the emitter, behind the event aliaser that
    clients wrap it in, and copies them into each client made from a hooked session, so this sees a
    session's hook from its clients. The flag set at registration is the fallback.
    """
    for candidate in (emitter, getattr(emitter, "_emitter", None)):
        registered = getattr(candidate, "_unique_id_handlers", None)
        if isinstance(registered, dict) and (_UNIQUE_ID + "-guard") in registered:
            return True
    return bool(getattr(emitter, "_sendproof_dynamodb", False))


def _emitter(target: Any) -> Any:
    """The object whose ``register`` adds botocore event handlers for ``target``."""
    meta = getattr(target, "meta", None)
    if meta is not None and hasattr(meta, "events"):  # a client
        return meta.events
    client = getattr(meta, "client", None)
    if client is not None and hasattr(client.meta, "events"):  # a boto3 resource or Table
        return client.meta.events
    for name in ("events", "_session"):  # a boto3 / aioboto3 session
        inner = getattr(target, name, None)
        if inner is not None and hasattr(inner, "register"):
            return inner
    if hasattr(target, "register"):  # a botocore or aiobotocore session, or an emitter
        return target
    raise TypeError("dynamodb_store takes a boto3 or aioboto3 session, a botocore session, a client or a resource.")


def dynamodb_store(
    target: Any, *, name: Optional[str] = None, treat_as_read: Optional[Iterable[str]] = None,
) -> DynamoDBStore:
    """Hook a boto3 or aioboto3 session, a botocore session, a client or a resource, and return the store.

    Hooking the same target twice is refused, so its operations are never logged twice.

    Args:
        target: ``boto3.Session()``, ``aioboto3.Session()``, ``botocore.session.Session()``, a
            DynamoDB client, or a resource or table. A session covers clients made from it
            afterwards; a client covers itself.
        name: A display label for discovery, such as ``orders``. Never an endpoint or ARN.
        treat_as_read: Action names you state never write, matched exactly.
            **The guard trusts this list**: a listed action that does write is not blocked.
    """
    store = DynamoDBStore(store_label(name), read_set(treat_as_read))
    store.register(_emitter(target))
    return store

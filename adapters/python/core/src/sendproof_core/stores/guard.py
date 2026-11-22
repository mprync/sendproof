"""The write guard of ``spec/data-stores.md``: the single decision point every store hook calls
before it sends a command, plus the helpers hooks share for logging and redaction.

Outside a Preview the guard does nothing, so Send and observed Send are never blocked. In a
Preview it records the first refused write on the request's :class:`~sendproof_core.capture.Capture`
and raises :class:`PreviewWriteBlocked`. **The capture's mark, not the handler's response, decides
the outcome**: a handler that catches the error and returns 200 still produces a 409.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Optional

from ..scope import RequestScope, attributed, current_scope, open_previews
from .classify import WRITE

#: Display names used in ``Preview unavailable: this operation writes to <Store>``.
STORE_NAMES = {
    "mongodb": "MongoDB", "redis": "Redis", "dynamodb": "DynamoDB",
    "cassandra": "Cassandra", "elasticsearch": "Elasticsearch", "opensearch": "OpenSearch",
    "cosmosdb": "Cosmos DB", "firestore": "Firestore",
}


def store_name(store: str) -> str:
    """The display name of a store id; unknown ids are shown as given."""
    return STORE_NAMES.get(store, store)


def write_reason(store: str) -> str:
    """The reason shown for a write to a guarded store."""
    return f"Preview unavailable: this operation writes to {store_name(store)}"


class PreviewWriteBlocked(Exception):
    """Raised to the handler when the guard refuses a write. No byte of the command reached the store."""

    def __init__(self, store: str, operation: str, detail: str) -> None:
        super().__init__(detail)
        #: Store id, such as ``redis``.
        self.store = store
        #: The refused command or action name.
        self.operation = operation
        self.detail = detail


class PreviewTransactionControl(Exception):
    """Raised when a handler tries to end or escape the Preview transaction.

    A raw SQL ``COMMIT``, a MongoDB ``commitTransaction`` or a command sent with a session other
    than the Preview's. The Preview answers 500 without confirmation even if the handler catches it.
    """


def current_preview() -> Optional[RequestScope]:
    """The scope of the Preview this code runs inside, even after the Preview finished.

    Store hooks use it so a write that a handler sends after its response settled is still
    refused, never sent unguarded. Returns ``None`` outside a Preview, including observed sends.
    """
    scope = current_scope()
    return scope if scope is not None and scope.rollback else None


def guard(store: str, operation: str, kind: str, detail: Optional[str] = None) -> None:
    """Call before sending a store command. Does nothing outside a Preview or for anything but a write.

    In a Preview it marks the capture blocked (the first block wins), logs a blocked ``Db`` entry
    and raises :class:`PreviewWriteBlocked`. ``detail`` replaces the default "writes to <Store>"
    reason, for example for a MongoDB command that cannot run inside a transaction.
    """
    if kind != WRITE:
        return
    scope = current_preview()
    if scope is None:
        return
    reason = detail or write_reason(store)
    scope.capture.block(store, operation, reason)
    scope.capture.record_db(store, operation, blocked=True)
    raise PreviewWriteBlocked(store, operation, reason)


def unattributed_write(store: str, operation: str) -> None:
    """A write that no request and no :func:`~sendproof_core.detached` block accounts for.

    Call it for a write seen with no current scope. While any Preview is open, such a write may
    come from a Preview handler's own thread, started without its context: it was neither blocked
    nor rolled back, so every open Preview fails with 500 rather than claim a rollback. With no
    Preview open, or inside an ordinary request or a ``detached()`` block, it does nothing.
    """
    if attributed():
        return
    previews = open_previews()
    if not previews:
        return
    for scope in previews:
        scope.capture.refuse(PreviewTransactionControl(
            f"A {store_name(store)} {operation} ran outside any request while this Preview was open, so it may "
            "have come from the Preview's own thread; the Preview can't be confirmed. Wrap background work "
            "in sendproof_core.detached()."))


def check_command(store: str, operation: str, kind: str) -> Optional[RequestScope]:
    """The one call a guard-only hook makes before it sends a command.

    Refuses a write in a Preview (:func:`guard`), fails every open Preview when a write has no
    request attribution (:func:`unattributed_write`), and returns the scope the command's ``Db``
    entry belongs to (``None`` outside any request).
    """
    guard(store, operation, kind)
    scope = current_scope()
    if kind == WRITE and scope is None:
        unattributed_write(store, operation)
    return scope


def refuse_in_preview(message: str) -> Optional[PreviewTransactionControl]:
    """Refuse something that would end or escape the Preview transaction.

    Records the fault on the current Preview, so the Preview fails with 500 even if the handler
    catches the error, and returns the error for the caller to raise. Outside a Preview it
    returns ``None``.
    """
    scope = current_preview()
    if scope is None:
        return None
    error = PreviewTransactionControl(message)
    scope.capture.refuse(error)
    return error


def sanitize_document(value: Any) -> Any:
    """Replace every literal in a command document with ``"?"``, keeping field names and operators.

    Used for the ``statement`` of a MongoDB ``Db`` entry (OpenTelemetry ``db.query.text``). BSON
    values, dates and bytes are literals too.
    """
    if isinstance(value, (list, tuple)):
        return [sanitize_document(item) for item in value]
    if isinstance(value, Mapping):
        return {str(name): sanitize_document(inner) for name, inner in value.items()}
    return "?"


_BAD_LABEL = re.compile(r"[\x00-\x1f\x7f/\\@=;:?#%]")


def store_label(name: Optional[str]) -> Optional[str]:
    """Validate the optional label a host gives a store for capabilities ``dataStores``.

    Discovery is shown to anyone who can open the workbench, so the label must be a display name
    such as ``catalog``: never a connection string, URL, host:port, user or password.
    """
    if name is None:
        return None
    if not isinstance(name, str) or not name.strip() or len(name) > 64 or _BAD_LABEL.search(name):
        raise ValueError('A data store name must be a display label such as "catalog", not a connection string, URL or host.')
    return name


def read_set(names: Optional[Iterable[str]], transform=lambda name: name, allow_spaces: bool = False) -> Optional[frozenset[str]]:
    """Normalize host-declared reads (``treat_as_read``) into an exact-match set, after ``transform``.

    ``allow_spaces`` admits names that hold single spaces, such as the CQL key ``LIST ROLES`` or the
    Elasticsearch operation ``POST /{}/_refresh``. Wildcards are never allowed.
    """
    if names is None:
        return None
    if isinstance(names, str):
        raise TypeError("treat_as_read takes a list of exact command names.")
    items = list(names)
    pattern = r"[*?]|\s{2,}|^\s|\s$|[^\S ]" if allow_spaces else r"[*?\s]"
    if any(not isinstance(item, str) or not item or re.search(pattern, item) for item in items):
        raise ValueError("treat_as_read takes exact command names, without wildcards.")
    return frozenset(transform(item) for item in items)

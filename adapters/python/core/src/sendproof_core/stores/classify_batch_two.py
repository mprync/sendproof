"""Write classification for the batch-two stores: Cassandra, Elasticsearch and OpenSearch, Cosmos DB and Firestore.

Like :mod:`.classify`, every function is pure and driven by the shared tables of
``spec/data-stores/`` (embedded in :mod:`.tables`). **Everything the table does not list as a read
is a write**, so the guard fails closed when a store adds a statement, endpoint or RPC. The shared
vectors in ``spec/data-stores/classification-cases.json`` run through these functions in
``core/tests/test_batch_two.py``.

Each classifier returns a :class:`Verdict`: the kind (``read``, ``write`` or ``session``) and the
``db.operation.name`` the ``Db`` entry and the 409 body use.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, NamedTuple, Optional
from urllib.parse import unquote

from .classify import READ, SESSION, WRITE
from .tables import CASSANDRA_TABLE, COSMOSDB_TABLE, ELASTICSEARCH_TABLE, FIRESTORE_TABLE


class Verdict(NamedTuple):
    """How the guard treats one command, and the operation name it is logged and refused under."""

    kind: str
    operation: str


# ---------------------------------------------------------------------------------------- statements
class _Shape(NamedTuple):
    first: str
    second: str
    multiple: bool
    broken: bool


def statement_shape(text: Any, *, dollar: bool = False, slash_comments: bool = False, backticks: bool = False) -> _Shape:
    """Read the shape of one statement the way the server would.

    Returns its first two words (upper case, after whitespace and comments), whether anything but
    whitespace and comments follows a semicolon outside quotes (``multiple``), and ``broken`` for
    an unterminated quote or comment. Quotes are ``'...'`` and ``"..."`` with doubled-quote
    escapes; ``backticks`` adds ``...``, ``dollar`` adds CQL's ``$$...$$`` strings and
    ``slash_comments`` adds ``//`` line comments.
    """
    source = "" if text is None else (bytes(text).decode("utf-8", "replace") if isinstance(text, (bytes, bytearray)) else str(text))
    length = len(source)
    index = 0

    class Unterminated(Exception):
        pass

    def comment() -> bool:
        nonlocal index
        if source.startswith("--", index) or (slash_comments and source.startswith("//", index)):
            end = source.find("\n", index)
            index = length if end < 0 else end + 1
            return True
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise Unterminated
            index = end + 2
            return True
        return False

    def skip() -> None:
        nonlocal index
        while True:
            while index < length and source[index].isspace():
                index += 1
            if not comment():
                return

    def word() -> str:
        nonlocal index
        skip()
        match = re.match(r"[A-Za-z_]+", source[index:])
        if not match:
            return ""
        index += match.end()
        return match.group(0).upper()

    try:
        first = word()
        second = word()
        multiple = False
        while index < length:
            if comment():
                continue
            char = source[index]
            quote = char if char in "'\"" or (backticks and char == "`") else ("$$" if dollar and source.startswith("$$", index) else None)
            if quote:
                end = index + len(quote)
                while True:
                    end = source.find(quote, end)
                    if end < 0:
                        raise Unterminated
                    if quote != "$$" and source[end + 1:end + 2] == quote:
                        end += 2
                        continue
                    break
                index = end + len(quote)
                continue
            index += 1
            if char == ";":
                skip()
                if index < length:
                    multiple = True
                break
        return _Shape(first, second, multiple, False)
    except Unterminated:
        return _Shape("", "", False, True)


# ------------------------------------------------------------------------------------------ Cassandra
_CASSANDRA_READ = frozenset(CASSANDRA_TABLE["read"])
_CASSANDRA_SESSION = frozenset(CASSANDRA_TABLE["protocol"]["session"])


def classify_cassandra(statement: Any, treat_as_read: Optional[frozenset[str]] = None) -> Verdict:
    """Classify one CQL statement: ``read`` only for a single statement whose key the table lists.

    The key is the first keyword, or ``LIST <word>``. Text the hook can't read (an unterminated
    quote or comment, nothing at all) and a second statement after a semicolon are writes.
    ``treat_as_read`` holds host-declared reads, compared exactly against the upper-case key.
    """
    shape = statement_shape(statement, dollar=True, slash_comments=True)
    key = f"LIST {shape.second}" if shape.first == "LIST" else shape.first
    operation = "BATCH" if shape.first == "BEGIN" else (key if shape.first == "LIST" else (shape.first or "UNKNOWN"))
    listed = key in _CASSANDRA_READ or (treat_as_read is not None and key in treat_as_read)
    return Verdict(READ if listed and not shape.broken and not shape.multiple else WRITE, operation)


def classify_cassandra_message(message: str, statement: Any = None, prepared: Any = None,
                               treat_as_read: Optional[frozenset[str]] = None) -> Verdict:
    """Classify a native-protocol message: ``PREPARE`` and the connection messages are ``session``,
    ``QUERY`` classifies its text, ``EXECUTE`` classifies the text that was prepared (an id the hook
    never saw prepared is a write) and every ``BATCH`` is a write."""
    if message in _CASSANDRA_SESSION:
        return Verdict(SESSION, message)
    if message == "QUERY":
        return classify_cassandra(statement, treat_as_read)
    if message == "EXECUTE":
        return Verdict(WRITE, "EXECUTE") if prepared is None else classify_cassandra(prepared, treat_as_read)
    return Verdict(WRITE, message)


_CQL_TOKEN = re.compile(
    r"""
      (?P<comment>--[^\n]*|//[^\n]*|/\*.*?(?:\*/|\Z))
    | (?P<ident>"(?:[^"]|"")*")
    | (?P<string>'(?:[^']|'')*'?|\$\$.*?(?:\$\$|\Z))
    | (?P<uuid>\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b)
    | (?P<number>(?<![\w.])(?:0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)(?![\w]))
    """,
    re.VERBOSE | re.DOTALL,
)


def sanitize_cql(text: str) -> str:
    """Replace every literal in CQL text with ``?`` and drop comments.

    Quoted strings, ``$$`` strings, numbers, hex blobs and UUIDs are replaced; double-quoted
    identifiers are kept as written. A statement may inline values instead of binding them, and a
    value never appears in a ``Db`` entry.
    """
    def replace(match: "re.Match[str]") -> str:
        kind = match.lastgroup
        return " " if kind == "comment" else (match.group(0) if kind == "ident" else "?")
    return _CQL_TOKEN.sub(replace, text)


_CQL_TARGET = re.compile(
    r"""^\s*(?:SELECT\b.*?\bFROM|DELETE\b.*?\bFROM|INSERT\s+INTO|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+
        (?P<name>(?:"(?:[^"]|"")+"|\w+)(?:\.(?:"(?:[^"]|"")+"|\w+))?)""",
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


def cql_target(statement: str) -> tuple[Optional[str], Optional[str]]:
    """The ``(keyspace, table)`` a sanitized statement names; either is ``None`` when it doesn't."""
    found = _CQL_TARGET.match(statement)
    if not found:
        return None, None
    parts = re.findall(r'"(?:[^"]|"")+"|\w+', found.group("name"))
    unquote_name = lambda part: part[1:-1].replace('""', '"') if part.startswith('"') else part  # noqa: E731
    if len(parts) == 2:
        return unquote_name(parts[0]), unquote_name(parts[1])
    return None, unquote_name(parts[0])


# ------------------------------------------------------------------------- Elasticsearch / OpenSearch
_ES_ENDPOINTS = tuple(
    (entry["kind"], entry["name"], frozenset(entry["methods"]), tuple(tuple(path.split("/")[1:]) for path in entry["paths"]))
    for entry in ELASTICSEARCH_TABLE["endpoints"]
)
_ES_METHOD_DEFAULT = ELASTICSEARCH_TABLE["methodDefault"]
_ES_SQL_WORDS = frozenset(ELASTICSEARCH_TABLE["sql"]["readWords"])


def path_segments(path: Any) -> list[str]:
    """Split a request path into percent-decoded segments, without its query string and with repeated
    and trailing slashes dropped, as the server does."""
    text = path.decode("utf-8", "replace") if isinstance(path, (bytes, bytearray)) else str(path)
    return [unquote(segment) for segment in text.split("?", 1)[0].split("/") if segment]


def _es_segment(pattern: str, segment: str) -> bool:
    if pattern == "{index}":
        return bool(segment) and not segment.startswith("_")
    return bool(segment) if pattern == "{id}" else pattern == segment


def _sql_request_reads(body: Any) -> bool:
    """Whether a SQL endpoint's body is one ``SELECT``, ``SHOW`` or ``DESCRIBE`` statement or a cursor page."""
    parsed = body
    if isinstance(body, (bytes, bytearray)):
        body = bytes(body).decode("utf-8", "replace")
    if isinstance(body, str):
        try:
            parsed = json.loads(body)
        except ValueError:
            return False
    if not isinstance(parsed, Mapping):
        return False
    query = parsed.get("query")
    if isinstance(query, str):
        shape = statement_shape(query, backticks=True)
        return not shape.broken and not shape.multiple and shape.first in _ES_SQL_WORDS
    return query is None and isinstance(parsed.get("cursor"), str)


def classify_elasticsearch(method: Any, path: Any, body: Any = None,
                           treat_as_read: Optional[frozenset[str]] = None) -> Verdict:
    """Classify an Elasticsearch or OpenSearch request by HTTP method and path (and, for the SQL
    endpoints, the body). The first table entry that matches decides; the operation is its name.

    Without an entry, ``GET`` and ``HEAD`` read and anything else is a write, and the operation is
    the method and the path with every segment that doesn't start with an underscore replaced by
    ``{}`` (``PUT /{}``). ``treat_as_read`` holds host-declared operation names.
    """
    verb = (method.decode() if isinstance(method, (bytes, bytearray)) else str(method)).upper()
    segments = path_segments(path)
    for kind, name, methods, patterns in _ES_ENDPOINTS:
        if verb not in methods:
            continue
        if any(len(pattern) == len(segments) and all(_es_segment(p, s) for p, s in zip(pattern, segments)) for pattern in patterns):
            if kind == "sql":
                kind = READ if _sql_request_reads(body) else WRITE
            return Verdict(kind, name)
    operation = f"{verb} /" + "/".join(s if s.startswith("_") else "{}" for s in segments)
    if treat_as_read is not None and operation in treat_as_read:
        return Verdict(READ, operation)
    return Verdict(_ES_METHOD_DEFAULT.get(verb, ELASTICSEARCH_TABLE["default"]), operation)


def elasticsearch_target(path: Any) -> Optional[str]:
    """The index a request names (its first segment, when that isn't an endpoint), for ``db.collection.name``."""
    segments = path_segments(path)
    return segments[0] if segments and not segments[0].startswith("_") else None


# ---------------------------------------------------------------------------------------------- Cosmos DB
_COSMOS_CANONICAL = {name.lower(): name for name in [*COSMOSDB_TABLE["read"], *COSMOSDB_TABLE["write"]]}
_COSMOS_READ = frozenset(COSMOSDB_TABLE["read"])
_COSMOS_TRIGGER_HEADERS = frozenset({"x-ms-documentdb-pre-trigger-include", "x-ms-documentdb-post-trigger-include"})


def _header(headers: Mapping[str, Any], name: str) -> Optional[str]:
    for key, value in headers.items():
        if str(key).lower() == name:
            return None if value is None else str(value)
    return None


def _truthy(value: Optional[str]) -> bool:
    return str(value or "").lower() == "true"


def cosmos_operation(method: Any, path: Any, headers: Optional[Mapping[str, Any]] = None) -> str:
    """Derive a Cosmos DB operation type from an HTTP request, as ``fromRequest`` in the table describes."""
    headers = headers or {}
    segments = path_segments(path)
    one = len(segments) > 0 and len(segments) % 2 == 0
    verb = str(method).upper()
    if verb == "GET":
        return "Read" if one else "ReadFeed"
    if verb == "HEAD":
        return "Head" if one else "HeadFeed"
    if verb == "POST":
        if _truthy(_header(headers, "x-ms-cosmos-is-query-plan-request")):
            return "QueryPlan"
        if _truthy(_header(headers, "x-ms-documentdb-isquery")) or re.match(
            r"application/query\+json\b", _header(headers, "content-type") or "", re.IGNORECASE
        ):
            return "Query"
        if _truthy(_header(headers, "x-ms-cosmos-is-batch-request")):
            return "Batch"
        if one and segments[-2] == "sprocs":
            return "ExecuteJavaScript"
        return "Upsert" if _truthy(_header(headers, "x-ms-documentdb-is-upsert")) else "Create"
    return {"PUT": "Replace", "PATCH": "Patch", "DELETE": "Delete"}.get(verb, verb)


def classify_cosmos(operation_type: Optional[str] = None, triggers: bool = False,
                    request: Optional[Mapping[str, Any]] = None,
                    treat_as_read: Optional[frozenset[str]] = None) -> Verdict:
    """Classify a Cosmos DB operation.

    Pass ``operation_type`` (an SDK-level hook) or ``request`` (``{method, path, headers}``, a hook
    on the HTTP pipeline). ``triggers=True``, or a trigger header on the request, makes any
    operation a write. Operation types compare case-insensitively.
    """
    if operation_type is None:
        request = request or {}
        operation_type = cosmos_operation(request.get("method", ""), request.get("path", ""), request.get("headers"))
    operation = _COSMOS_CANONICAL.get(str(operation_type).lower(), str(operation_type))
    headers = (request or {}).get("headers") or {}
    triggered = triggers or any(str(name).lower() in _COSMOS_TRIGGER_HEADERS for name in headers)
    listed = operation in _COSMOS_READ or (treat_as_read is not None and operation in treat_as_read)
    return Verdict(READ if listed and not triggered else WRITE, operation)


# ----------------------------------------------------------------------------------------------- Firestore
_FIRESTORE_SERVICES = FIRESTORE_TABLE["services"]
_FIRESTORE_VERBS = FIRESTORE_TABLE["fromRest"]["verbs"]


def firestore_rpc(method: Any, path: Any) -> str:
    """Derive a Firestore RPC name from a REST request, as ``fromRest`` in the table describes."""
    segments = path_segments(path)
    last = segments[-1] if segments else ""
    colon = last.rfind(":")
    if colon >= 0:
        verb = last[colon + 1:]
        return _FIRESTORE_VERBS.get(verb, verb)
    after = len(segments) - (segments.index("documents") + 1) if "documents" in segments else 0
    document = "documents" in segments and after > 0 and after % 2 == 0
    verb = str(method).upper()
    if verb == "GET":
        return "GetDocument" if document else "ListDocuments"
    if verb == "PATCH":
        return "UpdateDocument"
    if verb == "DELETE":
        return "DeleteDocument"
    if verb == "POST":
        return "POST" if document else "CreateDocument"
    return verb


def _writes(message: Any) -> Optional[int]:
    """How many writes a ``Commit`` message carries, or ``None`` when the hook can't read the message."""
    if message is None:
        return None
    if isinstance(message, Mapping):
        listed = message.get("writes", [])
    else:
        try:
            listed = getattr(message, "writes")
        except AttributeError:
            return None
    try:
        return len(listed) if listed is not None else 0
    except TypeError:
        return None


def classify_firestore(rpc: Any, message: Any = None, treat_as_read: Optional[frozenset[str]] = None) -> Verdict:
    """Classify a Firestore RPC.

    ``rpc`` is the gRPC path (``/google.firestore.v1.Firestore/Commit``) or a bare v1 method name;
    ``message`` is the request (a mapping or a message object), when the hook can read it. A
    ``Commit`` is a write when it carries a write or can't be read, and ``session`` when it holds
    none. Methods of any other service or API version are writes, except admin methods that start
    with ``Get`` or ``List``.
    """
    text = rpc.decode() if isinstance(rpc, (bytes, bytearray)) else str(rpc)
    if "/" in text:
        parts = [part for part in text.split("/") if part]
        service, operation = (parts + ["", ""])[:2]
    else:
        service, operation = "google.firestore.v1.Firestore", text
    known = _FIRESTORE_SERVICES.get(service)
    if known is None:
        return Verdict(WRITE, operation)
    if "readPrefixes" in known:
        return Verdict(READ if operation.startswith(tuple(known["readPrefixes"])) else WRITE, operation)
    if operation == "Commit":
        return Verdict(SESSION if _writes(message) == 0 else WRITE, operation)
    if operation in known["read"] or (treat_as_read is not None and operation in treat_as_read):
        return Verdict(READ, operation)
    if operation in known["session"]:
        return Verdict(SESSION, operation)
    return Verdict(WRITE, operation)

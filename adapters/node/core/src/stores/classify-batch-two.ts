/**
 * Write classification for the batch-two data stores (Cassandra, Elasticsearch and OpenSearch,
 * Cosmos DB, Firestore), driven by the shared tables in spec/data-stores/ (embedded in ./tables.ts).
 * As in batch one, each table lists reads and connection-level calls; everything else, including a
 * call the table has never heard of, is a write, so the guard fails closed when a store adds one.
 *
 * Every function here is pure. The shared vectors in spec/data-stores/classification-cases.json
 * run through them in tests/stores-batch-two.test.mts.
 */
import { cassandraTable, cosmosdbTable, elasticsearchTable, firestoreTable } from './tables.js';

/** The outcome of classifying one call: whether it may write, and the `db.operation.name` to log. */
export interface Classified {
  kind: 'read' | 'write' | 'session';
  /** The name used in the `Db` entry and in the 409 body, as the store's table defines it. */
  operation: string;
}

/** A read the host declared by exact operation name (`treatAsRead`) replaces a `write` verdict. */
const withHostReads = (result: Classified, treatAsRead: ReadonlySet<string> | undefined): Classified =>
  result.kind === 'write' && treatAsRead?.has(result.operation) ? { ...result, kind: 'read' } : result;

// ---- the shape of one statement (CQL, Elasticsearch SQL) ----

/** What {@link statementShape} reads from a statement. */
export interface StatementShape {
  /** The first word in upper case, after whitespace and comments. */
  first: string;
  /** The second word in upper case. */
  second: string;
  /** Whether anything but whitespace and comments follows a semicolon outside quotes. */
  multiple: boolean;
  /** An unterminated quote or comment: the text can't be read the way the server reads it. */
  broken: boolean;
}

/** Dialect switches for {@link statementShape}. */
export interface StatementDialect {
  /** Backtick-quoted names (Elasticsearch SQL). */
  backticks?: boolean;
  /** `$$ … $$` strings (CQL). */
  dollar?: boolean;
  /** `//` line comments (CQL). */
  slashComments?: boolean;
}

/**
 * Read the shape of one statement the way the server would: its first two words, and whether
 * anything but whitespace and comments follows a semicolon outside quotes. Quotes are `'…'` and
 * `"…"` with doubled-quote escapes; the dialect adds backticks and `$$` strings.
 */
export function statementShape(text: unknown, dialect: StatementDialect = {}): StatementShape {
  const source = typeof text === 'string' ? text : '';
  let index = 0;
  const comment = (): boolean => {
    if (source.startsWith('--', index) || (dialect.slashComments && source.startsWith('//', index))) {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
      return true;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('unterminated comment');
      index = end + 2;
      return true;
    }
    return false;
  };
  const skip = () => { for (;;) { while (/\s/.test(source[index] ?? '')) index++; if (!comment()) return; } };
  const word = (): string => {
    skip();
    const match = /^[A-Za-z_]+/.exec(source.slice(index));
    if (!match) return '';
    index += match[0].length;
    return match[0].toUpperCase();
  };
  try {
    const first = word();
    const second = word();
    let multiple = false;
    while (index < source.length) {
      if (comment()) continue;
      const char = source[index]!;
      const quote = char === "'" || char === '"' || (dialect.backticks && char === '`') ? char : dialect.dollar && source.startsWith('$$', index) ? '$$' : null;
      if (quote) {
        let end = index + quote.length;
        for (;;) {
          end = source.indexOf(quote, end);
          if (end < 0) throw new Error('unterminated quote');
          if (quote !== '$$' && source[end + 1] === quote) { end += 2; continue; }
          break;
        }
        index = end + quote.length;
        continue;
      }
      index++;
      if (char === ';') {
        skip();
        if (index < source.length) multiple = true;
        break;
      }
    }
    return { first, second, multiple, broken: false };
  } catch {
    return { first: '', second: '', multiple: false, broken: true };
  }
}

// ---- Cassandra ----

const cassandra = { read: new Set<string>(cassandraTable.read), session: new Set<string>(cassandraTable.protocol.session) };

/**
 * Classify one CQL statement. A read only when it is a single statement whose key the table lists
 * (`LIST` takes its next word too); everything else, text that can't be read included, is a write.
 * `BEGIN BATCH` text is named `BATCH`. `treatAsRead` holds host-declared operation names.
 */
export function classifyCassandra(statement: unknown, treatAsRead?: ReadonlySet<string>): Classified {
  const { first, second, multiple, broken } = statementShape(statement, { dollar: true, slashComments: true });
  const key = first === 'LIST' ? `LIST ${second}` : first;
  const operation = first === 'BEGIN' ? 'BATCH' : first === 'LIST' ? key : first || 'UNKNOWN';
  return withHostReads({ kind: !broken && !multiple && cassandra.read.has(key) ? 'read' : 'write', operation }, treatAsRead);
}

/**
 * Classify a CQL native-protocol message the way a wire-level hook would: connection messages and
 * `PREPARE` are `session`, `QUERY` classifies its text, `EXECUTE` classifies the text it was
 * prepared from (an id never seen prepared is a write) and every `BATCH` is a write.
 */
export function classifyCassandraMessage(message: string, { statement, prepared }: { statement?: unknown; prepared?: unknown } = {}): Classified {
  if (cassandra.session.has(message)) return { kind: 'session', operation: message };
  if (message === 'QUERY') return classifyCassandra(statement);
  if (message === 'EXECUTE') return prepared === undefined ? { kind: 'write', operation: 'EXECUTE' } : classifyCassandra(prepared);
  return { kind: 'write', operation: message };
}

/** The `keyspace` and table a CQL statement names, for the `Db` entry's namespace and target. */
export function cassandraTarget(statement: unknown): { keyspace?: string; table?: string } {
  const match = /\b(?:FROM|INTO|UPDATE|TRUNCATE|TABLE)\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(typeof statement === 'string' ? statement : '');
  return { ...(match?.[1] ? { keyspace: match[1] } : {}), ...(match?.[2] ? { table: match[2] } : {}) };
}

/**
 * Replace the literals in CQL, SQL or PartiQL text with `?`: `$$` strings, quoted strings and
 * numbers. Double-quoted names are kept. Bound values never appear in the text at all.
 */
export function sanitizeStatement(text: unknown): string {
  return String(text ?? '')
    .replace(/\$\$[\s\S]*?\$\$/g, '?')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w"])-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '?');
}

// ---- Elasticsearch and OpenSearch ----

/** One entry of the Elasticsearch table: the kinds are read, write, session and sql. */
interface Endpoint { kind: string; name: string; methods: readonly string[]; paths: readonly string[] }

/** The path split into percent-decoded segments, without the query string or empty segments. */
function pathSegments(path: unknown): string[] {
  return String(path ?? '').split('?')[0]!.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
}

const searchSegment = (pattern: string, segment: string): boolean =>
  pattern === '{index}' ? segment.length > 0 && !segment.startsWith('_') : pattern === '{id}' ? segment.length > 0 : pattern === segment;

/** Whether an SQL endpoint's body is one read statement, or a cursor page of an earlier read. */
function sqlRequestReads(body: unknown): boolean {
  let parsed: unknown = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const { query, cursor } = parsed as { query?: unknown; cursor?: unknown };
  if (typeof query === 'string') {
    const { first, multiple, broken } = statementShape(query, { backticks: true });
    return !broken && !multiple && (elasticsearchTable.sql.readWords as readonly string[]).includes(first);
  }
  return query === undefined && typeof cursor === 'string';
}

/**
 * Classify an Elasticsearch or OpenSearch request by HTTP method and path (and, for the SQL
 * endpoints, the body: an object, JSON text or a buffer; a stream or anything unreadable is a
 * write). `operation` is the endpoint's name from the table. A path no entry matches is a read
 * for GET and HEAD and a write otherwise.
 */
export function classifyElasticsearch(method: string, path: unknown, body?: unknown, treatAsRead?: ReadonlySet<string>): Classified {
  const verb = String(method).toUpperCase();
  const segments = pathSegments(path);
  for (const entry of elasticsearchTable.endpoints as readonly Endpoint[]) {
    if (!entry.methods.includes(verb)) continue;
    const hit = entry.paths.some(pattern => {
      const parts = pathSegments(pattern);
      return parts.length === segments.length && parts.every((part, index) => searchSegment(part, segments[index]!));
    });
    if (!hit) continue;
    const kind = entry.kind === 'sql' ? (sqlRequestReads(body) ? 'read' : 'write') : entry.kind as Classified['kind'];
    return withHostReads({ kind, operation: entry.name }, treatAsRead);
  }
  const operation = `${verb} /${segments.map(segment => segment.startsWith('_') ? segment : '{}').join('/')}`;
  const byMethod = (elasticsearchTable.methodDefault as Record<string, string>)[verb];
  return withHostReads({ kind: byMethod === 'read' ? 'read' : 'write', operation }, treatAsRead);
}

/** The index a request names (its first segment, when it isn't an endpoint), for `db.collection.name`. */
export function elasticsearchTarget(path: unknown): string | undefined {
  const [first] = pathSegments(path);
  return first && !first.startsWith('_') ? first : undefined;
}

// ---- Cosmos DB ----

const cosmos = {
  canonical: new Map<string, string>([...cosmosdbTable.read, ...cosmosdbTable.write].map(name => [name.toLowerCase(), name])),
  read: new Set<string>(cosmosdbTable.read),
};
const truthy = (value: unknown): boolean => String(value ?? '').toLowerCase() === 'true';

/** A Cosmos DB request as an HTTP pipeline sees it. */
export interface CosmosRequest {
  method: string;
  path: string;
  headers?: Record<string, unknown>;
}

/** The value of a header, by case-insensitive name. */
function header(headers: Record<string, unknown> | undefined, name: string): unknown {
  for (const key of Object.keys(headers ?? {})) if (key.toLowerCase() === name) return headers![key];
  return undefined;
}

/** Whether a request names a pre-trigger or post-trigger: triggers run code that can write. */
export function namesTrigger(headers: Record<string, unknown> | undefined): boolean {
  return Object.keys(headers ?? {}).some(name => {
    const key = name.toLowerCase();
    return key === 'x-ms-documentdb-pre-trigger-include' || key === 'x-ms-documentdb-post-trigger-include';
  });
}

/** Derive a Cosmos DB operation type from an HTTP request, as `fromRequest` in cosmosdb.json describes. */
export function cosmosOperation({ method, path, headers }: CosmosRequest): string {
  const segments = pathSegments(path);
  const one = segments.length > 0 && segments.length % 2 === 0;
  switch (String(method).toUpperCase()) {
    case 'GET': return one ? 'Read' : 'ReadFeed';
    case 'HEAD': return one ? 'Head' : 'HeadFeed';
    case 'POST':
      if (truthy(header(headers, 'x-ms-cosmos-is-query-plan-request'))) return 'QueryPlan';
      if (truthy(header(headers, 'x-ms-documentdb-isquery')) || /^application\/query\+json\b/i.test(String(header(headers, 'content-type') ?? ''))) return 'Query';
      if (truthy(header(headers, 'x-ms-cosmos-is-batch-request'))) return 'Batch';
      if (one && segments.at(-2) === 'sprocs') return 'ExecuteJavaScript';
      if (truthy(header(headers, 'x-ms-documentdb-is-upsert'))) return 'Upsert';
      return 'Create';
    case 'PUT': return 'Replace';
    case 'PATCH': return 'Patch';
    case 'DELETE': return 'Delete';
    default: return String(method).toUpperCase();
  }
}

/**
 * Classify a Cosmos DB call. Give `operationType` (the SDK's own, in any case) or `request` (the HTTP
 * request it is derived from), or both: a call is a write when either says so. `triggers: true`, or a
 * trigger header on the request, makes any call a write. `operation` is the SDK's type when given.
 */
export function classifyCosmos({ operationType, triggers = false, request }: { operationType?: string; triggers?: boolean; request?: CosmosRequest }, treatAsRead?: ReadonlySet<string>): Classified {
  const canonical = (name: string) => cosmos.canonical.get(name.toLowerCase()) ?? name;
  const derived = request ? canonical(cosmosOperation(request)) : undefined;
  const given = operationType === undefined ? undefined : canonical(String(operationType));
  const operation = given ?? derived ?? 'UNKNOWN';
  const triggered = triggers || namesTrigger(request?.headers);
  const reads = (name: string | undefined) => name === undefined || cosmos.read.has(name);
  return withHostReads({ kind: !triggered && reads(given) && reads(derived) ? 'read' : 'write', operation }, treatAsRead);
}

/** The database and container a Cosmos DB path names, for the `Db` entry's namespace and target. */
export function cosmosTarget(path: unknown): { database?: string; container?: string } {
  const segments = pathSegments(path);
  const after = (name: string) => segments.includes(name) ? segments[segments.indexOf(name) + 1] : undefined;
  const database = after('dbs');
  const container = after('colls');
  return { ...(database ? { database } : {}), ...(container ? { container } : {}) };
}

// ---- Firestore ----

const firestoreVerbs = firestoreTable.fromRest.verbs as Record<string, string>;
const firestoreServices = firestoreTable.services as Record<string, { read?: readonly string[]; session?: readonly string[]; readPrefixes?: readonly string[] }>;

/** Derive a Firestore RPC method name from a REST request, as `fromRest` in firestore.json describes. */
export function firestoreRpc({ method, path }: { method: string; path: string }): string {
  const segments = pathSegments(path);
  const last = segments.at(-1) ?? '';
  const colon = last.lastIndexOf(':');
  if (colon >= 0) return firestoreVerbs[last.slice(colon + 1)] ?? last.slice(colon + 1);
  const after = segments.length - (segments.indexOf('documents') + 1);
  const document = segments.includes('documents') && after > 0 && after % 2 === 0;
  switch (String(method).toUpperCase()) {
    case 'GET': return document ? 'GetDocument' : 'ListDocuments';
    case 'PATCH': return 'UpdateDocument';
    case 'DELETE': return 'DeleteDocument';
    case 'POST': return document ? 'POST' : 'CreateDocument';
    default: return String(method).toUpperCase();
  }
}

/**
 * Classify a Firestore RPC. `rpc` is the gRPC path (`/google.firestore.v1.Firestore/Commit`) or a bare
 * v1 method name; `message` is the request, when the hook can read it. A `Commit` is a write unless the
 * message is readable and has no writes. A method of a service the table doesn't list is a write.
 */
export function classifyFirestore(rpc: string, message?: unknown, treatAsRead?: ReadonlySet<string>): Classified {
  const text = String(rpc);
  const [service, name] = text.includes('/') ? text.split('/').filter(Boolean) : ['google.firestore.v1.Firestore', text];
  const operation = name ?? '';
  const known = service === undefined ? undefined : firestoreServices[service];
  if (!known) return withHostReads({ kind: 'write', operation }, treatAsRead);
  if (known.readPrefixes) return withHostReads({ kind: known.readPrefixes.some(prefix => operation.startsWith(prefix)) ? 'read' : 'write', operation }, treatAsRead);
  if (operation === 'Commit') {
    const writes = message && typeof message === 'object' ? (message as { writes?: unknown }).writes : undefined;
    const empty = message !== undefined && message !== null && (writes === undefined || (Array.isArray(writes) && writes.length === 0));
    return withHostReads({ kind: empty ? 'session' : 'write', operation }, treatAsRead);
  }
  if (known.read?.includes(operation)) return { kind: 'read', operation };
  if (known.session?.includes(operation)) return { kind: 'session', operation };
  return withHostReads({ kind: 'write', operation }, treatAsRead);
}

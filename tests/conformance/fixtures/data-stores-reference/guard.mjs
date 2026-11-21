/**
 * The write guard, as spec/data-stores.md defines it, in about two hundred lines.
 *
 * This is the reference the per-language bindings follow. It has three parts:
 * - classification, loaded unchanged from the shared tables in spec/data-stores/;
 * - the Preview scope, carried through the request with AsyncLocalStorage, which records the
 *   blocked mark, captured logs and changes;
 * - redaction, the same whole-word secret rule the SQL providers use.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

const table = name => JSON.parse(readFileSync(new URL(`../../../../spec/data-stores/${name}.json`, import.meta.url), 'utf8'));
const tables = {
  redis: table('redis'), mongodb: table('mongodb'), dynamodb: table('dynamodb'),
  cassandra: table('cassandra'), elasticsearch: table('elasticsearch'), cosmosdb: table('cosmosdb'), firestore: table('firestore'),
};
const sets = {
  redis: {
    read: new Set([...tables.redis.read, ...tables.redis.moduleRead]),
    session: new Set(tables.redis.session),
    transaction: new Set(tables.redis.transaction),
  },
  mongodb: {
    read: new Set(tables.mongodb.read.map(name => name.toLowerCase())),
    session: new Set(tables.mongodb.session.map(name => name.toLowerCase())),
    notInTransaction: new Set(tables.mongodb.notInTransaction.commands.map(name => name.toLowerCase())),
    stages: new Set(tables.mongodb.notInTransaction.stages),
  },
  dynamodb: { read: new Set(tables.dynamodb.read), partiql: new Set(tables.dynamodb.partiql.operations) },
  cassandra: { read: new Set(tables.cassandra.read), session: new Set(tables.cassandra.protocol.session) },
  // Operation types compare case-insensitively (Node's SDK spells them in lower case) and are named canonically.
  cosmosdb: { canonical: new Map([...tables.cosmosdb.read, ...tables.cosmosdb.write].map(name => [name.toLowerCase(), name])), read: new Set(tables.cosmosdb.read) },
};

/** Display names used in "Preview unavailable: this operation writes to <Store>". */
export const storeNames = {
  mongodb: 'MongoDB', redis: 'Redis', dynamodb: 'DynamoDB',
  cassandra: 'Cassandra', elasticsearch: 'Elasticsearch', opensearch: 'OpenSearch', cosmosdb: 'Cosmos DB', firestore: 'Firestore',
};

/** The reference's switch for the negative self-test: `BENCH_REFERENCE_GUARD=off` lets every write through. */
export const guardEnabled = process.env.BENCH_REFERENCE_GUARD !== 'off';

/**
 * Classifies a Redis command as `read`, `session` (connection-level, never logged), `transaction`
 * (MULTI, EXEC and friends) or `write`. `args` are the command's arguments after its name.
 */
export function classifyRedis(name, args = []) {
  const command = String(name).toUpperCase();
  const withSub = args.length ? `${command}|${String(args[0]).toUpperCase()}` : command;
  for (const key of [withSub, command]) {
    if (sets.redis.session.has(key)) return 'session';
    if (sets.redis.transaction.has(key)) return 'transaction';
    if (sets.redis.read.has(key)) return 'read';
  }
  return 'write';
}

/** Whether any stage of an aggregation pipeline, at any depth, is one of `stages`. */
function pipelineUses(value, stages) {
  if (Array.isArray(value)) return value.some(item => pipelineUses(item, stages));
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.entries(value).some(([key, inner]) => stages.has(key) || pipelineUses(inner, stages));
  }
  return false;
}

/**
 * Classifies a MongoDB command document. Returns `{ kind, refusedInTransaction? }`, where `kind` is
 * `read`, `session` or `write`, and `refusedInTransaction` names what MongoDB would refuse inside a
 * transaction (a command, or a stage such as `$out`).
 */
export function classifyMongo(command) {
  const name = Object.keys(command)[0];
  const lower = name.toLowerCase();
  if (lower === 'explain') return classifyMongo(command.explain);
  let refused;
  if (sets.mongodb.notInTransaction.has(lower)) refused = name;
  const stage = lower === 'aggregate' && [...sets.mongodb.stages].find(item => pipelineUses(command.pipeline, new Set([item])));
  if (stage) refused = stage;
  if (sets.mongodb.session.has(lower)) return { kind: 'session' };
  if (lower === 'aggregate' && pipelineUses(command.pipeline, new Set(['$out', '$merge']))) return { kind: 'write', refusedInTransaction: refused };
  if (sets.mongodb.read.has(lower)) return { kind: 'read', refusedInTransaction: refused };
  return { kind: 'write', refusedInTransaction: refused };
}

/** Skips whitespace and SQL-style comments, then returns the first word of a PartiQL statement in upper case. */
function firstWord(statement) {
  let text = String(statement);
  for (;;) {
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) { text = trimmed.replace(/^--[^\n]*(\n|$)/, ''); continue; }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      if (end < 0) return '';
      text = trimmed.slice(end + 2);
      continue;
    }
    return (trimmed.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  }
}

/** Classifies a DynamoDB action and its input as `read` or `write`. PartiQL is a read only when every statement is a SELECT. */
export function classifyDynamo(operation, input = {}) {
  if (sets.dynamodb.read.has(operation)) return 'read';
  if (sets.dynamodb.partiql.has(operation)) {
    const statements = operation === 'ExecuteStatement' ? [input.Statement]
      : (input.Statements ?? input.TransactStatements ?? []).map(item => item.Statement);
    return statements.length && statements.every(statement => firstWord(statement) === 'SELECT') ? 'read' : 'write';
  }
  return 'write';
}

/**
 * Reads the shape of one statement the way the server would: its first two words (upper case,
 * after whitespace and comments) and whether anything but whitespace and comments follows a
 * semicolon outside quotes. `broken` is set for an unterminated quote or comment. Quotes are
 * '…' and "…" with doubled-quote escapes; `dialect.backticks` adds `…`, `dialect.dollar` adds
 * CQL's $$…$$ strings, and `dialect.slashComments` adds // line comments.
 */
export function statementShape(text, dialect = {}) {
  const source = String(text ?? '');
  let index = 0;
  const comment = () => {
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
  const word = () => { skip(); const match = /^[A-Za-z_]+/.exec(source.slice(index)); if (!match) return ''; index += match[0].length; return match[0].toUpperCase(); };
  try {
    const first = word();
    const second = word();
    let multiple = false;
    while (index < source.length) {
      if (comment()) continue;
      const char = source[index];
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
      if (char === ';') { skip(); if (index < source.length) multiple = true; break; }
    }
    return { first, second, multiple, broken: false };
  } catch {
    return { first: '', second: '', multiple: false, broken: true };
  }
}

/**
 * Classifies one CQL statement. Returns `{ kind, operation }`: `read` only for a single statement
 * whose key the table lists as a read; everything else, including text that can't be read, is a write.
 */
export function classifyCassandra(statement) {
  const { first, second, multiple, broken } = statementShape(statement, { dollar: true, slashComments: true });
  const key = first === 'LIST' ? `LIST ${second}` : first;
  const operation = first === 'BEGIN' ? 'BATCH' : first === 'LIST' ? key : first || 'UNKNOWN';
  return { kind: !broken && !multiple && sets.cassandra.read.has(key) ? 'read' : 'write', operation };
}

/**
 * Classifies a CQL native-protocol message: `PREPARE` and the connection messages are `session`,
 * `QUERY` classifies its text, `EXECUTE` classifies the text that was prepared (unknown ids are
 * writes), and every `BATCH` is a write.
 */
export function classifyCassandraMessage(message, { statement, prepared } = {}) {
  if (sets.cassandra.session.has(message)) return { kind: 'session', operation: message };
  if (message === 'QUERY') return classifyCassandra(statement);
  if (message === 'EXECUTE') return prepared === undefined ? { kind: 'write', operation: 'EXECUTE' } : classifyCassandra(prepared);
  return { kind: 'write', operation: message };
}

const esSegment = (pattern, segment) =>
  pattern === '{index}' ? segment.length > 0 && !segment.startsWith('_') : pattern === '{id}' ? segment.length > 0 : pattern === segment;

/** Splits a request path into decoded segments: no query string, no repeated or trailing slashes. */
function pathSegments(path) {
  return String(path).split('?')[0].split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
}

/** Whether an Elasticsearch or OpenSearch SQL request is a single read statement or a cursor page. */
function sqlRequestReads(body) {
  let parsed = body;
  if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch { return false; } }
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.query === 'string') {
    const { first, multiple, broken } = statementShape(parsed.query, { backticks: true });
    return !broken && !multiple && tables.elasticsearch.sql.readWords.includes(first);
  }
  return parsed.query === undefined && typeof parsed.cursor === 'string';
}

/**
 * Classifies an Elasticsearch or OpenSearch request by HTTP method and path (and, for the SQL
 * endpoints, the body). Returns `{ kind, operation }` with the endpoint id as the operation.
 */
export function classifyElasticsearch(method, path, body) {
  const verb = String(method).toUpperCase();
  const segments = pathSegments(path);
  for (const entry of tables.elasticsearch.endpoints) {
    if (!entry.methods.includes(verb)) continue;
    const hit = entry.paths.some(pattern => {
      const parts = pathSegments(pattern);
      return parts.length === segments.length && parts.every((part, index) => esSegment(part, segments[index]));
    });
    if (!hit) continue;
    const kind = entry.kind === 'sql' ? (sqlRequestReads(body) ? 'read' : 'write') : entry.kind;
    return { kind, operation: entry.name };
  }
  const operation = `${verb} /${segments.map(segment => segment.startsWith('_') ? segment : '{}').join('/')}`;
  return { kind: tables.elasticsearch.methodDefault[verb] ?? tables.elasticsearch.default, operation };
}

/** The index a request names (its first segment, when that isn't an endpoint), for db.collection.name. */
export function elasticsearchTarget(path) {
  const [first] = pathSegments(path);
  return first && !first.startsWith('_') ? first : undefined;
}

const truthy = value => String(value ?? '').toLowerCase() === 'true';

/** Derives a Cosmos DB operation type from an HTTP request, as cosmosdb.json's fromRequest describes. */
export function cosmosOperation({ method, path, headers = {} }) {
  const header = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const segments = pathSegments(path);
  const one = segments.length > 0 && segments.length % 2 === 0;
  switch (String(method).toUpperCase()) {
    case 'GET': return one ? 'Read' : 'ReadFeed';
    case 'HEAD': return one ? 'Head' : 'HeadFeed';
    case 'POST':
      if (truthy(header('x-ms-cosmos-is-query-plan-request'))) return 'QueryPlan';
      if (truthy(header('x-ms-documentdb-isquery')) || /^application\/query\+json\b/i.test(header('content-type') ?? '')) return 'Query';
      if (truthy(header('x-ms-cosmos-is-batch-request'))) return 'Batch';
      if (one && segments.at(-2) === 'sprocs') return 'ExecuteJavaScript';
      if (truthy(header('x-ms-documentdb-is-upsert'))) return 'Upsert';
      return 'Create';
    case 'PUT': return 'Replace';
    case 'PATCH': return 'Patch';
    case 'DELETE': return 'Delete';
    default: return String(method).toUpperCase();
  }
}

/**
 * Classifies a Cosmos DB operation. Pass `operationType` (an SDK-level hook) or `request`
 * (`{ method, path, headers }`, an HTTP-pipeline hook). `triggers: true`, or a trigger header on the
 * request, makes any operation a write.
 */
export function classifyCosmos({ operationType, triggers = false, request }) {
  const given = operationType ?? cosmosOperation(request);
  const operation = sets.cosmosdb.canonical.get(String(given).toLowerCase()) ?? given;
  const headerNames = Object.keys(request?.headers ?? {}).map(name => name.toLowerCase());
  const triggered = triggers || headerNames.some(name => name === 'x-ms-documentdb-pre-trigger-include' || name === 'x-ms-documentdb-post-trigger-include');
  return { kind: !triggered && sets.cosmosdb.read.has(operation) ? 'read' : 'write', operation };
}

/** Derives a Firestore RPC name from a REST request, as firestore.json's fromRest describes. */
export function firestoreRpc({ method, path }) {
  const segments = pathSegments(path);
  const last = segments.at(-1) ?? '';
  const colon = last.lastIndexOf(':');
  if (colon >= 0) return tables.firestore.fromRest.verbs[last.slice(colon + 1)] ?? last.slice(colon + 1);
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
 * Classifies a Firestore RPC. `rpc` is the gRPC path (/google.firestore.v1.Firestore/Commit) or a
 * bare v1 method name; `message` is the request, when the hook can read it.
 */
export function classifyFirestore(rpc, message) {
  const [service, name] = String(rpc).includes('/') ? String(rpc).split('/').filter(Boolean) : ['google.firestore.v1.Firestore', String(rpc)];
  const operation = name ?? '';
  const known = tables.firestore.services[service];
  if (!known) return { kind: 'write', operation };
  if (known.readPrefixes) return { kind: known.readPrefixes.some(prefix => operation.startsWith(prefix)) ? 'read' : 'write', operation };
  if (operation === 'Commit') return { kind: message && Array.isArray(message.writes ?? []) && !(message.writes?.length) ? 'session' : 'write', operation };
  if (known.read.includes(operation)) return { kind: 'read', operation };
  if (known.session.includes(operation)) return { kind: 'session', operation };
  return { kind: 'write', operation };
}

/** Replaces CQL, SQL or PartiQL literals (quoted strings and numbers) with ?, keeping double-quoted names. */
export function sanitizeStatement(text) {
  return String(text)
    .replace(/\$\$[\s\S]*?\$\$/g, '?')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/(?<![\w"])-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '?');
}

/** Thrown to the handler when the guard refuses a write. The Preview scope's mark decides the outcome, not this error. */
export class PreviewWriteBlockedError extends Error {
  constructor(store, operation, detail) {
    super(detail);
    this.name = 'PreviewWriteBlockedError';
    this.store = store;
    this.operation = operation;
  }
}

/** Thrown when the handler tries to end or escape the Preview transaction, such as a raw SQL COMMIT. */
export class PreviewTransactionControlError extends Error {
  constructor(statement) {
    super(`Preview refused a transaction-control statement: ${statement.split(/\s+/)[0]}`);
    this.name = 'PreviewTransactionControlError';
  }
}

const scopes = new AsyncLocalStorage();

/** The current request's Preview scope, or undefined outside a Preview. */
export const previewScope = () => scopes.getStore()?.preview ? scopes.getStore() : undefined;
/** The current request's capture (Preview or observed Send), or undefined when nothing is captured. */
export const captureScope = () => scopes.getStore();

/**
 * Runs `work` with a capture scope. `preview: true` turns the guard on. The scope collects logs and
 * changes, and `blocked` holds the first refused write.
 */
export function withScope({ preview }, work) {
  const scope = { preview, logs: [], changes: [], blocked: null, fault: null, start: performance.now(), mongo: null };
  return scopes.run(scope, () => work(scope));
}

/**
 * The guard's single decision point. Call it before a command is sent. Outside a Preview it does
 * nothing. In a Preview it refuses writes to guarded stores, marks the scope blocked and throws.
 */
export function guard(store, operation, kind, detail) {
  const scope = previewScope();
  if (!scope || !guardEnabled || kind !== 'write') return;
  const reason = detail ?? `Preview unavailable: this operation writes to ${storeNames[store]}`;
  scope.blocked ??= { store, operation, detail: reason };
  scope.logs.push(dbLog({ system: store, operation, blocked: true }));
  throw new PreviewWriteBlockedError(store, operation, reason);
}

const transactionControl = /^\s*(COMMIT|END|ROLLBACK(?!\s+(WORK\s+)?TO\b)|ABORT|BEGIN|START\s+TRANSACTION|SET\s+autocommit)\b/i;

/** Refuses a SQL statement that would end the Preview transaction. Savepoints stay allowed. */
export function guardSql(statement) {
  const scope = previewScope();
  if (!scope || !guardEnabled || !transactionControl.test(statement)) return;
  scope.fault ??= new PreviewTransactionControlError(statement);
  throw scope.fault;
}

// Secret names, judged by whole words: the same rule as adapters/node/core/src/secrets.ts.
const secretWords = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'hash', 'salt', 'credential', 'credentials', 'apikey']);
const keyQualifiers = new Set(['api', 'private', 'secret', 'access', 'signing', 'encryption', 'client']);
export const redacted = '[REDACTED]';

/** Whether an identifier or statement names a secret. `password_hash` and `apiKey` do; `idempotency_key` doesn't. */
export function looksSecret(text) {
  const words = String(text).match(/[\p{Lu}]?[\p{Ll}\p{N}]+|[\p{Lu}\p{N}]+(?![\p{Ll}])/gu)?.map(word => word.toLowerCase()) ?? [];
  return words.some((word, index) => secretWords.has(word) || (word === 'key' && index > 0 && keyQualifiers.has(words[index - 1])));
}

/** Copies a row or document with every secret-named field, at any depth, replaced by [REDACTED]. */
export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, looksSecret(name) ? redacted : redactDeep(inner)]));
  }
  return value;
}

/** Replaces every literal in a command document with "?", keeping field names and operators (OpenTelemetry db.query.text). */
export function sanitizeDocument(value) {
  if (Array.isArray(value)) return value.map(sanitizeDocument);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, sanitizeDocument(inner)]));
  }
  return '?';
}

/** Builds a level "Db" log entry. `message` is the OpenTelemetry span name: "<operation> <target>". */
export function dbLog({ system, operation, target, namespace, statement, rowsAffected, blocked, error, elapsedMs }) {
  const db = { system, operation };
  if (target !== undefined) db.target = target;
  if (namespace !== undefined) db.namespace = namespace;
  if (statement !== undefined) db.statement = statement;
  if (rowsAffected !== undefined) db.rowsAffected = rowsAffected;
  if (blocked) db.blocked = true;
  if (error) db.error = error;
  const entry = { level: 'Db', message: target ? `${operation} ${target}` : operation, db };
  if (elapsedMs !== undefined) entry.elapsedMs = Math.max(0, elapsedMs);
  return entry;
}

/** Appends a log entry to the current capture, if any. */
export function record(entry) {
  captureScope()?.logs.push(entry);
}

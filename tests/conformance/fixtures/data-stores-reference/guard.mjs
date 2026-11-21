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
const tables = { redis: table('redis'), mongodb: table('mongodb'), dynamodb: table('dynamodb') };
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
};

/** Display names used in "Preview unavailable: this operation writes to <Store>". */
export const storeNames = { mongodb: 'MongoDB', redis: 'Redis', dynamodb: 'DynamoDB' };

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

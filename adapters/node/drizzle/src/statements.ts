import { performance } from 'node:perf_hooks';
import { currentCapture } from '@test-bench/core';
import { is, Placeholder } from 'drizzle-orm';
import type { DrizzleDialect } from './metadata.js';
import { endedMessage, isInternal, parameterNames } from './scope.js';
import type { Scope } from './scope.js';

/** The parts of a Drizzle session this module relies on. They are stable across 0.45 drivers. */
export interface SessionLike {
  prepareQuery(...args: unknown[]): unknown;
}

interface CompiledQuery {
  sql: string;
  params: unknown[];
}

type PreparedMethod = (...args: unknown[]) => unknown;

const sessionScopes = new WeakMap<object, Scope>();
const instrumented = new WeakSet<object>();

/** Statements that would end the transaction a Preview must roll back. Savepoints stay allowed. */
const transactionControl =
  /^(?:begin|start\s+transaction|commit|end|abort|rollback(?!\s+to\b)|prepare\s+transaction|xa)\b/i;
/** MySQL statements that commit the open transaction implicitly. Temporary tables are exempt. */
const implicitCommit = new RegExp('^(?:create|alter|drop|rename|truncate|grant|revoke|install|uninstall|' +
  'lock\\s+tables?|unlock\\s+tables?|load\\s+(?:data|xml)|flush|reset|analyze|optimize|repair|cache\\s+index|' +
  'set\\s+(?:(?:session|local)\\s+|@@(?:session\\.|local\\.)?)?autocommit)\\b', 'i');
const temporaryTable = /^(?:create|drop)\s+temporary\s+table\b/i;
const mutation = /^\s*(?:insert|update|delete|replace|merge)\b/i;

/**
 * Record each statement a session runs in the active capture, and refuse statements that would
 * end a Preview transaction or run on a transaction whose callback has already settled.
 *
 * Instrumenting a session is idempotent. `scope` binds a transaction session to its provider scope;
 * a session shared by nested savepoints keeps the binding of the transaction that created it.
 */
export function instrumentSession(session: SessionLike, dialect: DrizzleDialect, scope?: Scope): () => void {
  if (scope && !sessionScopes.has(session)) sessionScopes.set(session, scope);
  if (instrumented.has(session)) return () => {};
  const hadOwn = Object.hasOwn(session, 'prepareQuery');
  const original = session.prepareQuery;
  session.prepareQuery = function prepareQuery(this: SessionLike, ...args: unknown[]): unknown {
    const prepared = original.apply(this, args);
    wrapPrepared(prepared as Record<string, unknown>, args[0] as CompiledQuery, session, dialect);
    return prepared;
  };
  instrumented.add(session);
  return () => {
    if (hadOwn) session.prepareQuery = original;
    else delete (session as Partial<SessionLike>).prepareQuery;
    instrumented.delete(session);
  };
}

function wrapPrepared(prepared: Record<string, unknown>, query: CompiledQuery, session: object, dialect: DrizzleDialect): void {
  for (const name of dialect === 'postgresql' ? ['execute', 'all'] : ['execute']) {
    const method = prepared[name];
    if (typeof method !== 'function') continue;
    prepared[name] = async function run(...args: unknown[]): Promise<unknown> {
      if (isInternal()) return (method as PreparedMethod).apply(prepared, args);
      guard(query.sql, session, dialect);
      const recorder = currentCapture();
      if (!recorder) return (method as PreparedMethod).apply(prepared, args);
      const names = parameterNames();
      const values = fill(query.params, args[0]);
      const start = performance.now();
      const record = (rowsAffected?: number) => recorder.sql({
        text: query.sql,
        elapsedMs: performance.now() - start,
        parameters: values.map((value, index) => ({
          name: names?.[index] ?? '$' + (index + 1),
          // A positional value has no name for the redaction rules to inspect, so only labelled ones pass through.
          value: names?.[index] === undefined ? '[REDACTED]' : value,
          dbType: dbType(value),
        })),
        ...(rowsAffected === undefined ? {} : { rowsAffected }),
      });
      try {
        const result = await (method as PreparedMethod).apply(prepared, args);
        record(mutation.test(query.sql) ? affectedRows(result) : undefined);
        return result;
      } catch (error) {
        record();
        throw error;
      }
    };
  }
}

/** Refuse a statement that would escape the transaction its session belongs to. */
function guard(text: string, session: object, dialect: DrizzleDialect): void {
  const scope = sessionScopes.get(session);
  if (!scope) return;
  if (!scope.open) throw new Error(endedMessage);
  if (!scope.preview) return;
  for (const statement of statementsOf(text)) {
    if (transactionControl.test(statement)
      || (dialect === 'mysql' && implicitCommit.test(statement) && !temporaryTable.test(statement))) {
      throw new Error('Preview owns the transaction and must roll it back, so "' + statement.slice(0, 40) +
        '" cannot run during Preview. Use client.transaction() for a nested unit of work.');
    }
  }
}

/** Split statement text on semicolons after removing comments. A literal containing `;` errs on the safe side. */
function statementsOf(text: string): string[] {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
    .split(';').map(part => part.trim()).filter(Boolean);
}

function fill(params: unknown[], placeholders: unknown): unknown[] {
  const values = (placeholders ?? {}) as Record<string, unknown>;
  return params.map(value => is(value, Placeholder) ? values[value.name] : value);
}

function dbType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Uint8Array) return 'blob';
  if (value instanceof Date) return 'date';
  return typeof value;
}

/** Rows a mutation changed, read from whichever result shape the driver returns. */
function affectedRows(result: unknown): number | undefined {
  if (Array.isArray(result)) {
    const header: unknown = result[0];
    if (header && typeof header === 'object' && 'affectedRows' in header) return Number(header.affectedRows);
    const count = (result as { count?: unknown }).count;
    return typeof count === 'number' ? count : result.length;
  }
  if (result && typeof result === 'object') {
    for (const name of ['rowCount', 'affectedRows', 'changes']) {
      const value = (result as Record<string, unknown>)[name];
      if (typeof value === 'number' || typeof value === 'bigint') return Number(value);
    }
  }
  return undefined;
}

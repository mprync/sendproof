import { performance } from 'node:perf_hooks';
import { currentCapture, refusedStatement, rollsBackTransaction } from '@sendproof/core';
import { is, Placeholder } from 'drizzle-orm';
import type { DrizzleDialect } from './metadata.js';
import { currentScope, endedMessage, isInternal, parameterNames } from './scope.js';
import type { Outcome, Scope } from './scope.js';

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
      const outcome = sessionScopes.get(session)?.outcome;
      if (isInternal()) {
        // The provider's own reads still note a deadlock, so the write they precede is refused.
        try {
          return await (method as PreparedMethod).apply(prepared, args);
        } catch (error) {
          if (outcome) noteError(outcome, dialect, error);
          throw error;
        }
      }
      guard(query.sql, session, dialect);
      return outcome ? watch(outcome, dialect, () => send(args)) : send(args);
    };
    const send = async (args: unknown[]): Promise<unknown> => {
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

/**
 * Run one Preview statement, refusing it when the database already rolled the Preview transaction back: after a
 * deadlock or lock wait timeout a statement would run with autocommit and commit for real. The handler still gets the
 * database's own error for the statement that hit it.
 */
async function watch(outcome: Outcome, dialect: DrizzleDialect, send: () => Promise<unknown>): Promise<unknown> {
  if (outcome.broken) {
    throw new Error('The database rolled the Preview transaction back after a deadlock or lock wait timeout, so no further statement runs in this Preview.');
  }
  try {
    return await send();
  } catch (error) {
    noteError(outcome, dialect, error);
    throw error;
  }
}

function noteError(outcome: Outcome, dialect: DrizzleDialect, error: unknown): void {
  if (rollsBackTransaction(error, dialect)) outcome.broken = true;
  outcome.onError?.(error);
}

/** Refuse a statement that would escape the transaction its session belongs to. */
function guard(text: string, session: object, dialect: DrizzleDialect): void {
  const scope = sessionScopes.get(session);
  if (!scope) return;
  if (!scope.open) throw new Error(endedMessage);
  if (scope.held) {
    const caller = currentScope();
    if (!caller?.open || !caller.step || caller.step !== scope.held.active) throw new Error(endedMessage);
  }
  if (!scope.preview) return;
  // The shared classifier also covers MySQL's implicit commits, CALL and executable comments.
  const statement = refusedStatement(text, dialect, scope.safeProcedures);
  if (statement === undefined) return;
  // The Preview fails even if the operation catches this error.
  if (scope.outcome) scope.outcome.refused = true;
  throw new Error('Preview owns the transaction and must roll it back, so "' + statement.slice(0, 40) +
    '" cannot run during Preview. Use client.transaction() for a nested unit of work.');
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

import { performance } from 'node:perf_hooks';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { currentCapture } from '@sendproof/core';

/** Named bindings, for example `{ id: 'A1' }` for `:id`. */
export type NamedBindings = Record<string, SQLInputValue>;

/** Bindings accepted by a statement: named, or positional for query builders. */
export type Bindings = NamedBindings | readonly SQLInputValue[];

/** How a statement is run against the connection. */
export type StatementMethod = 'get' | 'all' | 'run';

/** Statements the guarded `get` and `all` accept. */
export const allowedRead = /^\s*SELECT\b/i;

/** Statements the guarded `write` accepts. */
export const allowedWrite = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Quote a plain SQLite identifier. Anything else is rejected rather than escaped. */
export function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new TypeError('Use a plain SQLite identifier.');
  return '"' + value + '"';
}

function dbType(value: unknown): string {
  return value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value;
}

/**
 * Run one prepared statement and record it in the active capture.
 *
 * Positional bindings are always redacted because the statement gives them no name for the
 * redaction rules to inspect. Named bindings are passed to the capture, which redacts secret
 * names and, unless the framework adapter enables parameter values, every value.
 */
export function execute(
  connection: DatabaseSync,
  method: StatementMethod,
  text: string,
  bindings: Bindings,
  arrayRows = false,
  captureSql = true,
): unknown {
  const start = performance.now();
  const statement = connection.prepare(text);
  if (arrayRows) statement.setReturnArrays(true);
  const positional = Array.isArray(bindings);
  const result: unknown = positional
    ? statement[method](...(bindings as readonly SQLInputValue[]))
    : statement[method](bindings as NamedBindings);
  const capture = captureSql ? currentCapture() : undefined;
  capture?.sql({
    text,
    elapsedMs: performance.now() - start,
    parameters: Object.entries(bindings).map(([name, value]) => ({
      name: positional ? '$' + (Number(name) + 1) : name,
      value: positional ? '[REDACTED]' : value,
      dbType: dbType(value),
    })),
    ...(method === 'run' ? { rowsAffected: (result as { changes: number | bigint }).changes } : {}),
  });
  return result;
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Change } from '@sendproof/core';

/** A transaction opened through the provider, alive while its callback runs. */
export interface Scope {
  /** The Drizzle transaction object that statements in this scope run on. */
  target: object;
  /** Whether the outermost transaction is a Preview, which always rolls back. */
  preview: boolean;
  /** False once the callback has settled. Later statements fail rather than escape the transaction. */
  open: boolean;
  /**
   * Changes held until the transaction settles: passed on when it commits or its savepoint is
   * released, and dropped when it rolls back, so the capture never shows rows that were undone.
   */
  changes?: Change[];
  /** Set when the Preview refused a statement that would have ended its transaction. */
  refused?: boolean;
  /** MySQL stored procedures the host declared never commit; every other `CALL` is refused in a Preview. */
  safeProcedures?: ReadonlySet<string>;
}

export const endedMessage = 'The Drizzle transaction has ended.';

const scopes = new AsyncLocalStorage<Scope>();
const internal = new AsyncLocalStorage<boolean>();
const labels = new AsyncLocalStorage<readonly string[]>();

/** The innermost provider transaction of the calling context. */
export function currentScope(): Scope | undefined {
  return scopes.getStore();
}

/** Report a change: to the innermost transaction holding changes, otherwise straight to the capture. */
export function report(change: Change, deliver: (change: Change) => void): void {
  const held = scopes.getStore()?.changes;
  if (held) held.push(change);
  else deliver(change);
}

export function inScope<T>(scope: Scope, callback: () => T): T {
  return scopes.run(scope, callback);
}

/**
 * Whether the provider itself issued the current statement: a snapshot read or the transaction
 * control around a callback. Such statements are left out of the SQL log and bypass the guards.
 */
export function isInternal(): boolean {
  return internal.getStore() === true;
}

export function asInternal<T>(callback: () => T): T {
  return internal.run(true, callback);
}

/** Return to application context inside a provider-issued operation, such as a transaction callback. */
export function asCaller<T>(callback: () => T): T {
  return internal.run(false, callback);
}

/** Names for the positional parameters of the statements in `callback`. */
export function parameterNames(): readonly string[] | undefined {
  return labels.getStore();
}

export function withLabels<T>(names: readonly string[], callback: () => T): T {
  return labels.run([...names], callback);
}

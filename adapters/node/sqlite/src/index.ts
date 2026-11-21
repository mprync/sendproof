import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from 'node:sqlite';
import { endsTransaction, refuseInPreview } from '@sendproof/core';
import type { PreviewProvider } from '@sendproof/core';
import { defaultTrackedKeyLimit, trackRows } from './rows.js';
import type { Row, RowKey, TrackedRows } from './rows.js';
import { allowedRead, allowedWrite, execute } from './statements.js';
import type { NamedBindings } from './statements.js';

export type { Row, RowKey, TrackedRows } from './rows.js';
export type { NamedBindings } from './statements.js';

/** Settings for a {@link SQLiteDatabase}. */
export interface SQLiteOptions {
  /** SQL run once when the database opens, typically `CREATE TABLE IF NOT EXISTS` statements. */
  schema?: string;
  /** Milliseconds SQLite waits on a locked database before reporting `SQLITE_BUSY`. Defaults to 0. */
  busyTimeoutMs?: number;
  /**
   * Times an outermost transaction is attempted again after `SQLITE_BUSY` or `SQLITE_LOCKED`.
   * Defaults to 0. Preview retries only the lock acquisition. {@link SQLiteDatabase.transaction}
   * also runs its callback again, so the callback must be safe to repeat.
   */
  retries?: number;
  /** Delay before the first retry in milliseconds. It doubles on each further attempt. Defaults to 20. */
  retryDelayMs?: number;
  /**
   * Most keys snapshotted for one statement. A longer key list marks the captured changes as
   * truncated and the statement still runs. Defaults to 500.
   */
  trackedKeyLimit?: number;
}

/** Row access mode of {@link SQLiteDatabase.queryRows}. */
export type RowMode = 'all' | 'get' | 'values' | 'run';

/** One transaction or savepoint, alive while its callback runs. */
interface Scope {
  open: boolean;
  /** 0 for an outermost transaction, 1 for a savepoint inside it, and so on. */
  depth: number;
  /** Serializes savepoints opened from this scope, because savepoints must nest strictly. */
  children: Promise<void>;
}

const noScopeMessage = 'The SQLite preview transaction has ended.';

/**
 * The error for a statement the guarded methods don't accept. A statement that would end the
 * transaction (a raw `COMMIT`, `ROLLBACK` or `BEGIN`) also records a fault on the current Preview,
 * so the Preview answers 500 without confirmation even if the operation catches this error.
 */
function rejected(text: string, message: string): Error {
  if (endsTransaction(text, 'sqlite')) {
    const refusal = refuseInPreview('Preview owns the SQLite transaction, so "' + text.trim().slice(0, 40) + '" cannot run during Preview.');
    if (refusal) return refusal;
  }
  return new TypeError(message);
}

/** SQLite reports lock contention as `SQLITE_BUSY` (5) or `SQLITE_LOCKED` (6), possibly extended. */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/**
 * A request-scoped SQLite connection with guarded transactional writes and row snapshots.
 *
 * Preview wraps the operation in `BEGIN IMMEDIATE` and `ROLLBACK`. {@link transaction} gives the
 * application the same shape for real work: it commits at the outermost level, and a nested call
 * becomes a savepoint. A released savepoint is retained, so its writes stay in the enclosing
 * transaction and a Preview rollback still discards them. A failed savepoint rolls back alone.
 */
export class SQLiteDatabase implements PreviewProvider {
  readonly #connection: DatabaseSync;
  readonly #scope = new AsyncLocalStorage<Scope>();
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #trackedKeyLimit: number;
  #queue: Promise<void> = Promise.resolve();
  #savepoints = 0;

  /** Schema installation runs once when opening a new fixture or application database. */
  constructor(filename: string, options: SQLiteOptions = {}) {
    const { schema, busyTimeoutMs = 0, retries = 0, retryDelayMs = 20, trackedKeyLimit = defaultTrackedKeyLimit } = options;
    for (const [name, value] of Object.entries({ busyTimeoutMs, retries, retryDelayMs, trackedKeyLimit })) {
      if (!Number.isInteger(value) || value < 0) throw new RangeError(name + ' must be a non-negative integer.');
    }
    this.#retries = retries;
    this.#retryDelayMs = retryDelayMs;
    this.#trackedKeyLimit = trackedKeyLimit;
    this.#connection = new DatabaseSync(filename, { timeout: busyTimeoutMs });
    try {
      if (schema) this.#connection.exec(schema);
    } catch (error) {
      this.#connection.close();
      throw error;
    }
  }

  /** Nesting depth of the calling context: 0 outside a transaction, 1 inside one, 2 in a savepoint. */
  get depth(): number {
    const scope = this.#scope.getStore();
    return scope?.open ? scope.depth + 1 : 0;
  }

  /** Run `callback` on the connection, queueing behind other leases unless inside a transaction. */
  async #access<T>(callback: (connection: DatabaseSync) => T | Promise<T>): Promise<T> {
    const active = this.#scope.getStore();
    if (active) {
      if (!active.open) throw new Error(noScopeMessage);
      return callback(this.#connection);
    }

    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      return await callback(this.#connection);
    } finally {
      release();
    }
  }

  /** Read one row. Accepts a SELECT statement. */
  async get(text: string, bindings: NamedBindings = {}): Promise<Row | undefined> {
    if (!allowedRead.test(text)) throw rejected(text, 'get accepts a SELECT statement.');
    return this.#access(connection => execute(connection, 'get', text, bindings) as Row | undefined);
  }

  /** Read every matching row. Accepts a SELECT statement. */
  async all(text: string, bindings: NamedBindings = {}): Promise<Row[]> {
    if (!allowedRead.test(text)) throw rejected(text, 'all accepts a SELECT statement.');
    return this.#access(connection => execute(connection, 'all', text, bindings) as Row[]);
  }

  /** Track a mutation by its stable primary key. Supply the key for each row the statement affects. */
  async write(text: string, bindings: NamedBindings = {}, changes: TrackedRows = { table: '' }): Promise<StatementResultingChanges> {
    if (!allowedWrite.test(text)) {
      throw rejected(text, 'write accepts an INSERT, UPDATE, DELETE or REPLACE statement.');
    }
    return this.#access(connection => trackRows(connection, changes, this.#trackedKeyLimit,
      () => execute(connection, 'run', text, bindings) as StatementResultingChanges));
  }

  /** Connect a positional, array-row query builder. Set `captureSql` to false for its inspection reads. */
  async queryRows(
    text: string,
    bindings: readonly SQLInputValue[],
    method: RowMode,
    changes: TrackedRows = { table: '' },
    captureSql = true,
  ): Promise<SQLOutputValue[] | SQLOutputValue[][] | undefined> {
    if (!['all', 'get', 'values', 'run'].includes(method) || !(allowedRead.test(text) || allowedWrite.test(text))) {
      throw rejected(text, 'Supply a SELECT or data mutation with a supported row mode.');
    }
    return this.#access(connection => {
      const run = () => execute(connection, method === 'values' ? 'all' : method, text, bindings, method !== 'run',
        captureSql || allowedWrite.test(text));
      const result = allowedWrite.test(text) ? trackRows(connection, changes, this.#trackedKeyLimit, run) : run();
      return method === 'run' ? [] : (result as SQLOutputValue[] | SQLOutputValue[][] | undefined);
    });
  }

  /**
   * Run `callback` in a transaction that commits when it resolves and rolls back when it rejects.
   *
   * Inside an existing transaction, including a Preview, the call opens a savepoint instead. The
   * savepoint is released on success so its writes stay in the enclosing transaction, and it rolls
   * back alone on failure, leaving the enclosing transaction usable.
   */
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const parent = this.#scope.getStore();
    if (!parent) return this.#outermost(callback, 'commit');
    if (!parent.open) throw new Error(noScopeMessage);
    return this.#savepoint(parent, callback);
  }

  /** Run `dispatch` in a transaction that is always rolled back, resolving only after rollback. */
  async preview<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.#scope.getStore()) throw new Error('Nested SQLite previews are unavailable.');
    return this.#outermost(dispatch, 'rollback');
  }

  /** Close the connection. A transaction callback cannot close its own connection. */
  async close(): Promise<void> {
    if (this.#scope.getStore()) throw new Error('Cannot close the connection from a preview.');
    return this.#access(connection => connection.close());
  }

  /** Lease the connection and run the outermost transaction, retrying on lock contention. */
  async #outermost<T>(callback: () => Promise<T>, ending: 'commit' | 'rollback'): Promise<T> {
    return this.#access(async connection => {
      for (let attempt = 0; ; attempt++) {
        let began = false;
        try {
          return await this.#attempt(connection, callback, ending, () => { began = true; });
        } catch (error) {
          // A Preview callback is a whole request: never run it twice. Only a failed lock is safe to retry.
          const retryable = isBusy(error) && (!began || ending === 'commit');
          if (!retryable || attempt >= this.#retries) throw error;
          await delay(this.#retryDelayMs * 2 ** attempt);
        }
      }
    });
  }

  async #attempt<T>(
    connection: DatabaseSync,
    callback: () => Promise<T>,
    ending: 'commit' | 'rollback',
    began: () => void,
  ): Promise<T> {
    connection.exec('BEGIN IMMEDIATE');
    began();
    const scope: Scope = { open: true, depth: 0, children: Promise.resolve() };
    let result: T;
    try {
      result = await this.#scope.run(scope, callback);
    } catch (error) {
      scope.open = false;
      this.#abandon(connection, error);
      throw error;
    }
    scope.open = false;
    if (!connection.isTransaction) {
      throw new Error('The operation completed the SQLite transaction before it could be ' +
        (ending === 'commit' ? 'committed.' : 'rolled back.'));
    }
    try {
      connection.exec(ending === 'commit' ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      this.#abandon(connection, error);
      throw error;
    }
    return result;
  }

  /** Roll back after a failure. A rollback that itself fails replaces the original error. */
  #abandon(connection: DatabaseSync, original: unknown): void {
    if (!connection.isTransaction) return;
    try {
      connection.exec('ROLLBACK');
    } catch (cause) {
      throw new Error('SQLite did not confirm the rollback.', { cause: new AggregateError([original, cause]) });
    }
  }

  async #savepoint<T>(parent: Scope, callback: () => Promise<T>): Promise<T> {
    const previous = parent.children;
    let release!: () => void;
    parent.children = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (!parent.open) throw new Error(noScopeMessage);
      const connection = this.#connection;
      const name = 'tb_savepoint_' + ++this.#savepoints;
      connection.exec('SAVEPOINT ' + name);
      const scope: Scope = { open: true, depth: parent.depth + 1, children: Promise.resolve() };
      let result: T;
      try {
        result = await this.#scope.run(scope, callback);
      } catch (error) {
        scope.open = false;
        if (connection.isTransaction) {
          connection.exec('ROLLBACK TO ' + name);
          connection.exec('RELEASE ' + name);
        }
        throw error;
      }
      scope.open = false;
      connection.exec('RELEASE ' + name);
      return result;
    } finally {
      release();
    }
  }
}

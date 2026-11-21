import type { Knex } from 'knex';

/** A primary key column value. */
export type KeyValue = string | number | bigint | boolean | Date | Buffer;

/**
 * The primary key of one row. A bare value names the row of a single-column key. A composite key
 * is an object holding every key column, and no other column.
 */
export type RowKey = KeyValue | Readonly<Record<string, KeyValue>>;

/** The rows a mutation affects, identified by table and primary key. */
export interface TrackedRows<Result = unknown> {
  /** Table name, optionally schema qualified as `schema.table`. */
  table: string;
  /** Keys of rows that exist before the mutation: updates, deletes and inserts of known keys. */
  keys?: readonly RowKey[];
  /**
   * Keys that only exist after the mutation, such as generated identifiers read from the result.
   * Their rows are recorded as inserts.
   */
  insertedKeys?: (result: Result) => readonly RowKey[];
  /** Primary key columns, for a view or a table whose key cannot be read from the schema. */
  primaryKey?: readonly string[];
}

/** The database family Knex talks to, as the provider distinguishes it. */
export type Dialect = 'sqlite' | 'postgresql' | 'mysql' | 'mssql' | 'other';

/** Settings for a {@link KnexPreview}. */
export interface KnexPreviewOptions {
  /**
   * Most keys snapshotted for one mutation. A longer list marks the captured changes as
   * truncated and the mutation still runs. Defaults to 500.
   */
  trackedKeyLimit?: number;
  /**
   * Times an outermost {@link KnexPreview.transaction} runs again after a deadlock, serialization
   * failure or lock timeout. Defaults to 0. The callback runs again, so it must be safe to repeat.
   */
  retries?: number;
  /** Delay before the first retry in milliseconds. It doubles on each further attempt. Defaults to 25. */
  retryDelayMs?: number;
}

/** Options of {@link KnexPreview.transaction}. */
export interface TransactionOptions {
  /** Isolation level of an outermost transaction. A savepoint inherits its parent's level. */
  isolationLevel?: Knex.IsolationLevels;
}

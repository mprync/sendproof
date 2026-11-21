import type { PreviewProvider } from '@sendproof/core';
import type { SQLiteDatabase, TrackedRows } from '@sendproof/sqlite';
import { sql } from 'drizzle-orm';
import type { MySqlDatabase } from 'drizzle-orm/mysql-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { DatabaseLike, ProviderState, SQLiteConnection } from './capture.js';
import { createClient } from './client.js';
import { dialectOf } from './metadata.js';
import type { DrizzleDialect } from './metadata.js';
import { asCaller, asInternal, currentScope, inScope, isInternal, withLabels } from './scope.js';
import { PreviewTurns } from './turns.js';
import type { Scope } from './scope.js';
import { instrumentSession } from './statements.js';

export type { DrizzleDialect } from './metadata.js';
export type { TrackedRows } from '@sendproof/sqlite';

/** Settings shared by every dialect. */
export interface DrizzlePreviewOptions {
  /**
   * Most rows snapshotted for one statement. A statement affecting more rows still runs, and the
   * captured changes are marked as truncated. Defaults to 500.
   */
  trackedRowLimit?: number;
}

/** Settings for the SQLite client the provider creates over `@sendproof/sqlite`. */
export interface SQLiteDrizzleOptions<Tables extends Record<string, unknown>> extends DrizzlePreviewOptions {
  /** Tables and relations for Drizzle's relational query API. */
  schema?: Tables;
}

/** Drizzle databases on a PostgreSQL or MySQL driver that holds one connection per transaction. */
// Drizzle's database classes are generic over driver and schema types the provider does not inspect.
export type ServerDatabase = PgDatabase<any, any, any> | MySqlDatabase<any, any, any, any>;

/** A Preview provider for Drizzle, with the client the application uses for its queries. */
export interface DrizzlePreview<Database> extends PreviewProvider {
  /**
   * The application's Drizzle client. Use it for every query in operations that support Preview.
   * Inside a Preview or `client.transaction()` it runs on that transaction. Inserts, updates and
   * deletes it builds report their row changes, identified by the table's primary key.
   */
  readonly client: Database;
  readonly dialect: DrizzleDialect;
  /** Run `dispatch` in a transaction that is always rolled back, resolving only after the rollback. */
  preview<T>(dispatch: () => Promise<T>): Promise<T>;
  /**
   * Name the positional parameters of the statements `query` runs, so the SQL log can show them.
   * The capture still redacts secret-looking names, and all values unless parameter values are
   * enabled. Unnamed parameters are always redacted. Not available for SQLite, whose connection
   * records its own statements.
   */
  withParameterNames<T>(names: readonly string[], query: () => T): Promise<Awaited<T>>;
  /**
   * Run `mutate`. Row keys are now read from the Drizzle table definition, so `rows` is ignored.
   * @deprecated Call the mutation directly.
   */
  track<T>(rows: TrackedRows, mutate: () => T): Promise<Awaited<T>>;
  /** Stop recording the application database's statements. The database stays open. */
  dispose(): void;
}

/**
 * Create a Preview provider for a Drizzle database.
 *
 * For PostgreSQL and MySQL, pass the application's Drizzle database: `node-postgres` over a `Pool`,
 * `postgres`, PGlite, or `mysql2` over a pool. For SQLite, pass a `@sendproof/sqlite` database;
 * the provider creates the Drizzle client over that connection.
 */
export function drizzlePreview<Tables extends Record<string, unknown> = Record<string, never>>(
  database: SQLiteDatabase,
  options?: SQLiteDrizzleOptions<Tables>,
): DrizzlePreview<SqliteRemoteDatabase<Tables>>;
export function drizzlePreview<Database extends ServerDatabase>(
  database: Database,
  options?: DrizzlePreviewOptions,
): DrizzlePreview<Database>;
export function drizzlePreview(
  database: SQLiteDatabase | ServerDatabase,
  options: SQLiteDrizzleOptions<Record<string, unknown>> = {},
): DrizzlePreview<unknown> {
  const { trackedRowLimit = 500 } = options;
  if (!Number.isInteger(trackedRowLimit) || trackedRowLimit < 0) {
    throw new RangeError('trackedRowLimit must be a non-negative integer.');
  }
  if (isSQLiteConnection(database)) return sqliteProvider(database, options.schema, trackedRowLimit);

  const dialect = dialectOf(database);
  if (dialect === 'sqlite') {
    throw new TypeError('For SQLite, pass a @sendproof/sqlite SQLiteDatabase; drizzlePreview creates the Drizzle client over it.');
  }
  if (!dialect) throw new TypeError('drizzlePreview accepts a Drizzle PostgreSQL or MySQL database or a @sendproof/sqlite SQLiteDatabase.');
  requireDedicatedConnections(dialect, database);

  const base = database as unknown as DatabaseLike;
  const state: ProviderState = { dialect, base, trackedRowLimit };
  const restore = instrumentSession(base.session, dialect);
  // MySQL previews take turns: concurrent rolled-back inserts of one key would deadlock (see PreviewTurns).
  const turns = dialect === 'mysql' ? new PreviewTurns() : undefined;
  return {
    client: createClient(state),
    dialect,
    system: dialect,
    preview: dispatch => preview(state, dispatch, turns),
    withParameterNames: (names, query) => withLabels(names, () => settle(query)),
    track: (_rows, mutate) => settle(mutate),
    dispose: restore,
  };
}

/** Run a callback and wait for its value. */
async function settle<T>(callback: () => T): Promise<Awaited<T>> {
  return await callback();
}

function isSQLiteConnection(database: unknown): database is SQLiteConnection {
  const candidate = database as Partial<SQLiteConnection> | null;
  return typeof candidate?.queryRows === 'function' && typeof candidate.preview === 'function';
}

function sqliteProvider(
  database: SQLiteConnection,
  schema: Record<string, unknown> | undefined,
  trackedRowLimit: number,
): DrizzlePreview<unknown> {
  const proxy = drizzle(async (text, parameters, method) => ({
    rows: await database.queryRows(text, parameters, method, undefined, !isInternal()) as unknown[],
  }), schema ? { schema } : {});
  const state: ProviderState = { dialect: 'sqlite', base: proxy as unknown as DatabaseLike, sqlite: database, trackedRowLimit };
  return {
    client: createClient(state),
    dialect: 'sqlite',
    system: 'sqlite',
    // Await inside the transaction: a returned query builder only runs when awaited.
    preview: dispatch => database.preview(async () => await dispatch()),
    withParameterNames: (_names, query) => settle(query),
    track: (_rows, mutate) => settle(mutate),
    dispose: () => {},
  };
}

/**
 * Refuse a driver that runs every transaction on one shared connection. Concurrent requests would
 * then run inside the Preview transaction and be rolled back with it.
 */
function requireDedicatedConnections(dialect: DrizzleDialect, database: object): void {
  const client = (database as { $client?: unknown }).$client;
  if (!client || typeof client !== 'object') return;
  if (dialect === 'mysql' && !('getConnection' in client)) {
    throw new TypeError('Create the Drizzle MySQL database over a mysql2 pool, so each transaction has its own connection.');
  }
  if (dialect === 'postgresql' && 'connectionParameters' in client && !('totalCount' in client)) {
    throw new TypeError('Create the Drizzle PostgreSQL database over a pg Pool, so each transaction has its own connection.');
  }
}

class PreviewRollback extends Error {
  constructor() {
    super('Preview rollback');
  }
}

async function preview<T>(state: ProviderState, dispatch: () => Promise<T>, turns?: PreviewTurns): Promise<T> {
  if (currentScope()?.preview) throw new Error('Nested Drizzle previews are unavailable.');
  return turns ? turns.run(() => previewNow(state, dispatch)) : previewNow(state, dispatch);
}

/** Run one Preview in a transaction that always rolls back, resolving only after the rollback. */
async function previewNow<T>(state: ProviderState, dispatch: () => Promise<T>): Promise<T> {
  const rollback = new PreviewRollback();
  let outcome: { value: T } | undefined;
  let opened: Scope | undefined;
  try {
    // Drizzle rethrows the error only after its ROLLBACK succeeds, which confirms the rollback.
    await asInternal(() => state.base.transaction(async transaction => {
      const scope: Scope = { target: transaction, preview: true, open: true };
      opened = scope;
      instrumentSession(transaction.session, state.dialect, scope);
      try {
        outcome = { value: await asCaller(() => inScope(scope, async () => await dispatch())) };
      } finally {
        scope.open = false;
      }
      if (state.dialect === 'postgresql') await confirmOpen(transaction);
      throw rollback;
    }));
  } catch (error) {
    if (error !== rollback) throw error;
  }
  // Rolled back, but the operation tried to end the transaction itself: never confirm that Preview.
  if (opened?.refused) throw new Error('The Drizzle preview was not contained: the operation tried to end the Preview transaction.');
  if (!outcome) throw new Error('Drizzle did not run the Preview operation.');
  return outcome.value;
}

/**
 * PostgreSQL only warns when ROLLBACK runs outside a transaction, so check the transaction is still
 * open first. A failed transaction (SQLSTATE 25P02) is open and rolls back normally.
 */
async function confirmOpen(transaction: DatabaseLike): Promise<void> {
  const execute = transaction['execute'] as (query: unknown) => Promise<unknown>;
  try {
    await execute.call(transaction, sql`savepoint sendproof_preview_open`);
    await execute.call(transaction, sql`release savepoint sendproof_preview_open`);
  } catch (error) {
    if (sqlState(error) === '25P02') return;
    throw new Error('The operation ended the PostgreSQL transaction before Preview could roll it back.', { cause: error });
  }
}

function sqlState(error: unknown): unknown {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return value?.code ?? value?.cause?.code;
}

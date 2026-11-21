import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Knex } from 'knex';
import { currentCapture } from '@sendproof/core';
import type { Change, PreviewProvider } from '@sendproof/core';
import { dialectOf, isTransient, systemOf } from './dialect.js';
import { compareKeys, insertedRows, keysFromData, keysFromResult, normalizeKey, readPrimaryKey, rowsOf } from './keys.js';
import { guardPreview, resolveTable, trackClient } from './tracked.js';
import type { BuilderState, TableName } from './tracked.js';
import { PreviewTurns } from './turns.js';
import type { Dialect, KeyValue, KnexPreviewOptions, RowKey, TrackedRows, TransactionOptions } from './types.js';

export type { Dialect, KeyValue, KnexPreviewOptions, RowKey, TrackedRows, TransactionOptions } from './types.js';

/** One transaction or savepoint, alive while its callback runs. */
interface Scope {
  /** The transaction itself, for the provider's own reads. */
  connection: Knex.Transaction;
  /** The same transaction as the application sees it: mutations through it are tracked. */
  client: Knex.Transaction;
  active: boolean;
  /** Changes made in a savepoint, held until it is released so a rollback discards them too. */
  buffer?: Change[];
  parent?: Scope;
  /** Tracked mutations in one transaction run one at a time so each sees its own before and after. */
  tail: Promise<void>;
  /** 0 for an outermost transaction, 1 for a savepoint inside it, and so on. */
  depth: number;
  /** Set when a Preview refused a statement that would have ended its transaction. */
  refused?: boolean;
}

type Row = Record<string, unknown>;

/** Where a recorded change goes: the capture, or the buffer of the enclosing savepoint. */
type Emit = (change: Change) => void;

/** A row identified by key, with its state before the mutation (null when it did not exist). */
interface Entry {
  key: Record<string, KeyValue>;
  row: Row | null | undefined;
}

const defaultTrackedKeyLimit = 500;
const noScopeMessage = 'The Knex preview transaction has ended.';

/** Rows reach the capture as JSON. A bigint has no JSON form, so it becomes its decimal string. */
function plainRow(row: Row | undefined): Row | null {
  if (row === undefined) return null;
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() : value]));
}

function dbType(value: unknown): string {
  return value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value;
}

/**
 * Enlist Knex writes in a request-local transaction during Preview and capture tracked rows.
 *
 * Primary keys come from the database schema, so a tracked row is named by its key value alone.
 * PostgreSQL, MySQL, SQL Server and SQLite are supported. {@link transaction} gives the
 * application the same request-local shape for real work: nested calls become retained
 * savepoints, and a deadlock or serialization failure can be retried.
 */
export class KnexPreview implements PreviewProvider {
  /** The SQL provider id discovery reports as `database.system`, such as `postgresql`. */
  readonly system: string | undefined;
  readonly #database: Knex;
  readonly #dialect: Dialect;
  readonly #transaction = new AsyncLocalStorage<Scope>();
  readonly #names = new AsyncLocalStorage<readonly string[]>();
  readonly #internal = new AsyncLocalStorage<true>();
  readonly #keys = new Map<string, Promise<readonly string[]>>();
  readonly #pool: Knex;
  readonly #trackedKeyLimit: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  /** MySQL previews take turns: concurrent rolled-back inserts of one key would deadlock (see PreviewTurns). */
  readonly #turns: PreviewTurns | undefined;

  readonly #logQuery = (query: { sql: string; bindings?: readonly unknown[] }): void => {
    const recorder = currentCapture();
    if (!recorder || this.#internal.getStore()) return;
    const labels = this.#names.getStore();
    recorder.sql({
      text: query.sql,
      parameters: (query.bindings ?? []).map((value, index) => ({
        name: labels?.[index] ?? '$' + (index + 1),
        value: '[REDACTED]',
        dbType: dbType(value),
      })),
    });
  };

  constructor(database: Knex, options: KnexPreviewOptions = {}) {
    const { trackedKeyLimit = defaultTrackedKeyLimit, retries = 0, retryDelayMs = 25 } = options;
    for (const [name, value] of Object.entries({ trackedKeyLimit, retries, retryDelayMs })) {
      if (!Number.isInteger(value) || value < 0) throw new RangeError(name + ' must be a non-negative integer.');
    }
    this.#database = database;
    this.#pool = trackClient(database, (builder, state, execute) => this.#mutation(database, undefined, builder, state, execute));
    this.#dialect = dialectOf(database);
    this.system = systemOf(database);
    this.#turns = this.#dialect === 'mysql' ? new PreviewTurns() : undefined;
    this.#trackedKeyLimit = trackedKeyLimit;
    this.#retries = retries;
    this.#retryDelayMs = retryDelayMs;
    database.on('query', this.#logQuery);
  }

  /** The database family, read from the Knex client. */
  get dialect(): Dialect {
    return this.#dialect;
  }

  /** Nesting depth of the calling context: 0 outside a transaction, 1 inside one, 2 in a savepoint. */
  get depth(): number {
    const scope = this.#transaction.getStore();
    return scope?.active ? scope.depth + 1 : 0;
  }

  /**
   * The client for the current request: the preview or `transaction()` scope's connection, or the
   * pool outside both. Inserts, updates and deletes built from it are tracked automatically.
   */
  get client(): Knex {
    const scope = this.#transaction.getStore();
    if (!scope) return this.#pool;
    if (!scope.active) throw new Error(noScopeMessage);
    return scope.client;
  }

  /** The current request's connection without tracking. Use it for bulk loads that need no capture. */
  get untracked(): Knex {
    const scope = this.#transaction.getStore();
    if (!scope) return this.#database;
    if (!scope.active) throw new Error(noScopeMessage);
    return scope.connection;
  }

  /** Label Knex's positional bindings for a single awaited query. Values remain redacted. */
  withParameterNames<T>(names: readonly string[], execute: () => T | PromiseLike<T>): Promise<T> {
    return this.#names.run([...names], async () => execute());
  }

  /**
   * Capture before and after rows around a mutation whose rows you name yourself.
   *
   * Prefer building queries from {@link client}, which tracks them without being told which rows
   * they touch. Use this for mutations the client cannot describe, such as raw SQL. Name the rows
   * by primary key value, or by object for a composite key. A key that does not match the schema,
   * a table without a primary key and a list above the tracked key limit mark the captured
   * changes as truncated. The mutation always runs.
   */
  async track<Result>(rows: TrackedRows<Result>, mutate: (connection: Knex) => Result | PromiseLike<Result>): Promise<Result> {
    const recorder = currentCapture();
    const connection = this.untracked;
    const keys = rows.keys ?? [];
    if (!recorder || (keys.length === 0 && !rows.insertedKeys)) return mutate(connection);
    if (keys.length > this.#trackedKeyLimit) {
      recorder.truncate('changes');
      return mutate(connection);
    }

    const primaryKey = await this.#primaryKey(connection, rows);
    const identify = (key: RowKey): Record<string, KeyValue> | undefined => {
      const normalized = normalizeKey(key, primaryKey);
      if (!normalized) recorder.truncate('changes');
      return normalized;
    };
    const before: Entry[] = [];
    for (const key of keys) {
      const identified = identify(key);
      if (identified) before.push({ key: identified, row: await this.#snapshot(connection, rows.table, identified) });
    }

    const result = await mutate(connection);

    const created = (rows.insertedKeys?.(result) ?? []).flatMap(key => {
      const identified = identify(key);
      return identified ? [{ key: identified, row: null }] : [];
    });
    await this.#record(recorder, this.#emit(this.#transaction.getStore(), recorder), connection, rows.table, [...before, ...created]);
    return result;
  }

  /**
   * Run `callback` in a transaction that commits when it resolves and rolls back when it rejects.
   *
   * Inside an existing transaction, including a Preview, the call opens a savepoint. The savepoint
   * is released on success so its writes stay in the enclosing transaction, and it rolls back
   * alone on failure. `provider.client` is the transaction for the whole callback.
   */
  async transaction<T>(callback: (client: Knex.Transaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const parent = this.#transaction.getStore();
    if (parent) {
      if (!parent.active) throw new Error(noScopeMessage);
      return parent.connection.transaction(trx => this.#enter(trx, parent.depth + 1, callback, parent));
    }
    const config: Knex.TransactionConfig = options.isolationLevel ? { isolationLevel: options.isolationLevel } : {};
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#database.transaction(trx => this.#enter(trx, 0, callback), config);
      } catch (error) {
        if (!isTransient(error) || attempt >= this.#retries) throw error;
        await delay(this.#retryDelayMs * 2 ** attempt);
      }
    }
  }

  /** Run `dispatch` in a transaction that is always rolled back, resolving only after rollback. */
  async preview<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.#transaction.getStore()) throw new Error('Nested Knex previews are unavailable.');
    return this.#turns ? this.#turns.run(() => this.#previewNow(dispatch)) : this.#previewNow(dispatch);
  }

  /** Run one Preview: open its transaction, dispatch, then roll back and confirm the rollback. */
  async #previewNow<T>(dispatch: () => Promise<T>): Promise<T> {
    const connection = await this.#database.transaction(undefined as never, { doNotRejectOnRollback: true });
    const completion = connection.executionPromise.then(() => true as const, (error: unknown) => ({ error }));
    const scope = this.#scope(connection, 0, undefined, true);
    try {
      return await this.#transaction.run(scope, dispatch);
    } finally {
      scope.active = false;
      if (connection.isCompleted()) {
        throw new Error('The operation completed the Knex transaction before Preview could roll it back.');
      }
      await connection.rollback();
      const outcome = await completion;
      if (outcome !== true) throw new Error('Knex did not acknowledge the rollback.', { cause: outcome.error });
      // Rolled back, but the operation tried to end the transaction itself: never confirm that Preview.
      if (scope.refused) throw new Error('The Knex preview was not contained: the operation tried to end the Preview transaction.');
    }
  }

  /** Remove the SQL listener while leaving the host's connection pool open. */
  dispose(): void {
    this.#database.off('query', this.#logQuery);
  }

  /** Forget the primary keys read from the schema, for one table or all of them. */
  forgetSchema(table?: string): void {
    if (table === undefined) this.#keys.clear();
    else this.#keys.delete(table);
  }

  /** Changes inside a savepoint wait in its buffer until the savepoint is released. */
  #emit(scope: Scope | undefined, recorder: NonNullable<ReturnType<typeof currentCapture>>): Emit {
    const buffer = scope?.buffer;
    return buffer ? change => { buffer.push(change); } : change => { recorder.change(change); };
  }

  /**
   * Create a scope. A Preview scope hands the operation a guarded transaction that cannot commit
   * or end itself; the provider keeps the unguarded one for its own reads and the rollback.
   */
  #scope(trx: Knex.Transaction, depth: number, parent?: Scope, preview = false): Scope {
    const scope: Scope = { connection: trx, client: trx, active: true, tail: Promise.resolve(), depth };
    const connection = preview ? guardPreview(trx, this.#dialect, () => { scope.refused = true; }) : trx;
    scope.connection = connection;
    if (parent) {
      scope.parent = parent;
      scope.buffer = [];
    }
    scope.client = trackClient(connection, (builder, state, execute) => this.#mutation(trx, scope, builder, state, execute));
    return scope;
  }

  async #enter<T>(
    trx: Knex.Transaction,
    depth: number,
    callback: (client: Knex.Transaction) => Promise<T>,
    parent?: Scope,
  ): Promise<T> {
    const scope = this.#scope(trx, depth, parent);
    try {
      const result = await this.#transaction.run(scope, () => callback(scope.client));
      // The savepoint is released only if the callback resolved, so only then do its changes count.
      const recorder = currentCapture();
      if (recorder && scope.buffer) {
        const emit = this.#emit(parent, recorder);
        for (const change of scope.buffer) emit(change);
      }
      return result;
    } finally {
      scope.active = false;
    }
  }

  /** Route one builder execution: data mutations are tracked, everything else runs untouched. */
  async #mutation(
    connection: Knex,
    scope: Scope | undefined,
    builder: Knex.QueryBuilder,
    state: BuilderState,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    if (scope && !scope.active) throw new Error(noScopeMessage);
    const recorder = currentCapture();
    if (!recorder || this.#internal.getStore()) return execute();
    let method: string;
    try {
      method = builder.toSQL().method;
    } catch {
      return execute(); // Let the real execution report the malformed builder.
    }
    if (method !== 'insert' && method !== 'update' && method !== 'del' && method !== 'truncate') return execute();

    const track = async (): Promise<unknown> => {
      const table = resolveTable(state.table);
      if (method === 'truncate' || !table) {
        recorder.truncate('changes');
        return execute();
      }
      const primaryKey = await this.#primaryKey(connection, { table: table.name });
      if (primaryKey.length === 0) {
        recorder.truncate('changes');
        return execute();
      }
      const emit = this.#emit(scope, recorder);
      return method === 'insert'
        ? this.#trackInsert(recorder, emit, connection, table, primaryKey, state, execute)
        : this.#trackSelected(recorder, emit, connection, builder, table, primaryKey, execute);
    };
    if (!scope) return track();
    const previous = scope.tail;
    let release!: () => void;
    scope.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await track();
    } finally {
      release();
    }
  }

  /**
   * Track an update or delete by asking the database which rows the builder selects. The builder's
   * own conditions are reused as a SELECT of the table's rows, so joins, subqueries and raw
   * conditions need no interpretation. Inside a transaction the rows are locked, so the rows read
   * are the rows changed.
   */
  async #trackSelected(
    recorder: NonNullable<ReturnType<typeof currentCapture>>,
    emit: Emit,
    connection: Knex,
    builder: Knex.QueryBuilder,
    table: TableName,
    primaryKey: readonly string[],
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    let before: Entry[] | undefined;
    try {
      const rows = await this.#read(connection, async client => {
        const selection = builder.clone().select(table.qualifier + '.*');
        if (connection.isTransaction && this.#dialect !== 'sqlite') selection.forUpdate();
        const compiled = (selection as unknown as { toSQL(method: string): Knex.Sql }).toSQL('select');
        // Knex rejects LIMIT on some verbs, so bound the read around the compiled SELECT instead.
        const bound = this.#dialect === 'mssql'
          ? 'SELECT TOP (' + (this.#trackedKeyLimit + 1) + ') * FROM (' + compiled.sql + ') AS tb_tracked'
          : 'SELECT * FROM (' + compiled.sql + ') AS tb_tracked LIMIT ' + (this.#trackedKeyLimit + 1);
        return rowsOf(this.#dialect, await client.raw(bound, compiled.bindings as Knex.RawBinding[]));
      });
      if (rows.length <= this.#trackedKeyLimit) {
        before = rows.map(row => ({
          key: Object.fromEntries(primaryKey.map(column => [column, row[column]])) as Record<string, KeyValue>,
          row: plainRow(row),
        })).sort((left, right) => compareKeys(left.key, right.key, primaryKey));
      }
    } catch (error) {
      await this.#assertAlive(connection, error);
      before = undefined;
    }
    if (!before) {
      recorder.truncate('changes');
      return execute();
    }
    const result = await execute();
    await this.#record(recorder, emit, connection, table.name, before);
    return result;
  }

  /**
   * Track an insert. Keys come from the data when it supplies every key column, and otherwise
   * from what the insert returned: a `.returning()` clause, or the single generated identifier
   * MySQL and SQLite report. An insert whose keys cannot be known marks the changes truncated.
   */
  async #trackInsert(
    recorder: NonNullable<ReturnType<typeof currentCapture>>,
    emit: Emit,
    connection: Knex,
    table: TableName,
    primaryKey: readonly string[],
    state: BuilderState,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const supplied = state.hasData ? insertedRows(state.data) : undefined;
    const known = supplied && keysFromData(supplied, primaryKey);
    if (known && known.length > this.#trackedKeyLimit) {
      recorder.truncate('changes');
      return execute();
    }
    const before: Entry[] = [];
    for (const key of known ?? []) before.push({ key, row: await this.#snapshot(connection, table.name, key) });

    const result = await execute();

    const created = known ?? keysFromResult(result, primaryKey, state.returning !== undefined, supplied?.length, this.#dialect);
    if (!created || created.length > this.#trackedKeyLimit) {
      recorder.truncate('changes');
      return result;
    }
    await this.#record(recorder, emit, connection, table.name, known ? before : created.map(key => ({ key, row: null })));
    return result;
  }

  /** Read each entry's row after the mutation and record the ones that differ, in order. */
  async #record(
    recorder: NonNullable<ReturnType<typeof currentCapture>>,
    emit: Emit,
    connection: Knex,
    table: string,
    entries: readonly Entry[],
  ): Promise<void> {
    if (entries.length > this.#trackedKeyLimit) recorder.truncate('changes');
    for (const { key, row } of entries.slice(0, this.#trackedKeyLimit)) {
      const after = await this.#snapshot(connection, table, key);
      if (row !== undefined && after !== undefined && !isDeepStrictEqual(row, after)) {
        emit({ table, key, before: row, after, operation: row === null ? 'insert' : after === null ? 'delete' : 'update' });
      }
    }
  }

  /** Primary key columns of the tracked table, or an empty list when they cannot be determined. */
  async #primaryKey(connection: Knex, rows: Pick<TrackedRows, 'table' | 'primaryKey'>): Promise<readonly string[]> {
    if (rows.primaryKey) return rows.primaryKey;
    const known = this.#keys.get(rows.table);
    if (known) return known;
    const lookup = this.#internal.run(true, () => readPrimaryKey(connection, this.#dialect, rows.table));
    this.#keys.set(rows.table, lookup);
    try {
      const columns = await lookup;
      if (columns.length === 0) this.#keys.delete(rows.table);
      return columns;
    } catch {
      this.#keys.delete(rows.table);
      return [];
    }
  }

  /**
   * Run a tracking read that is not recorded as application SQL.
   *
   * PostgreSQL aborts a transaction after any failed statement, so inside one the read runs in a
   * savepoint of its own and a failure leaves the application's transaction usable.
   */
  #read<T>(connection: Knex, read: (client: Knex) => Promise<T>): Promise<T> {
    return this.#internal.run(true, async () =>
      this.#dialect === 'postgresql' && connection.isTransaction
        ? await (connection as Knex.Transaction).transaction(read)
        : await read(connection));
  }

  /** Read one row. Returns null for no row and undefined when the read failed. */
  async #snapshot(connection: Knex, table: string, key: Record<string, KeyValue>): Promise<Row | null | undefined> {
    try {
      // A Knex builder is lazy: await it inside the read so its query runs there.
      return plainRow(await this.#read(connection, async client => await client<Row>(table).where(key).first()));
    } catch (error) {
      await this.#assertAlive(connection, error);
      currentCapture()?.truncate('changes');
      return undefined;
    }
  }

  /**
   * SQL Server can end the whole transaction when any statement fails, and the next statement then
   * runs outside it. After a failed tracking read, stop with the read's error rather than let the
   * request continue without its transaction.
   */
  async #assertAlive(connection: Knex, error: unknown): Promise<void> {
    if (this.#dialect !== 'mssql' || !connection.isTransaction) return;
    const rows = await this.#internal.run(true, async () => rowsOf('mssql', await connection.raw('SELECT @@TRANCOUNT AS open_transactions')));
    if (Number(rows[0]?.['open_transactions']) === 0) throw error;
  }
}

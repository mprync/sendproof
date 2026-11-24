import { isDeepStrictEqual } from 'node:util';
import { currentCapture } from '@sendproof/core';
import type { CaptureRecorder, HeldPreview } from '@sendproof/core';
import type { TrackedRows } from '@sendproof/sqlite';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Column, SQL, Table } from 'drizzle-orm';
import { defaultEntry, isUnset, jsonRow, keyOf, keyText, suppliedValue, tableInfo } from './metadata.js';
import type { DrizzleDialect, Row, TableInfo } from './metadata.js';
import { asCaller, asInternal, isInternal, report } from './scope.js';
import type { Scope } from './scope.js';
import { instrumentSession } from './statements.js';
import type { SessionLike } from './statements.js';

/** The connection of `@sendproof/sqlite` the SQLite client runs on. */
export interface SQLiteConnection {
  queryRows(text: string, bindings: unknown[], method: 'all' | 'get' | 'values' | 'run', changes?: TrackedRows, captureSql?: boolean): Promise<unknown>;
  preview<T>(dispatch: () => Promise<T>): Promise<T>;
  openSession?(): Promise<HeldPreview>;
  /** A transaction, or a savepoint inside one. Available from `@sendproof/sqlite` 0.1.0-alpha.3. */
  transaction?<T>(callback: () => Promise<T>): Promise<T>;
  /** 0 outside a transaction. Available with {@link transaction}. */
  readonly depth?: number;
}

/** The members of a Drizzle database or transaction that the provider calls. */
export interface DatabaseLike {
  session: SessionLike;
  select(fields: Record<string, Column>): { from(table: Table): SelectQuery };
  transaction(callback: (transaction: DatabaseLike) => Promise<unknown>, config?: unknown): Promise<unknown>;
  [member: string | symbol]: unknown;
}

interface SelectQuery {
  where(where: SQL | undefined): SelectQuery;
  orderBy(...columns: unknown[]): SelectQuery;
  limit(limit: number): SelectQuery;
  for(strength: 'update'): SelectQuery;
  execute(placeholders?: Placeholders): Promise<Row[]>;
  all(placeholders?: Placeholders): Promise<Row[]>;
}

/** Shared settings and connections of one provider. */
export interface ProviderState {
  dialect: DrizzleDialect;
  /** The application's database. For SQLite, the proxy client over {@link sqlite}. */
  base: DatabaseLike;
  sqlite?: SQLiteConnection;
  trackedRowLimit: number;
  /** MySQL stored procedures the host declared never commit (see `DrizzlePreviewOptions.safeProcedures`). */
  safeProcedures?: ReadonlySet<string>;
}

type Placeholders = Record<string, unknown> | undefined;
type Kind = 'insert' | 'update' | 'delete';
type Method = (...args: unknown[]) => unknown;

/** Drizzle's internal builder configuration. Only the fields named here are read. */
interface MutationConfig {
  table: Table;
  values?: unknown;
  select?: boolean;
  set?: Record<string, unknown>;
  where?: SQL;
  withList?: unknown[];
  returning?: { path: string[]; field: unknown }[];
  onConflict?: unknown;
  ignore?: boolean;
  from?: unknown;
  joins?: unknown[];
  orderBy?: unknown[];
  limit?: unknown;
}

const busy = Symbol('sendproof.capturing');
const hiddenKey = '__sendproof_key_';

interface MutationBuilder {
  config: MutationConfig;
  session: SessionLike;
  [busy]?: boolean;
  [member: string]: unknown;
}

/** How one statement's rows are identified before and after it runs. */
interface Plan {
  kind: Kind;
  info: TableInfo;
  config: MutationConfig;
  placeholders: Placeholders;
  /** Insert: the supplied key of each row. Absent when the database generates keys. */
  keys?: Row[];
  /** Insert: the statement can update or keep an existing row instead of inserting. */
  conflict: boolean;
  /** Update: new values the statement assigns to key columns. */
  keyChange?: Row;
}

/**
 * Capture the rows an insert, update or delete statement changes, using the table's primary key.
 *
 * The builder's execution methods are wrapped, so every way of running the statement is covered:
 * awaiting it, `execute()`, and SQLite's `run()`, `all()`, `get()` and `values()`. A statement
 * prepared with `prepare()` runs without row capture and marks captured changes as truncated.
 */
export function instrumentMutation(state: ProviderState, target: DatabaseLike, kind: Kind, value: unknown): unknown {
  const builder = value as MutationBuilder;
  const info = tableInfo(state.dialect, builder.config.table);
  // SQLite's delete runs through execute(); its insert and update run execute() through all() or run().
  const methods = state.dialect === 'sqlite' ? ['execute', 'run', 'all', 'get', 'values'] : ['execute'];
  for (const name of methods) {
    const method = builder[name];
    if (typeof method !== 'function') continue;
    builder[name] = (...args: unknown[]) => capture(state, target, kind, info, builder,
      () => (method as Method).apply(builder, args), args[0] as Placeholders);
  }
  const prepare = builder['prepare'];
  if (typeof prepare === 'function') {
    builder['prepare'] = (...args: unknown[]) => {
      const prepared = (prepare as Method).apply(builder, args);
      return builder[busy] ? prepared : untracked(prepared);
    };
  }
  return builder;
}

/** A prepared mutation runs without row capture. Its changes are reported as incomplete. */
function untracked(prepared: unknown): unknown {
  const target = prepared as Record<string, unknown>;
  for (const name of ['execute', 'all', 'get', 'values', 'run']) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    target[name] = (...args: unknown[]) => {
      currentCapture()?.truncate('changes');
      return (method as Method).apply(prepared, args);
    };
  }
  return prepared;
}

async function capture(
  state: ProviderState,
  target: DatabaseLike,
  kind: Kind,
  info: TableInfo | null,
  builder: MutationBuilder,
  run: () => unknown,
  placeholders: Placeholders,
): Promise<unknown> {
  // SQLite's execute() can call all() or run(), which are wrapped too: capture once.
  if (builder[busy]) return run();
  /** Run the statement, on another session when given. Drizzle prepares it synchronously. */
  const invoke = (session?: SessionLike): Promise<unknown> => {
    const previous = builder.session;
    if (session) builder.session = session;
    builder[busy] = true;
    try {
      return Promise.resolve(run());
    } finally {
      builder.session = previous;
      builder[busy] = false;
    }
  };

  const recorder = currentCapture();
  if (!recorder || isInternal()) return invoke();
  const plan = info && planOf(state, kind, info, builder.config, placeholders);
  if (!plan) {
    recorder.truncate('changes');
    return invoke();
  }

  const inTransaction = state.sqlite ? (state.sqlite.depth ?? 0) > 0 : target !== state.base;
  if (inTransaction) return runPlan(state, target, builder, plan, invoke, undefined, recorder);
  // An autocommit statement runs in its own transaction, so no other writer can change its rows
  // between the snapshots and the statement.
  const sqlite = state.sqlite;
  if (sqlite) {
    return sqlite.transaction
      ? sqlite.transaction(() => runPlan(state, target, builder, plan, invoke, undefined, recorder))
      : runPlan(state, target, builder, plan, invoke, undefined, recorder);
  }
  return asInternal(() => state.base.transaction(async transaction => {
    const scope: Scope = { target: transaction, preview: false, open: true };
    instrumentSession(transaction.session, state.dialect, scope);
    try {
      return await asCaller(() =>
        runPlan(state, transaction, builder, plan, invoke, transaction.session, recorder));
    } finally {
      scope.open = false;
    }
  }));
}

function planOf(state: ProviderState, kind: Kind, info: TableInfo, config: MutationConfig, placeholders: Placeholders): Plan | undefined {
  const plan: Plan = { kind, info, config, placeholders, conflict: false };
  if (kind !== 'insert') {
    // A join, FROM list or CTE can be referenced by the filter, which a plain snapshot read cannot reproduce.
    if (config.withList?.length || config.from !== undefined || config.joins?.length) return undefined;
    if (kind === 'delete') return plan;
    const change: Row = {};
    for (const { property, column } of info.primary) {
      const entry = config.set?.[property];
      if (entry === undefined) continue;
      const value = suppliedValue(entry, placeholders);
      if (value === undefined) return undefined;
      change[column.name] = value;
    }
    return Object.keys(change).length ? { ...plan, keyChange: change } : plan;
  }

  plan.conflict = Boolean(config.ignore)
    || (Array.isArray(config.onConflict) ? config.onConflict.length > 0 : config.onConflict !== undefined);
  if (!config.select && Array.isArray(config.values)) {
    const values = config.values as Record<string, unknown>[];
    // MySQL's $returningId() reads client-generated keys from Drizzle's own default calls.
    if (!(state.dialect === 'mysql' && config.returning)) materializeDefaults(info, values);
    const keys = values.map(entry => {
      const key: Row = {};
      for (const { property, column } of info.primary) {
        const value = suppliedValue(entry[property], placeholders);
        if (value === undefined) return undefined;
        key[column.name] = value;
      }
      return key;
    });
    if (keys.every(key => key !== undefined)) return { ...plan, keys: keys as Row[] };
    // Only RETURNING identifies a mix of supplied and generated keys.
    if (keys.some(key => key !== undefined) && state.dialect !== 'postgresql') return undefined;
  }
  // With generated keys an upsert's earlier rows cannot be read beforehand.
  if (plan.conflict) return undefined;
  // MySQL can interleave generated keys for INSERT ... SELECT with concurrent inserts.
  if (state.dialect === 'mysql' && config.select) return undefined;
  if (state.dialect === 'mysql' && !config.returning) {
    const [only, ...rest] = info.primary;
    if (!only || rest.length || !(only.column as { autoIncrement?: boolean }).autoIncrement) return undefined;
  }
  return plan;
}

/**
 * Generate client-side key defaults (`$defaultFn`) before Drizzle builds the statement, so the keys
 * are known. Drizzle calls the same function once per row when it builds the statement; this only
 * moves that call earlier.
 */
function materializeDefaults(info: TableInfo, values: Record<string, unknown>[]): void {
  for (const entry of values) {
    for (const { property, column } of info.primary) {
      const defaultFn = (column as { defaultFn?: () => unknown }).defaultFn;
      if (typeof defaultFn === 'function' && isUnset(entry[property])) entry[property] = defaultEntry(column, defaultFn());
    }
  }
}

async function runPlan(
  state: ProviderState,
  reader: DatabaseLike,
  builder: MutationBuilder,
  plan: Plan,
  invoke: (session?: SessionLike) => Promise<unknown>,
  session: SessionLike | undefined,
  recorder: CaptureRecorder,
): Promise<unknown> {
  const { info, config } = plan;
  const limit = state.trackedRowLimit;
  const truncated = () => recorder.truncate('changes');

  if (plan.kind !== 'insert') {
    const requested = typeof config.limit === 'number' ? config.limit : undefined;
    const before = await snapshot(state, reader, info, config.where, {
      lock: true,
      orderBy: config.orderBy,
      limit: Math.min(requested ?? limit + 1, limit + 1),
    }, plan.placeholders);
    if (!before || before.length > limit || (plan.keyChange && before.length > 1)) {
      truncated();
      return invoke(session);
    }
    const result = await invoke(session);
    const keys = before.map(row => ({ ...rawKey(info, row), ...plan.keyChange }));
    const after = await readKeys(state, reader, info, keys);
    if (!after) truncated();
    else if (plan.keyChange) record(recorder, info, before[0] ?? null, after[0] ?? null);
    else emit(recorder, info, before, after);
    return result;
  }

  if (plan.keys) {
    if (plan.keys.length > limit) {
      truncated();
      return invoke(session);
    }
    const before = plan.conflict ? await readKeys(state, reader, info, plan.keys, true) : [];
    if (!before) {
      truncated();
      return invoke(session);
    }
    const result = await invoke(session);
    const after = await readKeys(state, reader, info, plan.keys);
    if (after) emit(recorder, info, before, after);
    else truncated();
    return result;
  }

  const { result, keys } = await generatedInsert(state, reader, builder, plan, invoke, session);
  const after = keys && keys.length <= limit ? await readKeys(state, reader, info, keys) : undefined;
  if (after) emit(recorder, info, [], after);
  else truncated();
  return result;
}

/** Run an insert whose keys the database generates and learn the keys it assigned. */
async function generatedInsert(
  state: ProviderState,
  reader: DatabaseLike,
  builder: MutationBuilder,
  { info, config }: Plan,
  invoke: (session?: SessionLike) => Promise<unknown>,
  session: SessionLike | undefined,
): Promise<{ result: unknown; keys?: Row[] }> {
  if (state.dialect === 'postgresql') {
    // Add the key columns to RETURNING. Without a requested RETURNING, prepare without result
    // fields so the driver's own result object comes back, then empty its rows.
    const requested = config.returning;
    const hidden = info.primary.map(({ column }, index) => ({ path: [hiddenKey + index], field: column }));
    config.returning = requested ? [...requested, ...hidden] : hidden;
    let pending: Promise<unknown>;
    try {
      pending = invoke(requested ? session : rawSession(session ?? builder.session));
    } finally {
      config.returning = requested;
    }
    const result = await pending;
    if (requested) {
      const keys = (result as Row[]).map(row => {
        const key: Row = {};
        info.primary.forEach(({ column }, index) => {
          key[column.name] = row[hiddenKey + index];
          delete row[hiddenKey + index];
        });
        return key;
      });
      return { result, keys };
    }
    const keys = takeRows(result).map(row => {
      const values = Object.values(row);
      return Object.fromEntries(info.primary.map(({ column }, index) => [column.name, values[index]]));
    });
    return { result, keys };
  }

  const result = await invoke(session);
  if (state.dialect === 'sqlite') {
    // SQLite assigns consecutive rowids within one statement, and the connection is held for it.
    try {
      const marker = await asInternal(() => (reader['get'] as Method)(sql`select last_insert_rowid(), changes()`)) as unknown;
      const [last, count] = (Array.isArray(marker) ? marker : Object.values(marker ?? {})).map(Number);
      if (last === undefined || count === undefined || !Number.isFinite(last + count) || count > state.trackedRowLimit) return { result };
      const rows = await snapshot(state, reader, info, sql`rowid > ${last - count} and rowid <= ${last}`, {});
      return { result, keys: rows?.map(row => rawKey(info, row)) };
    } catch {
      return { result };
    }
  }

  // MySQL: $returningId() supplies the keys; otherwise read them from the result header.
  if (config.returning) {
    const keys = (result as Row[]).map(row =>
      Object.fromEntries(info.primary.map(({ property, column }) => [column.name, row[property]])));
    return { result, keys: keys.every(key => Object.values(key).every(value => value !== undefined)) ? keys : undefined };
  }
  const header = (Array.isArray(result) ? result[0] : result) as { insertId?: unknown; affectedRows?: unknown } | undefined;
  const first = Number(header?.insertId);
  const count = Number(header?.affectedRows);
  const column = info.primary[0]?.column;
  if (!column || !Number.isSafeInteger(first) || !(first > 0) || !Number.isSafeInteger(count)
    || !(count >= 0) || count > state.trackedRowLimit) return { result };
  const step = count > 1 ? await increment(reader) : 1;
  if (step === undefined || !Number.isSafeInteger(first + (count - 1) * step)) return { result };
  return { result, keys: Array.from({ length: count }, (_, index) => ({ [column.name]: first + index * step })) };
}

/** A session that prepares statements without result fields, so drivers return their raw result. */
function rawSession(session: SessionLike): SessionLike {
  const raw = Object.create(session) as SessionLike;
  raw.prepareQuery = (query: unknown, _fields: unknown, ...rest: unknown[]) => session.prepareQuery(query, undefined, ...rest);
  return raw;
}

/** Remove and return the rows of a raw PostgreSQL driver result, keeping its counts. */
function takeRows(result: unknown): Row[] {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  const copy = [...rows] as Row[];
  rows.length = 0;
  return copy;
}

async function increment(reader: DatabaseLike): Promise<number | undefined> {
  try {
    const result = await asInternal(() => (reader['execute'] as Method)(sql`select @@session.auto_increment_increment as step`));
    const step = Number(((result as Row[][])[0]?.[0])?.['step']);
    return Number.isInteger(step) && step > 0 ? step : undefined;
  } catch {
    return undefined;
  }
}

function rawKey(info: TableInfo, row: Row): Row {
  return Object.fromEntries(info.primary.map(({ column }) => [column.name, row[column.name]]));
}

interface ReadOptions {
  lock?: boolean;
  orderBy?: unknown[];
  limit?: number;
}

/**
 * Read rows for a snapshot. Returns `undefined` when the read fails, so the statement still runs.
 *
 * On PostgreSQL the read runs in a savepoint, because a failed statement would otherwise abort the
 * application's transaction. Rows are locked with FOR UPDATE where requested, so no other writer
 * changes them before the statement runs.
 */
async function snapshot(
  state: ProviderState,
  reader: DatabaseLike,
  info: TableInfo,
  where: SQL | undefined,
  { lock = false, orderBy, limit }: ReadOptions,
  placeholders?: Placeholders,
): Promise<Row[] | undefined> {
  const select = (database: DatabaseLike): Promise<Row[]> => {
    let query = database.select(info.fields).from(info.table);
    if (where) query = query.where(where);
    if (orderBy?.length) query = query.orderBy(...orderBy);
    if (limit !== undefined) query = query.limit(limit);
    if (lock && state.dialect !== 'sqlite') query = query.for('update');
    return state.dialect === 'sqlite' ? query.all(placeholders) : query.execute(placeholders);
  };
  try {
    return await asInternal(() => state.dialect === 'postgresql'
      ? reader.transaction(select) as Promise<Row[]>
      : select(reader));
  } catch {
    return undefined;
  }
}

/** Read the current rows for a list of keys, in batches. */
async function readKeys(state: ProviderState, reader: DatabaseLike, info: TableInfo, keys: Row[], lock = false): Promise<Row[] | undefined> {
  const rows: Row[] = [];
  for (let index = 0; index < keys.length; index += 100) {
    const batch = keys.slice(index, index + 100);
    const [single] = info.primary;
    const where = info.primary.length === 1 && single
      ? inArray(single.column, batch.map(key => key[single.column.name]))
      : or(...batch.map(key => and(...info.primary.map(({ column }) => eq(column, key[column.name])))));
    const found = await snapshot(state, reader, info, where, { lock });
    if (!found) return undefined;
    rows.push(...found);
  }
  return rows;
}

/** Record the rows that differ between two snapshots, matched by primary key. */
function emit(recorder: CaptureRecorder, info: TableInfo, before: Row[], after: Row[]): void {
  const earlier = new Map(before.map(row => [keyText(info, row), row]));
  const later = new Map(after.map(row => [keyText(info, row), row]));
  for (const key of new Set([...earlier.keys(), ...later.keys()])) {
    record(recorder, info, earlier.get(key) ?? null, later.get(key) ?? null);
  }
}

function record(recorder: CaptureRecorder, info: TableInfo, before: Row | null, after: Row | null): void {
  const current = after ?? before;
  if (!current || (before && after && isDeepStrictEqual(before, after))) return;
  report({
    table: info.name,
    key: keyOf(info, current),
    before: before && jsonRow(before),
    after: after && jsonRow(after),
    operation: before === null ? 'insert' : after === null ? 'delete' : 'update',
  }, change => recorder.change(change));
}

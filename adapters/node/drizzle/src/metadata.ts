import { getTableColumns, is, Param, Placeholder, SQL } from 'drizzle-orm';
import type { Column, Table } from 'drizzle-orm';
import { getTableConfig as mysqlTableConfig, MySqlDatabase, MySqlTable } from 'drizzle-orm/mysql-core';
import { getTableConfig as pgTableConfig, PgDatabase, PgTable } from 'drizzle-orm/pg-core';
import { BaseSQLiteDatabase, getTableConfig as sqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

/** The SQL dialect of a Drizzle database. */
export type DrizzleDialect = 'postgresql' | 'mysql' | 'sqlite';

/** A row keyed by database column name. */
export type Row = Record<string, unknown>;

/** One primary key column, with its property name in the Drizzle table definition. */
export interface KeyColumn {
  property: string;
  column: Column;
}

/** What capture needs to know about one table, derived once from its Drizzle definition. */
export interface TableInfo {
  table: Table;
  /** The table name in change records, qualified by schema when the definition names one. */
  name: string;
  /** Every column keyed by database column name, used as the selection for row snapshots. */
  fields: Record<string, Column>;
  primary: KeyColumn[];
}

/** Identify the dialect of a Drizzle database or transaction without importing any driver. */
export function dialectOf(database: unknown): DrizzleDialect | undefined {
  if (is(database, PgDatabase)) return 'postgresql';
  if (is(database, MySqlDatabase)) return 'mysql';
  if (is(database, BaseSQLiteDatabase)) return 'sqlite';
  return undefined;
}

const tables = new WeakMap<object, TableInfo | null>();

/**
 * Read the primary key of a Drizzle table from its definition: a composite `primaryKey()` in the
 * table's extra configuration, otherwise the columns declared with `.primaryKey()`.
 *
 * Returns `null` for a table without a primary key, whose rows cannot be identified.
 */
export function tableInfo(dialect: DrizzleDialect, table: Table): TableInfo | null {
  const cached = tables.get(table);
  if (cached !== undefined) return cached;
  const config = configOf(dialect, table);
  const properties = Object.entries(getTableColumns(table) as Record<string, Column>);
  const declared = config?.primaryKeys[0]?.columns ?? config?.columns.filter(column => column.primary) ?? [];
  // A composite key's columns can be copies made for the extra configuration, so match by name.
  const primary = declared.map(declaredColumn => {
    const match = properties.find(([, candidate]) => candidate.name === declaredColumn.name);
    return match && { property: match[0], column: match[1] };
  });
  const info = config && primary.length && primary.every(entry => entry !== undefined) ? {
    table,
    name: config.schema ? config.schema + '.' + config.name : config.name,
    fields: Object.fromEntries(config.columns.map(column => [column.name, column])),
    primary: primary as KeyColumn[],
  } : null;
  tables.set(table, info);
  return info;
}

interface TableConfig {
  name: string;
  schema?: string;
  columns: Column[];
  primaryKeys: { columns: Column[] }[];
}

function configOf(dialect: DrizzleDialect, table: Table): TableConfig | undefined {
  if (dialect === 'postgresql' && is(table, PgTable)) return pgTableConfig(table);
  if (dialect === 'mysql' && is(table, MySqlTable)) return mysqlTableConfig(table);
  if (dialect === 'sqlite' && is(table, SQLiteTable)) return sqliteTableConfig(table);
  return undefined;
}

/** The key of a row read from the database, keyed by column name. */
export function keyOf(info: TableInfo, row: Row): Row {
  return Object.fromEntries(info.primary.map(({ column }) => [column.name, jsonValue(row[column.name])]));
}

/** A stable text form of a row's key, for matching snapshots taken before and after a statement. */
export function keyText(info: TableInfo, row: Row): string {
  return JSON.stringify(info.primary.map(({ column }) => comparable(row[column.name])));
}

function comparable(value: unknown): unknown {
  if (typeof value === 'bigint') return 'bigint:' + value.toString();
  if (value instanceof Date) return 'date:' + value.toISOString();
  if (value instanceof Uint8Array) return 'bytes:' + Buffer.from(value).toString('base64');
  return value;
}

/** Convert values JSON cannot represent. A bigint stays a number while it is exactly representable. */
export function jsonValue(value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

/** Copy a snapshot row into a form the capture can serialize. */
export function jsonRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, jsonValue(value)]));
}

/**
 * The plain value of an insert or update entry, or `undefined` when the database computes it.
 *
 * Drizzle wraps supplied values in `Param`, and a prepared statement's `Placeholder` is resolved
 * from the values given at execution. A raw `SQL` expression is evaluated by the database.
 */
export function suppliedValue(entry: unknown, placeholders: Record<string, unknown> | undefined): unknown {
  if (entry === undefined || is(entry, SQL)) return undefined;
  const value = is(entry, Param) ? entry.value : entry;
  if (is(value, Placeholder)) return placeholders?.[value.name];
  if (is(value, SQL)) return undefined;
  return value;
}

/** Whether an insert entry leaves the column to its default, as Drizzle decides when it builds the statement. */
export function isUnset(entry: unknown): boolean {
  return entry === undefined || (is(entry, Param) && entry.value === undefined);
}

/** Wrap a client-generated default as Drizzle would when it builds the statement. */
export function defaultEntry(column: Column, produced: unknown): unknown {
  return is(produced, SQL) ? produced : new Param(produced, column);
}

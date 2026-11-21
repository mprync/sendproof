import type { Knex } from 'knex';
import type { Dialect, KeyValue, RowKey } from './types.js';

/** Split an optional `schema.` prefix from a table name. */
export function splitTable(table: string): { schema: string | null; name: string } {
  const dot = table.lastIndexOf('.');
  return dot < 0 ? { schema: null, name: table } : { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

const defaultSchema: Partial<Record<Dialect, string>> = {
  postgresql: 'current_schema()',
  mysql: 'DATABASE()',
  mssql: 'SCHEMA_NAME()',
};

/**
 * Read the primary key columns of a table from the database catalog, in key order.
 * An empty list means the table has no primary key, or does not exist.
 */
export async function readPrimaryKey(connection: Knex, dialect: Dialect, table: string): Promise<string[]> {
  const { schema, name } = splitTable(table);
  if (dialect === 'sqlite') {
    const rows: { name: string }[] = await connection
      .select('name')
      .from(connection.raw('pragma_table_info(?)', [name]))
      .where('pk', '>', 0)
      .orderBy('pk');
    return rows.map(row => row.name);
  }
  const fallback = defaultSchema[dialect];
  if (!fallback) return [];
  const rows: { column_name: string }[] = await connection('information_schema.table_constraints as tc')
    .join('information_schema.key_column_usage as kcu', function joinKeyColumns() {
      this.on('tc.constraint_name', 'kcu.constraint_name')
        .andOn('tc.table_schema', 'kcu.table_schema')
        .andOn('tc.table_name', 'kcu.table_name');
    })
    .where('tc.constraint_type', 'PRIMARY KEY')
    .where('tc.table_name', name)
    .whereRaw('tc.table_schema = COALESCE(?, ' + fallback + ')', [schema])
    .orderBy('kcu.ordinal_position')
    .select('kcu.column_name as column_name');
  return rows.map(row => row.column_name);
}

/**
 * Express `key` as a column to value object covering exactly the primary key columns.
 * Returns undefined when the key does not identify one row of the table.
 */
export function normalizeKey(key: RowKey, primaryKey: readonly string[]): Record<string, KeyValue> | undefined {
  if (primaryKey.length === 0) return undefined;
  const only = primaryKey[0];
  if (typeof key !== 'object' || key instanceof Date || Buffer.isBuffer(key)) {
    return primaryKey.length === 1 && only !== undefined && key !== undefined ? { [only]: key } : undefined;
  }
  const names = Object.keys(key);
  const complete = names.length === primaryKey.length && primaryKey.every(column => Object.hasOwn(key, column));
  return complete ? { ...key } : undefined;
}

/** Whether `value` can be a primary key column value. */
export function isKeyValue(value: unknown): value is KeyValue {
  return ['string', 'number', 'bigint', 'boolean'].includes(typeof value) || value instanceof Date || Buffer.isBuffer(value);
}

type Plain = Record<string, unknown>;

/** A plain data row: an object that is not a Date, a Buffer or an unevaluated Knex expression. */
export function isDataRow(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) &&
    !Buffer.isBuffer(value) && typeof (value as { toSQL?: unknown }).toSQL !== 'function';
}

/** The rows an `.insert()` call supplies, or undefined when the data is not plain rows. */
export function insertedRows(data: unknown): Plain[] | undefined {
  const rows = Array.isArray(data) ? data : [data];
  return rows.length > 0 && rows.every(isDataRow) ? rows : undefined;
}

/** Keys supplied by the data itself. Undefined unless every row supplies every key column. */
export function keysFromData(rows: readonly Plain[], primaryKey: readonly string[]): Record<string, KeyValue>[] | undefined {
  const keys: Record<string, KeyValue>[] = [];
  for (const row of rows) {
    const key: Record<string, KeyValue> = {};
    for (const column of primaryKey) {
      const value = row[column];
      if (!isKeyValue(value)) return undefined;
      key[column] = value;
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Keys of rows created with generated values, read from what the insert returned: the rows of a
 * `.returning()` clause, or the single identifier MySQL and SQLite report for one inserted row.
 */
export function keysFromResult(
  result: unknown,
  primaryKey: readonly string[],
  returned: boolean,
  inserted: number | undefined,
  dialect: Dialect,
): Record<string, KeyValue>[] | undefined {
  if (!Array.isArray(result)) return undefined;
  if (returned && result.length > 0 && result.every(isDataRow)) {
    return keysFromData(result as Plain[], primaryKey);
  }
  const [column] = primaryKey;
  const [first] = result as unknown[];
  if ((dialect === 'mysql' || dialect === 'sqlite') && inserted === 1 && primaryKey.length === 1 && column !== undefined &&
    (typeof first === 'number' || typeof first === 'bigint')) {
    return [{ [column]: first }];
  }
  return undefined;
}

/** Rows from a raw query result, which each driver shapes differently. */
export function rowsOf(dialect: Dialect, result: unknown): Record<string, unknown>[] {
  if (dialect === 'postgresql') return ((result as { rows?: Record<string, unknown>[] }).rows) ?? [];
  if (dialect === 'mysql') return ((result as [Record<string, unknown>[]])[0]) ?? [];
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/** Order rows by primary key so a statement's changes are listed deterministically. */
export function compareKeys(left: Record<string, KeyValue>, right: Record<string, KeyValue>, primaryKey: readonly string[]): number {
  for (const column of primaryKey) {
    const a = left[column];
    const b = right[column];
    if (a === b || a === undefined || b === undefined) continue;
    const numeric = (typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint');
    const order = numeric ? (a < b ? -1 : 1) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

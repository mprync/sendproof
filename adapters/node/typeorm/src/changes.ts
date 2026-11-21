import { isDeepStrictEqual } from 'node:util';
import type { Change, CaptureRecorder } from '@sendproof/core';
import type { DataSource, EntityMetadata } from 'typeorm';

/** Runs a read-only statement on the connection that executed the write, bypassing capture. */
export type RawRead = (sql: string) => Promise<unknown>;

type Row = Record<string, unknown>;
type Snapshot = Map<string, Row>;

const segment = String.raw`(?:"[^"]+"|` + '`[^`]+`' + String.raw`|\[[^\]]+\]|\w+)`;
/** The table a data-modifying statement targets: INSERT [OR x|IGNORE] INTO, REPLACE INTO, UPDATE, DELETE FROM. */
const writeTarget = new RegExp(
  String.raw`^\s*(?:INSERT\s+(?:OR\s+\w+\s+|IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(${segment}(?:\.${segment})*)`,
  'i',
);

const unquote = (part: string): string => part.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
const normalizePath = (path: string): string => path.match(new RegExp(segment, 'g'))?.map(unquote).join('.') ?? '';

/** JSON-safe form of a driver value, so snapshots compare and serialize predictably. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return 'base64:' + value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Select at most `limit` rows from an escaped table path using the driver's row-limit syntax. */
function limitedSelect(source: DataSource, table: string, limit: number): string {
  switch (source.options.type) {
    case 'mssql': return `SELECT TOP ${limit} * FROM ${table}`;
    case 'oracle': case 'sap': return `SELECT * FROM ${table} FETCH FIRST ${limit} ROWS ONLY`;
    default: return `SELECT * FROM ${table} LIMIT ${limit}`;
  }
}

/**
 * Derives row changes from Entity metadata without caller-supplied keys.
 *
 * Before a data-modifying statement runs, the entity table it targets is read into a snapshot keyed
 * by the entity's primary columns; after the statement, the table is read again and diffed. The
 * same path therefore reports `save`, `insert`, `update`, `delete`, `softDelete`, bulk query builder
 * writes and raw SQL aimed at a mapped table. Writes made by triggers or cascades to a table that
 * the statement did not name are not row changes; they appear in the SQL log only.
 */
export class ChangeTracker {
  readonly #source: DataSource;
  readonly #maxRows: number;
  #index: Map<string, EntityMetadata> | undefined;
  #indexedCount = -1;

  constructor(source: DataSource, maxRows: number) {
    this.#source = source;
    this.#maxRows = maxRows;
  }

  /** Execute `write`, recording the row changes it caused. Capture failure never alters the write. */
  async around<T>(capture: CaptureRecorder, text: string, read: RawRead, write: () => Promise<T>): Promise<T> {
    const metadata = this.#target(text);
    if (!metadata || metadata.primaryColumns.length === 0) return write();
    const before = await this.#snapshot(capture, metadata, read);
    const result = await write();
    if (before) {
      const after = await this.#snapshot(capture, metadata, read);
      if (after) this.#report(capture, metadata, before, after);
    }
    return result;
  }

  /** Resolve the mapped entity a write statement targets, ignoring schema/database qualifiers. */
  #target(text: string): EntityMetadata | undefined {
    const path = writeTarget.exec(text)?.[1];
    if (!path) return undefined;
    const metadatas = this.#source.entityMetadatas;
    if (!this.#index || this.#indexedCount !== metadatas.length) {
      this.#index = new Map();
      for (const metadata of metadatas) {
        for (const name of [metadata.tablePath, metadata.tableName]) this.#index.set(normalizePath(name), metadata);
      }
      this.#indexedCount = metadatas.length;
    }
    const normalized = normalizePath(path);
    return this.#index.get(normalized) ?? this.#index.get(normalized.split('.').pop() ?? normalized);
  }

  async #snapshot(capture: CaptureRecorder, metadata: EntityMetadata, read: RawRead): Promise<Snapshot | undefined> {
    try {
      const table = metadata.tablePath.split('.').map(part => this.#source.driver.escape(part)).join('.');
      const rows = await read(limitedSelect(this.#source, table, this.#maxRows + 1));
      if (!Array.isArray(rows) || rows.length > this.#maxRows) {
        capture.truncate('changes');
        return undefined;
      }
      const snapshot: Snapshot = new Map();
      for (const row of rows as Row[]) {
        const key = JSON.stringify(metadata.primaryColumns.map(column => plain(row[column.databaseName])));
        snapshot.set(key, Object.fromEntries(Object.entries(row).map(([name, value]) => [name, plain(value)])));
      }
      return snapshot;
    } catch {
      capture.truncate('changes');
      return undefined;
    }
  }

  #report(capture: CaptureRecorder, metadata: EntityMetadata, before: Snapshot, after: Snapshot): void {
    const properties = new Map(metadata.columns.map(column => [column.databaseName, column.propertyPath]));
    const entity = (row: Row): Row => Object.fromEntries(
      Object.entries(row).map(([name, value]) => [properties.get(name) ?? name, value]));
    const emit = (previous: Row | undefined, next: Row | undefined): void => {
      const identity = entity((previous ?? next) as Row);
      const key = Object.fromEntries(metadata.primaryColumns.map(column => [column.propertyPath, identity[column.propertyPath]]));
      const change: Change = {
        operation: previous === undefined ? 'insert' : next === undefined ? 'delete' : 'update',
        table: metadata.tableName, key,
        before: previous === undefined ? null : entity(previous),
        after: next === undefined ? null : entity(next),
      };
      capture.change(change);
    };
    for (const [key, row] of after) {
      const previous = before.get(key);
      if (previous === undefined || !isDeepStrictEqual(previous, row)) emit(previous, row);
    }
    for (const [key, row] of before) if (!after.has(key)) emit(row, undefined);
  }
}

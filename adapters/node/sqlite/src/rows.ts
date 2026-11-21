import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { currentCapture } from '@test-bench/core';
import { identifier } from './statements.js';

/** A row primary key as column name and value pairs. Supply every column of a composite key. */
export type RowKey = Record<string, SQLInputValue>;

/** The rows a mutation affects, identified by table and primary key. */
export interface TrackedRows {
  table: string;
  keys?: RowKey[];
}

/** A row as SQLite returns it. */
export type Row = Record<string, SQLOutputValue>;

/** The number of keys snapshotted for one statement unless the database sets another limit. */
export const defaultTrackedKeyLimit = 500;

/**
 * Snapshot the supplied rows around a mutation and record each row that changed.
 *
 * A key that cannot be read, or a key list above `limit`, marks the captured changes as truncated
 * instead of failing the operation. The mutation always runs.
 */
export function trackRows<T>(
  connection: DatabaseSync,
  { table, keys = [] }: TrackedRows,
  limit: number,
  operation: () => T,
): T {
  const recorder = currentCapture();
  if (!recorder || !keys.length) return operation();
  if (keys.length > limit) {
    recorder.truncate('changes');
    return operation();
  }

  const snapshot = (key: RowKey): Row | null | undefined => {
    try {
      const filter = Object.keys(key).map(name => identifier(name) + ' IS :' + name).join(' AND ');
      if (!filter) throw new TypeError('Supply the row primary key.');
      const row = connection.prepare('SELECT * FROM ' + identifier(table) + ' WHERE ' + filter).get(key);
      return (row as Row | undefined) ?? null;
    } catch {
      recorder.truncate('changes');
      return undefined;
    }
  };

  const previous = keys.map(snapshot);
  const result = operation();
  keys.forEach((key, index) => {
    const before = previous[index];
    const after = snapshot(key);
    if (before !== undefined && after !== undefined && !isDeepStrictEqual(before, after)) {
      recorder.change({
        table,
        key,
        before,
        after,
        operation: before === null ? 'insert' : after === null ? 'delete' : 'update',
      });
    }
  });
  return result;
}

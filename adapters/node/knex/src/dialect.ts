import type { Knex } from 'knex';
import type { Dialect } from './types.js';

/** Classify a Knex instance by the database it is configured for. */
export function dialectOf(database: Knex): Dialect {
  const client = database.client as { dialect?: unknown; driverName?: unknown } | undefined;
  const name = String(client?.dialect ?? client?.driverName ?? '').toLowerCase();
  if (name.includes('sqlite')) return 'sqlite';
  if (name.includes('postgres') || name === 'pg' || name.includes('cockroach')) return 'postgresql';
  if (name.includes('mysql') || name.includes('maria')) return 'mysql';
  if (name.includes('mssql') || name.includes('tedious')) return 'mssql';
  return 'other';
}

interface DriverError {
  code?: unknown;
  errno?: unknown;
  number?: unknown;
  cause?: unknown;
  originalError?: unknown;
}

/**
 * Whether the database asked for the transaction to be attempted again: a deadlock, a
 * serialization failure or a lock wait timeout, in the vocabulary of each supported driver.
 */
export function isTransient(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const { code, errno, number, cause, originalError } = error as DriverError;
  if (typeof code === 'string' && ['40001', '40P01', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'SQLITE_BUSY', 'SQLITE_LOCKED',
    'ELOCK'].includes(code)) return true;
  if (typeof errno === 'number' && (errno === 1213 || errno === 1205)) return true;
  if (typeof number === 'number' && number === 1205) return true;
  return isTransient(cause, depth + 1) || isTransient(originalError, depth + 1);
}

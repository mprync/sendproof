// Shared fixtures for the framework adapter tests: a real SQLite `items` table and two identities.
import { SQLiteDatabase } from '@sendproof/sqlite';
import type { BenchIdentity } from '@sendproof/core';

/** A disposable in-memory database with the conformance `items` table. */
export function createItems(): SQLiteDatabase {
  return new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)' });
}

/** Identities selected by the `x-user` request header. */
export const users: Record<string, BenchIdentity> = {
  admin: { subject: 'admin', name: 'Fixture Admin', role: 'admin' },
  viewer: { subject: 'viewer', name: 'Fixture Viewer', role: 'viewer' },
};

/** Resolve the identity named by an `x-user` header value, or `null` when anonymous or unknown. */
export function identityFor(header: string | string[] | undefined): BenchIdentity | null {
  return typeof header === 'string' && Object.hasOwn(users, header) ? users[header] ?? null : null;
}

/** Whether an item row currently exists, read outside any preview. */
export async function exists(db: SQLiteDatabase, id: string): Promise<boolean> {
  return (await db.get('SELECT id FROM items WHERE id = :id', { id })) !== undefined;
}

/** Shape of a successful Preview response. */
export interface PreviewResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rolledBack: boolean;
  changes?: { operation: string; table: string; key: unknown; before: unknown; after: unknown }[];
  effects?: { kind: string; description: string; delivered?: boolean }[];
  logs?: { level: string; message: string }[];
  changesTruncated?: boolean;
}

/** Shape of a problem response from the workbench. */
export interface Problem {
  status: number;
  title: string;
}

import { eq, sql } from 'drizzle-orm';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { drizzlePreview } from '@sendproof/drizzle';
import { commitProbeProcedure, sqliteStorage } from './fixture-service.mjs';

/**
 * Drizzle stores for the shared HTTP fixture on the Express run.
 *
 * `BENCH_DATABASE` selects `sqlite` (the default, in memory), `postgresql` or `mysql`. A server
 * database is reached at `BENCH_DATABASE_URL`, a fresh empty database the runner provisions; the
 * fixture creates its own table there. Row changes are captured from the Drizzle table definition,
 * so no store passes row keys.
 */

const sqliteItems = sqliteTable('items', { id: sqliteText('id').primaryKey(), name: sqliteText('name').notNull() });
const pgItems = pgTable('items', { id: text('id').primaryKey(), name: text('name').notNull() });
const mysqlItems = mysqlTable('items', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
});

/** The SQLite store over `@sendproof/sqlite`, created for the fixture's database file. */
export function drizzleStore(filename) {
  const { db: database, secret } = sqliteStorage(filename);
  const provider = drizzlePreview(database, { schema: { items: sqliteItems } });
  const { client } = provider;
  return {
    provider, secret,
    find: id => client.select().from(sqliteItems).where(eq(sqliteItems.id, id)).get(),
    insert: (id, name) => client.insert(sqliteItems).values({ id, name }).run(),
    update: async (id, name) => (await client.update(sqliteItems).set({ name }).where(eq(sqliteItems.id, id)).returning()).length,
    remove: async id => (await client.delete(sqliteItems).where(eq(sqliteItems.id, id)).returning()).length,
  };
}

/** Open the store `BENCH_DATABASE` selects, resolving to the factory `createFixture` calls. */
export async function createDrizzleStore() {
  const dialect = process.env.BENCH_DATABASE ?? 'sqlite';
  if (dialect === 'sqlite') return filename => drizzleStore(process.env.BENCH_SQLITE_PATH ?? filename);
  const url = process.env.BENCH_DATABASE_URL;
  if (!url) throw new Error('Set BENCH_DATABASE_URL for the ' + dialect + ' Drizzle fixture.');
  if (dialect === 'postgresql') return postgresStore(url);
  if (dialect === 'mysql') return mysqlStore(url);
  throw new Error('The Drizzle fixture supports sqlite, postgresql and mysql, not ' + dialect + '.');
}

async function postgresStore(url) {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  await pool.query('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const provider = drizzlePreview(pgDrizzle({ client: pool }));
  const { client } = provider;
  const store = {
    ...serverStore(provider, pgItems),
    update: async (id, name) => (await client.update(pgItems).set({ name }).where(eq(pgItems.id, id)).returning({ id: pgItems.id })).length,
    remove: async id => (await client.delete(pgItems).where(eq(pgItems.id, id)).returning({ id: pgItems.id })).length,
  };
  return () => store;
}

async function mysqlStore(url) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 8 });
  await pool.query('CREATE TABLE IF NOT EXISTS items (id VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL)');
  await pool.query(commitProbeProcedure);
  // Pass the pool directly: drizzle-orm 0.45 does not recognise a mysql2 promise pool given as { client }.
  const provider = drizzlePreview(mysqlDrizzle(pool, { mode: 'default' }));
  const { client } = provider;
  const affected = result => result[0].affectedRows;
  const store = {
    ...serverStore(provider, mysqlItems),
    update: async (id, name) => affected(await client.update(mysqlItems).set({ name }).where(eq(mysqlItems.id, id))),
    remove: async id => affected(await client.delete(mysqlItems).where(eq(mysqlItems.id, id))),
    escape: statement => client.execute(sql.raw(statement)),
  };
  return () => store;
}

/** Operations common to the server dialects. */
function serverStore(provider, items) {
  const { client } = provider;
  return {
    provider,
    // Name the positional parameter so the capture's redaction rules can see it is a secret.
    secret: () => provider.withParameterNames(['fixture_secret'],
      () => client.execute(sql`select ${'fixture-secret-value'} as value`)),
    find: async id => (await client.select().from(items).where(eq(items.id, id)))[0],
    insert: (id, name) => client.insert(items).values({ id, name }),
  };
}

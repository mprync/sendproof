/**
 * Disposable databases and table definitions for the Drizzle provider suite.
 *
 * SQLite (through `@test-bench/sqlite`) and PGlite always run in memory. PostgreSQL runs over both
 * `pg` and `postgres` when `BENCH_POSTGRES_URL` is set, and MySQL over `mysql2` when
 * `BENCH_MYSQL_URL` is set. Each server target creates a uniquely named database and drops it after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzlePreview } from '@test-bench/drizzle';
import type { DrizzlePreview, DrizzlePreviewOptions } from '@test-bench/drizzle';
import { SQLiteDatabase } from '@test-bench/sqlite';
import { int, mysqlTable, primaryKey as mysqlPrimaryKey, varchar } from 'drizzle-orm/mysql-core';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, primaryKey as pgPrimaryKey, serial, text } from 'drizzle-orm/pg-core';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js';
import { integer as sqliteInteger, primaryKey as sqlitePrimaryKey, sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import mysql from 'mysql2/promise';
import pg from 'pg';
import postgres from 'postgres';

const pgTables = {
  items: pgTable('items', { id: text('id').primaryKey(), name: text('name').notNull() }),
  counters: pgTable('counters', { id: serial('id').primaryKey(), label: text('label').notNull() }),
  tokens: pgTable('tokens', { id: text('id').primaryKey().$defaultFn(() => randomUUID()), label: text('label').notNull() }),
  pairs: pgTable('pairs', { a: integer('a').notNull(), b: integer('b').notNull(), value: text('value').notNull() },
    table => [pgPrimaryKey({ columns: [table.a, table.b] })]),
  notes: pgTable('notes', { body: text('body').notNull() }),
};

const mysqlTables = {
  items: mysqlTable('items', { id: varchar('id', { length: 64 }).primaryKey(), name: varchar('name', { length: 200 }).notNull() }),
  counters: mysqlTable('counters', { id: int('id').autoincrement().primaryKey(), label: varchar('label', { length: 200 }).notNull() }),
  tokens: mysqlTable('tokens', {
    id: varchar('id', { length: 64 }).primaryKey().$defaultFn(() => randomUUID()),
    label: varchar('label', { length: 200 }).notNull(),
  }),
  pairs: mysqlTable('pairs', { a: int('a').notNull(), b: int('b').notNull(), value: varchar('value', { length: 200 }).notNull() },
    table => [mysqlPrimaryKey({ columns: [table.a, table.b] })]),
  notes: mysqlTable('notes', { body: varchar('body', { length: 200 }).notNull() }),
};

const sqliteTables = {
  items: sqliteTable('items', { id: sqliteText('id').primaryKey(), name: sqliteText('name').notNull() }),
  counters: sqliteTable('counters', { id: sqliteInteger('id').primaryKey({ autoIncrement: true }), label: sqliteText('label').notNull() }),
  tokens: sqliteTable('tokens', { id: sqliteText('id').primaryKey().$defaultFn(() => randomUUID()), label: sqliteText('label').notNull() }),
  pairs: sqliteTable('pairs', { a: sqliteInteger('a').notNull(), b: sqliteInteger('b').notNull(), value: sqliteText('value').notNull() },
    table => [sqlitePrimaryKey({ columns: [table.a, table.b] })]),
  notes: sqliteTable('notes', { body: sqliteText('body').notNull() }),
};

/** The suite's tables. Each target uses its own dialect's definitions with the same shape. */
export type Tables = typeof pgTables;

const ddl = {
  postgresql: [
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE counters (id SERIAL PRIMARY KEY, label TEXT NOT NULL)',
    'CREATE TABLE tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL)',
    'CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (a, b))',
    'CREATE TABLE notes (body TEXT NOT NULL)',
  ],
  mysql: [
    'CREATE TABLE items (id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL)',
    'CREATE TABLE counters (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(200) NOT NULL)',
    'CREATE TABLE tokens (id VARCHAR(64) PRIMARY KEY, label VARCHAR(200) NOT NULL)',
    'CREATE TABLE pairs (a INT NOT NULL, b INT NOT NULL, value VARCHAR(200) NOT NULL, PRIMARY KEY (a, b))',
    'CREATE TABLE notes (body VARCHAR(200) NOT NULL)',
  ],
  sqlite: [
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)',
    'CREATE TABLE tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL)',
    'CREATE TABLE pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (a, b))',
    'CREATE TABLE notes (body TEXT NOT NULL)',
  ],
};

/** The client type is shared for test code; each target's real client matches its dialect. */
// The suite drives every dialect through the same query-builder calls.
export type Client = ReturnType<typeof pgDrizzle<Record<string, never>>>;

export interface Opened {
  provider: DrizzlePreview<Client>;
  client: Client;
  tables: Tables;
  /** Create another provider over the same database, for option tests. */
  provide(options?: DrizzlePreviewOptions): DrizzlePreview<Client>;
  /** A provider over a fresh connection pool that a test may break, or undefined when unsupported. */
  disposable?(): Promise<{ provider: DrizzlePreview<Client>; close(): Promise<void> }>;
  /** Ids in a table read on an independent connection, outside every Preview. */
  ids(table?: 'items' | 'counters' | 'tokens'): Promise<string[]>;
  /** SQL that ends the database session the statement runs on. */
  killSession?: string;
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface Target {
  name: string;
  dialect: 'postgresql' | 'mysql' | 'sqlite';
  open(): Promise<Opened>;
}

const uniqueName = () => 'bench_drizzle_' + process.pid + '_' + randomBytes(4).toString('hex');
const tableNames = ['items', 'counters', 'tokens', 'pairs', 'notes'];

const sqlite: Target = {
  name: 'SQLite',
  dialect: 'sqlite',
  async open() {
    const database = new SQLiteDatabase(':memory:', { schema: ddl.sqlite.join(';\n') });
    const provide = (options?: DrizzlePreviewOptions) => drizzlePreview(database, options) as unknown as DrizzlePreview<Client>;
    const provider = provide();
    return {
      provider, provide, client: provider.client, tables: sqliteTables as unknown as Tables,
      ids: async (table = 'items') => (await database.all('SELECT id FROM ' + table + ' ORDER BY id')).map(row => String(row['id'])),
      async reset() {
        for (const name of tableNames) await database.write('DELETE FROM ' + name);
      },
      cleanup: () => database.close(),
    };
  },
};

const pglite: Target = {
  name: 'PGlite',
  dialect: 'postgresql',
  async open() {
    const client = new PGlite();
    for (const statement of ddl.postgresql) await client.exec(statement);
    const database = pgliteDrizzle({ client });
    const provide = (options?: DrizzlePreviewOptions) => drizzlePreview(database, options) as unknown as DrizzlePreview<Client>;
    const provider = provide();
    return {
      provider, provide, client: provider.client, tables: pgTables,
      ids: async (table = 'items') => (await client.query<{ id: unknown }>('SELECT id FROM ' + table + ' ORDER BY id')).rows.map(row => String(row.id)),
      reset: async () => { await client.exec('TRUNCATE ' + tableNames.join(', ') + ' RESTART IDENTITY'); },
      cleanup: () => client.close(),
    };
  },
};

function postgresServer(name: string, driver: 'pg' | 'postgres', raw: string): Target {
  return {
    name,
    dialect: 'postgresql',
    async open() {
      const created = uniqueName();
      const admin = new pg.Pool({ connectionString: raw, max: 1 });
      await admin.query('CREATE DATABASE ' + created);
      const url = new URL(raw);
      url.pathname = '/' + created;
      const reader = new pg.Pool({ connectionString: url.toString(), max: 2 });
      for (const statement of ddl.postgresql) await reader.query(statement);
      const pools: { end(): Promise<void> }[] = [];
      const connect = () => {
        if (driver === 'pg') {
          const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
          // A test may end the session under a checked-out client; keep its error event handled.
          pool.on('error', () => {});
          pool.on('connect', connection => { connection.on('error', () => {}); });
          pools.push(pool);
          return pgDrizzle({ client: pool });
        }
        const sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
        pools.push({ end: () => sql.end() });
        return postgresDrizzle({ client: sql }) as unknown as Client;
      };
      const database = connect();
      const provide = (options?: DrizzlePreviewOptions) => drizzlePreview(database, options) as unknown as DrizzlePreview<Client>;
      const provider = provide();
      return {
        provider, provide, client: provider.client, tables: pgTables,
        async disposable() {
          const isolated = connect();
          const pool = pools.at(-1)!;
          return { provider: drizzlePreview(isolated) as unknown as DrizzlePreview<Client>, close: () => pool.end() };
        },
        // postgres 3.4.7 throws from a socket callback when its backend is terminated, so only pg runs this.
        ...(driver === 'pg' ? { killSession: 'SELECT pg_terminate_backend(pg_backend_pid())' } : {}),
        ids: async (table = 'items') => (await reader.query('SELECT id FROM ' + table + ' ORDER BY id')).rows.map(row => String(row.id)),
        reset: async () => { await reader.query('TRUNCATE ' + tableNames.join(', ') + ' RESTART IDENTITY'); },
        async cleanup() {
          for (const pool of pools) await pool.end().catch(() => {});
          await reader.end();
          await admin.query('DROP DATABASE ' + created + ' WITH (FORCE)');
          await admin.end();
        },
      };
    },
  };
}

function mysqlServer(raw: string): Target {
  return {
    name: 'MySQL',
    dialect: 'mysql',
    async open() {
      const created = uniqueName();
      const admin = mysql.createPool({ uri: raw, connectionLimit: 1 });
      await admin.query('CREATE DATABASE ' + created);
      const url = new URL(raw);
      url.pathname = '/' + created;
      const reader = mysql.createPool({ uri: url.toString(), connectionLimit: 2 });
      for (const statement of ddl.mysql) await reader.query(statement);
      const pools: mysql.Pool[] = [];
      const connect = () => {
        const pool = mysql.createPool({ uri: url.toString(), connectionLimit: 4 });
        pools.push(pool);
        return mysqlDrizzle(pool, { mode: 'default' }) as unknown as Client;
      };
      const database = connect();
      const provide = (options?: DrizzlePreviewOptions) => drizzlePreview(database as never, options) as unknown as DrizzlePreview<Client>;
      const provider = provide();
      return {
        provider, provide, client: provider.client, tables: mysqlTables as unknown as Tables,
        async disposable() {
          const isolated = connect();
          const pool = pools.at(-1)!;
          return { provider: drizzlePreview(isolated as never) as unknown as DrizzlePreview<Client>, close: () => pool.end() };
        },
        killSession: 'KILL CONNECTION_ID()',
        async ids(table = 'items') {
          const [rows] = await reader.query('SELECT id FROM ' + table + ' ORDER BY id');
          return (rows as { id: unknown }[]).map(row => String(row.id));
        },
        async reset() {
          for (const name of tableNames) await reader.query('TRUNCATE TABLE ' + name);
        },
        async cleanup() {
          for (const pool of pools) await pool.end().catch(() => {});
          await reader.end();
          await admin.query('DROP DATABASE ' + created);
          await admin.end();
        },
      };
    },
  };
}

/** Every target this environment can run. */
export function targets(): Target[] {
  const list = [sqlite, pglite];
  const postgresUrl = process.env['BENCH_POSTGRES_URL'];
  if (postgresUrl) list.push(postgresServer('PostgreSQL (pg)', 'pg', postgresUrl), postgresServer('PostgreSQL (postgres)', 'postgres', postgresUrl));
  const mysqlUrl = process.env['BENCH_MYSQL_URL'];
  if (mysqlUrl) list.push(mysqlServer(mysqlUrl));
  return list;
}

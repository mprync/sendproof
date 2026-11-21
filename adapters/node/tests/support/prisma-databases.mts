/**
 * Disposable databases for the Prisma provider suite.
 *
 * SQLite always runs, in a temporary file. PostgreSQL and MySQL run when `BENCH_POSTGRES_URL` or
 * `BENCH_MYSQL_URL` point at a server. Each run creates a uniquely named database on that server,
 * creates the test tables itself and drops the database afterwards. Clients come from the
 * fixture schemas in examples/prisma/<database>, generated with `npm run generate-prisma-fixture`.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlDriverAdapterFactory } from '@prisma/driver-adapter-utils';
import type { PrismaModelMetadata } from '@sendproof/prisma';

/** The generated client, typed loosely because each database has its own generated module. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Client = any;

export interface TestDatabase {
  name: string;
  provider: 'sqlite' | 'postgresql' | 'mysql';
  models: PrismaModelMetadata;
  /** A fresh driver adapter factory for the database. */
  adapter(): Promise<SqlDriverAdapterFactory>;
  /** MySQL only: an adapter factory whose connections run with `autocommit=0`, as JDBC-style drivers do. */
  manualCommitAdapter?(): Promise<SqlDriverAdapterFactory>;
  /** MySQL only: run SQL the prepared-statement protocol refuses, such as `CREATE PROCEDURE`, on the test database. */
  textQuery?(sql: string): Promise<void>;
  /** Construct a generated Prisma client over an adapter. */
  client(adapter: SqlDriverAdapterFactory): Client;
  /** Recreate the test tables, empty. */
  reset(client: Client): Promise<void>;
  /** A placeholder for positional parameter `index` (1-based) in raw SQL. */
  placeholder(index: number): string;
  cleanup(): Promise<void>;
}

export interface Target {
  name: string;
  open(): Promise<TestDatabase>;
}

const uniqueName = () => 'bench_prisma_' + process.pid + '_' + randomBytes(4).toString('hex');

const tables = {
  sqlite: [
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id), body TEXT NOT NULL)',
    'CREATE TABLE entries (book TEXT NOT NULL, line INTEGER NOT NULL, amount_minor BIGINT NOT NULL, PRIMARY KEY (book, line))',
  ],
  postgresql: [
    'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE notes (id SERIAL PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), body TEXT NOT NULL)',
    'CREATE TABLE entries (book TEXT NOT NULL, line INTEGER NOT NULL, amount_minor BIGINT NOT NULL, PRIMARY KEY (book, line))',
  ],
  mysql: [
    'CREATE TABLE items (id VARCHAR(191) PRIMARY KEY, name VARCHAR(255) NOT NULL)',
    'CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, item_id VARCHAR(191) NOT NULL, body VARCHAR(255) NOT NULL, FOREIGN KEY (item_id) REFERENCES items(id))',
    'CREATE TABLE entries (book VARCHAR(191) NOT NULL, line INT NOT NULL, amount_minor BIGINT NOT NULL, PRIMARY KEY (book, line))',
  ],
} as const;

async function generated(provider: TestDatabase['provider']) {
  const base = `../../examples/prisma/${provider}/generated/`;
  const { PrismaClient } = await import(base + 'client.ts') as { PrismaClient: new (options: object) => Client };
  const { models } = await import(base + 'sendproof/index.js') as { models: PrismaModelMetadata };
  return { PrismaClient, models };
}

function database(
  name: string,
  provider: TestDatabase['provider'],
  generatedModules: Awaited<ReturnType<typeof generated>>,
  adapter: () => Promise<SqlDriverAdapterFactory>,
  cleanup: () => Promise<void>,
): TestDatabase {
  return {
    name,
    provider,
    models: generatedModules.models,
    adapter,
    client: factory => new generatedModules.PrismaClient({ adapter: factory }),
    async reset(client) {
      for (const table of ['notes', 'entries', 'items']) await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
      for (const statement of tables[provider]) await client.$executeRawUnsafe(statement);
    },
    placeholder: index => provider === 'postgresql' ? '$' + index : '?',
    cleanup,
  };
}

const sqlite: Target = {
  name: 'SQLite',
  async open() {
    const modules = await generated('sqlite');
    const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3');
    const directory = await mkdtemp(join(tmpdir(), 'sendproof-prisma-'));
    let count = 0;
    // Each adapter gets its own file so a poisoned connection never affects another test.
    return database('SQLite', 'sqlite', modules,
      async () => new PrismaBetterSqlite3({ url: 'file:' + join(directory, `db-${count++}.sqlite`) }),
      () => rm(directory, { recursive: true, force: true }));
  },
};

function postgres(raw: string): Target {
  return {
    name: 'PostgreSQL',
    async open() {
      const modules = await generated('postgresql');
      const { default: pg } = await import('pg');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const created = uniqueName();
      const admin = new pg.Client({ connectionString: raw });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${created}"`);
      const url = new URL(raw);
      url.pathname = '/' + created;
      return database('PostgreSQL', 'postgresql', modules,
        async () => new PrismaPg({ connectionString: url.toString() }),
        async () => {
          await admin.query(`DROP DATABASE "${created}" WITH (FORCE)`);
          await admin.end();
        });
    },
  };
}

function mysql(raw: string): Target {
  return {
    name: 'MySQL',
    async open() {
      const modules = await generated('mysql');
      const { createConnection } = await import('mysql2/promise');
      const { PrismaMariaDb } = await import('@prisma/adapter-mariadb');
      const created = uniqueName();
      const admin = await createConnection(raw);
      await admin.query(`CREATE DATABASE \`${created}\``);
      const url = new URL(raw);
      url.pathname = '/' + created;
      url.searchParams.set('allowPublicKeyRetrieval', 'true');
      const manual = {
        host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password), database: created, allowPublicKeyRetrieval: true,
        initSql: 'SET autocommit = 0', connectionLimit: 2,
      };
      return {
        ...database('MySQL', 'mysql', modules,
          async () => new PrismaMariaDb(url.toString()),
          async () => {
            await admin.query(`DROP DATABASE \`${created}\``);
            await admin.end();
          }),
        manualCommitAdapter: async () => new PrismaMariaDb(manual),
        async textQuery(sql) {
          const connection = await createConnection(url.toString());
          try { await connection.query(sql); } finally { await connection.end(); }
        },
      };
    },
  };
}

/** SQLite plus every server database configured in the environment. */
export function targets(): Target[] {
  const result = [sqlite];
  if (process.env.BENCH_POSTGRES_URL) result.push(postgres(process.env.BENCH_POSTGRES_URL));
  if (process.env.BENCH_MYSQL_URL) result.push(mysql(process.env.BENCH_MYSQL_URL));
  return result;
}

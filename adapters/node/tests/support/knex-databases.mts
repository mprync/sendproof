/**
 * Disposable databases for the Knex provider suite.
 *
 * SQLite always runs in memory. PostgreSQL, MySQL and SQL Server run when `BENCH_POSTGRES_URL`,
 * `BENCH_MYSQL_URL` or `BENCH_SQLSERVER_URL` point at a server. Each run creates a uniquely named
 * database on that server and drops it afterwards.
 */
import { randomBytes } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';

export interface TestDatabase {
  name: string;
  database: Knex;
  /** Destroy the pool and drop the database this target created. */
  cleanup(): Promise<void>;
}

export interface Target {
  name: string;
  open(): Promise<TestDatabase>;
}

const uniqueName = () => 'bench_knex_' + process.pid + '_' + randomBytes(4).toString('hex');

function mssqlConfig(url: URL, database: string): Knex.Config {
  return {
    client: 'mssql',
    connection: {
      server: url.hostname,
      port: Number(url.port || 1433),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      options: {
        encrypt: url.searchParams.get('encrypt') !== 'false',
        trustServerCertificate: url.searchParams.get('trustServerCertificate') === 'true',
      },
    },
  };
}

/** A server target that creates and drops a database next to the one the URL names. */
function server(name: string, client: 'pg' | 'mysql2' | 'mssql', raw: string): Target {
  const url = new URL(raw);
  const config = (database: string): Knex.Config => {
    if (client === 'mssql') return mssqlConfig(url, database);
    const target = new URL(raw);
    target.pathname = '/' + database;
    return { client, connection: target.toString() };
  };
  return {
    name,
    async open() {
      const created = uniqueName();
      const admin = knex(config(decodeURIComponent(url.pathname.slice(1))));
      await admin.raw('CREATE DATABASE ??', [created]);
      const database = knex(config(created));
      return {
        name,
        database,
        async cleanup() {
          await database.destroy();
          if (client === 'pg') await admin.raw('DROP DATABASE ?? WITH (FORCE)', [created]);
          else if (client === 'mssql') {
            await admin.raw('ALTER DATABASE ?? SET SINGLE_USER WITH ROLLBACK IMMEDIATE', [created]);
            await admin.raw('DROP DATABASE ??', [created]);
          } else await admin.raw('DROP DATABASE ??', [created]);
          await admin.destroy();
        },
      };
    },
  };
}

const sqlite: Target = {
  name: 'SQLite',
  async open() {
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 }, useNullAsDefault: true });
    return { name: 'SQLite', database, cleanup: () => database.destroy() };
  },
};

/** Every database the current environment can reach. */
export function targets(env: NodeJS.ProcessEnv = process.env): Target[] {
  return [
    sqlite,
    ...(env['BENCH_POSTGRES_URL'] ? [server('PostgreSQL', 'pg', env['BENCH_POSTGRES_URL'])] : []),
    ...(env['BENCH_MYSQL_URL'] ? [server('MySQL', 'mysql2', env['BENCH_MYSQL_URL'])] : []),
    ...(env['BENCH_SQLSERVER_URL'] ? [server('SQL Server', 'mssql', env['BENCH_SQLSERVER_URL'])] : []),
  ];
}

/** Create the tables the provider suite uses, replacing any left from an earlier test. */
export async function resetSchema(database: Knex): Promise<void> {
  for (const table of ['items', 'lines', 'serial', 'plain']) await database.schema.dropTableIfExists(table);
  await database.schema.createTable('items', table => {
    table.string('id', 150).primary();
    table.string('name', 150).notNullable();
  });
  await database.schema.createTable('lines', table => {
    table.string('order_id', 50).notNullable();
    table.integer('line_no').notNullable();
    table.integer('qty').notNullable();
    table.primary(['order_id', 'line_no']);
  });
  await database.schema.createTable('serial', table => {
    table.increments('id');
    table.string('label', 150).notNullable();
  });
  await database.schema.createTable('plain', table => {
    table.string('a', 50).notNullable();
  });
}

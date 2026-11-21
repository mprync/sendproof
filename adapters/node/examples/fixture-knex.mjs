import knex from 'knex';
import { KnexPreview } from '@test-bench/knex';

/** Conformance database families, as the runner names them in BENCH_DATABASE. */
const labels = { sqlite: 'SQLite', postgresql: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server' };

/** The BENCH_DATABASE family this fixture runs against. */
export function knexDatabase(env = process.env) {
  const family = env.BENCH_DATABASE ?? 'sqlite';
  if (!Object.hasOwn(labels, family)) throw new Error('Unsupported BENCH_DATABASE: ' + family);
  return family;
}

/** Display label for the fixture's `database` option, such as `PostgreSQL`. */
export function knexDatabaseLabel(env = process.env) {
  return labels[knexDatabase(env)];
}

function requireUrl(env) {
  if (!env.BENCH_DATABASE_URL) throw new Error('BENCH_DATABASE_URL is required for BENCH_DATABASE=' + env.BENCH_DATABASE);
  return new URL(env.BENCH_DATABASE_URL);
}

/** Knex configuration for the runner's disposable database. */
export function knexConfig(env = process.env) {
  const family = knexDatabase(env);
  if (family === 'sqlite') {
    return { client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true };
  }
  const url = requireUrl(env);
  if (family === 'postgresql') return { client: 'pg', connection: env.BENCH_DATABASE_URL };
  if (family === 'mysql') return { client: 'mysql2', connection: env.BENCH_DATABASE_URL };
  return {
    client: 'mssql',
    connection: {
      server: url.hostname,
      port: Number(url.port || 1433),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      options: {
        encrypt: url.searchParams.get('encrypt') !== 'false',
        trustServerCertificate: url.searchParams.get('trustServerCertificate') === 'true',
      },
    },
  };
}

/** Create the fixture's `items` table and return the store factory the shared fixture service uses. */
export async function createKnexStore(env = process.env) {
  const database = knex(knexConfig(env));
  await database.schema.dropTableIfExists('items');
  await database.schema.createTable('items', table => {
    table.string('id', 150).primary();
    table.string('name', 150).notNullable();
  });
  // The provider's client tracks inserts, updates and deletes from the builder itself.
  const provider = new KnexPreview(database);
  return () => ({
    provider,
    secret: () => provider.withParameterNames(['fixture_secret'], () =>
      provider.client.raw('SELECT :fixture_secret AS value', { fixture_secret: 'fixture-secret-value' })),
    find: id => provider.client('items').where({ id }).first(),
    insert: (id, name) => provider.client('items').insert({ id, name }),
    update: (id, name) => provider.client('items').where({ id }).update({ name }),
    remove: id => provider.client('items').where({ id }).delete(),
  });
}

/**
 * Prisma conformance store for the shared Node fixture.
 *
 * BENCH_DATABASE selects sqlite (default), postgresql or mysql. Server databases use
 * BENCH_DATABASE_URL, which the runner points at a fresh, empty database. The store creates
 * its own table, then captures changes automatically from the generated model metadata.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPreview } from '@test-bench/prisma';

const dialects = {
  sqlite: {
    schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    secret: 'SELECT ? AS value',
    async adapter() {
      const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3');
      const directory = process.env.BENCH_TMP_DIR ?? await mkdtemp(join(tmpdir(), 'test-bench-prisma-'));
      return new PrismaBetterSqlite3({ url: 'file:' + join(directory, 'fixture.db') });
    },
  },
  postgresql: {
    schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
    secret: 'SELECT $1::text AS value',
    async adapter(url) {
      const { PrismaPg } = await import('@prisma/adapter-pg');
      return new PrismaPg({ connectionString: url });
    },
  },
  mysql: {
    schema: 'CREATE TABLE items (id VARCHAR(191) PRIMARY KEY, name VARCHAR(255) NOT NULL)',
    secret: 'SELECT ? AS value',
    async adapter(url) {
      const { PrismaMariaDb } = await import('@prisma/adapter-mariadb');
      return new PrismaMariaDb(mariadbUrl(url));
    },
  },
};

/** MySQL 8 uses caching_sha2_password, which needs the server key on plain loopback connections. */
export function mariadbUrl(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('allowPublicKeyRetrieval')) parsed.searchParams.set('allowPublicKeyRetrieval', 'true');
  return parsed.toString();
}

export async function createPrismaStore(database = process.env.BENCH_DATABASE ?? 'sqlite') {
  const dialect = dialects[database];
  if (!dialect) throw new Error('Unsupported BENCH_DATABASE for Prisma: ' + database);
  const url = process.env.BENCH_DATABASE_URL;
  if (database !== 'sqlite' && !url) throw new Error('BENCH_DATABASE_URL is required for ' + database);
  const { PrismaClient } = await import(`./prisma/${database}/generated/client.ts`);
  const { models } = await import(`./prisma/${database}/generated/test-bench/index.js`);

  const provider = new PrismaPreview(await dialect.adapter(url), { models });
  provider.attach(new PrismaClient({ adapter: provider.adapter }));
  await provider.client.$executeRawUnsafe(dialect.schema);

  return () => ({
    provider,
    secret: () => provider.withParameterNames(['fixture_secret'], () =>
      provider.run(client => client.$queryRawUnsafe(dialect.secret, 'fixture-secret-value'))),
    find: id => provider.run(client => client.item.findUnique({ where: { id }, select: { id: true, name: true } })),
    insert: (id, name) => provider.run(client => client.item.create({ data: { id, name } })),
    update: async (id, name) => (await provider.run(client => client.item.updateMany({ where: { id }, data: { name } }))).count,
    remove: async id => (await provider.run(client => client.item.deleteMany({ where: { id } }))).count,
  });
}

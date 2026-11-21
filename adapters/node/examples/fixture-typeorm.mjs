import 'reflect-metadata';
import { DataSource, EntitySchema } from 'typeorm';
import { TypeOrmPreview } from '@test-bench/typeorm';

/**
 * The fixture's only table. The Entity declares its primary column, which is all Test Bench needs
 * to report row changes: handlers below call plain TypeORM repository methods with no key lists.
 */
export const Item = new EntitySchema({
  name: 'Item', tableName: 'items',
  columns: { id: { type: String, primary: true }, name: { type: String } },
});

/**
 * Connection options per `BENCH_DATABASE` value. The runner provisions a fresh, empty database for
 * PostgreSQL and MySQL and passes its URL in `BENCH_DATABASE_URL`; the fixture creates its own table.
 */
const connections = {
  sqlite: () => ({ type: 'better-sqlite3', database: ':memory:' }),
  postgresql: url => ({ type: 'postgres', url }),
  mysql: url => ({ type: 'mysql', url }),
};

/** Positional-parameter placeholder syntax for the secret-redaction probe, per driver family. */
const placeholders = { sqlite: '?', postgresql: '$1::text', mysql: '?' };

export async function createTypeOrmStore(env = process.env) {
  const dialect = env.BENCH_DATABASE ?? 'sqlite';
  if (!Object.hasOwn(connections, dialect)) throw new Error(`The TypeORM fixture does not support BENCH_DATABASE=${dialect}.`);
  const url = env.BENCH_DATABASE_URL;
  if (dialect !== 'sqlite' && !url) throw new Error('BENCH_DATABASE_URL is required for ' + dialect + '.');
  const source = await new DataSource({ ...connections[dialect](url), entities: [Item], synchronize: true }).initialize();
  const provider = new TypeOrmPreview(source);
  return () => ({
    provider,
    secret: () => provider.withParameterNames(['fixture_secret'], () =>
      provider.run(manager => manager.query(`SELECT ${placeholders[dialect]} AS value`, ['fixture-secret-value']))),
    find: id => provider.run(manager => manager.getRepository(Item).findOneBy({ id })),
    insert: (id, name) => provider.run(manager => manager.getRepository(Item).insert({ id, name })),
    update: async (id, name) => (await provider.run(manager => manager.getRepository(Item).update({ id }, { name }))).affected,
    remove: async id => (await provider.run(manager => manager.getRepository(Item).delete({ id }))).affected,
  });
}

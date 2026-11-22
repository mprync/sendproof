// Cassandra write guard (`@sendproof/cassandra`) against the compose `cassandra` service
// (heavy-stores profile). An independent, unhooked client reads the table after every Preview, so
// a passing check proves the refused statement never reached the server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, concurrent, mapping } from 'cassandra-driver';
import { cassandraStore } from '@sendproof/cassandra';
import { assertBlocked, cassandraContactPoint, dbEntries, fresh, handle, needs, startApp } from './support/stores.mts';

const options = { contactPoints: [cassandraContactPoint], localDataCenter: 'datacenter1', socketOptions: { connectTimeout: 5000 } };

/** A fresh keyspace with `tickets (id, status, hits)`, an unhooked reader, and a hooked client when asked. */
async function setup(t: test.TestContext, hook = true) {
  const keyspace = fresh('cass');
  const reader = new Client(options);
  await reader.connect();
  await reader.execute(`CREATE KEYSPACE ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
  await reader.execute(`CREATE TABLE ${keyspace}.tickets (id text PRIMARY KEY, status text, hits int)`);
  const client = new Client({ ...options, keyspace });
  const store = hook ? cassandraStore(client, { name: 'tickets' }) : undefined;
  await client.connect();
  t.after(async () => {
    try { await reader.execute(`DROP KEYSPACE IF EXISTS ${keyspace}`); } finally { await Promise.allSettled([client.shutdown(), reader.shutdown()]); }
  });
  await reader.execute(`INSERT INTO ${keyspace}.tickets (id, status, hits) VALUES ('seeded', 'open', 1)`);
  const count = async () => Number((await reader.execute(`SELECT count(*) AS n FROM ${keyspace}.tickets`)).first()!.n);
  return { client, reader, keyspace, store, count };
}

/** The app: every way the guarded client can send a write, plus a prepared read. */
async function app(t: test.TestContext, hook = true) {
  const parts = await setup(t, hook);
  const { client } = parts;
  const mapper = new mapping.Mapper(client, { models: { Ticket: { tables: ['tickets'] } } });
  const tickets = mapper.forModel('Ticket');
  const harness = await startApp(t, parts.store ? [parts.store] : [], (bench, db) => {
    bench.operation('GET', '/tickets/{id}', handle(async (req, res) => {
      const result = await client.execute('SELECT id, status, hits FROM tickets WHERE id = ?', [req.params.id], { prepare: true });
      res.status(result.rowLength ? 200 : 404).json(result.first() ?? {});
    }));
    bench.operation('POST', '/tickets/{id}/touch', handle(async (req, res) => {
      await client.execute("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", [req.params.id], { prepare: true });
      res.json({ id: req.params.id });
    }));
    bench.operation('POST', '/tickets/{id}/swallow', handle(async (req, res) => {
      try { await client.execute('UPDATE tickets SET hits = 9 WHERE id = ?', [req.params.id], { prepare: true }); } catch { /* ignored */ }
      res.status(200).json({ ok: true });
    }));
    bench.operation('POST', '/tickets/{id}/close', handle(async (req, res) => {
      await client.batch(["UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS"].map(query => ({ query, params: [req.params.id] })), { prepare: true });
      res.json({ id: req.params.id });
    }));
    bench.operation('POST', '/items/{id}/remember', handle(async (req, res) => {
      await db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: req.params.id as string, name: 'Mixed' }, { table: 'items', keys: [{ id: req.params.id }] });
      await client.execute("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", ['item-' + req.params.id], { prepare: true });
      res.status(201).json({ id: req.params.id });
    }));
    bench.operation('POST', '/via/{how}/{id}', handle(async (req, res) => {
      const id = req.params.id as string;
      const insert = `INSERT INTO tickets (id, status, hits) VALUES ('${id}', 'new', 1)`;
      switch (req.params.how) {
        case 'callback': await new Promise<void>((resolve, reject) => { client.execute(insert, error => error ? reject(error) : resolve()); }); break;
        case 'eachRow': await new Promise<void>((resolve, reject) => { client.eachRow(insert, [], {}, () => {}, error => error ? reject(error) : resolve()); }); break;
        case 'stream': await new Promise<void>((resolve, reject) => { client.stream(insert).on('error', reject).on('end', resolve).on('data', () => {}); }); break;
        case 'multi': await client.execute(`SELECT * FROM tickets; INSERT INTO tickets (id) VALUES ('${id}')`); break;
        case 'ddl': await client.execute(`CREATE TABLE extra_${id} (id text PRIMARY KEY)`); break;
        case 'truncate': await client.execute('TRUNCATE tickets'); break;
        case 'unlogged': await client.batch([insert], { prepare: false }); break;
        case 'empty': await client.batch([]).catch(error => { if (error.name !== 'ArgumentError') throw error; }); break;
        case 'mapper': await tickets.insert({ id, status: 'new', hits: 1 }); break;
        case 'concurrent': await concurrent.executeConcurrent(client, [{ query: 'DELETE FROM tickets WHERE id = ?', params: [id] }]); break;
        case 'graph': await (client as unknown as { executeGraph(query: string): Promise<unknown> }).executeGraph('g.V()'); break;
        default: res.status(400).end(); return;
      }
      res.json({ ok: true });
    }));
  });
  return { ...harness, ...parts };
}

/** The guard checks; the negative test expects them to fail without the hook. */
async function guardChecks(t: test.TestContext, hook = true) {
  const { preview, reader, keyspace, count } = await app(t, hook);
  await assertBlocked(await preview('POST', '/tickets/a/touch'), 'cassandra', 'INSERT');
  await assertBlocked(await preview('POST', '/tickets/seeded/swallow'), 'cassandra', 'UPDATE');
  await assertBlocked(await preview('POST', '/tickets/seeded/close'), 'cassandra', 'BATCH');
  assert.equal(await count(), 1, 'No refused statement may reach Cassandra');
  assert.equal((await reader.execute(`SELECT hits, status FROM ${keyspace}.tickets WHERE id = 'seeded'`)).first()!.hits, 1);
}

test('cassandra: reads run in Preview, are logged without values, and namespace and target are the keyspace and table', await needs('cassandra'), async t => {
  const { confirmed, keyspace } = await app(t);
  const envelope = await confirmed('GET', '/tickets/seeded');
  const [entry] = dbEntries(envelope.logs, 'cassandra', 'SELECT');
  assert(entry, 'Expected a Db entry for SELECT');
  assert.equal(entry.db.statement, 'SELECT id, status, hits FROM tickets WHERE id = ?');
  assert.equal(entry.db.target, 'tickets');
  assert.equal(entry.db.namespace, keyspace);
  assert.equal(entry.db.rowsAffected, 1);
  assert.deepEqual(envelope.body, { id: 'seeded', status: 'open', hits: 1 });
});

test('cassandra: writes, lightweight transactions and logged batches are refused before they are sent', await needs('cassandra'), async t => {
  await guardChecks(t);
});

test('cassandra: every call style and the driver helpers are guarded', await needs('cassandra'), async t => {
  const { preview, count, client } = await app(t);
  const expected: Record<string, string> = {
    callback: 'INSERT', eachRow: 'INSERT', stream: 'INSERT', multi: 'SELECT', ddl: 'CREATE', truncate: 'TRUNCATE', unlogged: 'BATCH',
    mapper: 'INSERT', concurrent: 'DELETE', graph: 'executeGraph',
  };
  for (const [how, operation] of Object.entries(expected)) await assertBlocked(await preview('POST', `/via/${how}/x`), 'cassandra', operation);
  assert.equal(await count(), 1, 'No guarded call style may reach Cassandra');
  assert.equal((await client.execute("SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = 'extra_x'", [client.keyspace])).rowLength, 0);
  // An empty batch is still a write: the guard refuses it before the driver can complain.
  await assertBlocked(await preview('POST', '/via/empty/x'), 'cassandra', 'BATCH');
});

test('cassandra: the guard checks fail without the hook', await needs('cassandra'), async t => {
  await assert.rejects(guardChecks(t, false), assert.AssertionError);
});

test('cassandra: observed Send commits once and traces the statement without values', await needs('cassandra'), async t => {
  const { observed, count, keyspace, reader } = await app(t);
  const { status, trace } = await observed('POST', '/tickets/sent/touch');
  assert.equal(status, 200);
  assert.equal(await count(), 2);
  assert.equal((await reader.execute(`SELECT status FROM ${keyspace}.tickets WHERE id = 'sent'`)).first()!.status, 'new');
  const entries = dbEntries(trace.logs, 'cassandra', 'INSERT');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].db.statement, 'INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)');
  assert(!JSON.stringify(trace).includes('sent'), 'Bound values must not reach a trace');
  const batch = await observed('POST', '/tickets/sent/close');
  assert.equal(batch.status, 200);
  assert.equal(dbEntries(batch.trace.logs, 'cassandra', 'BATCH')[0].db.statement, "BEGIN BATCH UPDATE tickets SET status = ? WHERE id = ? IF EXISTS; APPLY BATCH");
});

test('cassandra: a mixed route rolls the SQL insert back with the blocked Preview', await needs('cassandra'), async t => {
  const { preview, db, count } = await app(t);
  // The SQL insert alone would confirm; the Cassandra write after it blocks the whole request.
  await assertBlocked(await preview('POST', '/items/mixed/remember'), 'cassandra', 'INSERT');
  assert.equal(await count(), 1);
  assert.equal(await db.get('SELECT id FROM items WHERE id = :id', { id: 'mixed' }), undefined);
});

test('cassandra: registration refuses a non-client, a second hook and a URL label, and advertises guard mode', async () => {
  assert.throws(() => cassandraStore({} as object), TypeError);
  const client = new Client(options);
  const store = cassandraStore(client, { name: 'tickets' });
  assert.deepEqual(await store.describe(), { system: 'cassandra', name: 'tickets', mode: 'guard' });
  assert.throws(() => cassandraStore(client), /already hooked/);
  assert.throws(() => cassandraStore(new Client(options), { name: 'cassandra://host:9042' }), TypeError);
});

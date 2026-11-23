/**
 * Shared data-store checks (spec/data-stores.md), run for every manifest entry that lists `stores`.
 *
 * The runner provisions a fresh MongoDB database, Redis key prefix and DynamoDB table per fixture
 * process, seeds them through its own clients, and reads them back through those clients after
 * every Preview. Those clients live in ./stores and share nothing with the binding under test, so
 * an independent read is proof that a blocked or rolled-back Preview left nothing behind.
 *
 * Services default to the addresses in compose.yml. Override them with BENCH_MONGODB_SERVER_URL,
 * BENCH_REDIS_SERVER_URL, BENCH_DYNAMODB_SERVER_URL, BENCH_CASSANDRA_SERVER (host:port) and
 * BENCH_OPENSEARCH_SERVER_URL. Cassandra and OpenSearch come from the compose `heavy-stores` profile.
 *
 * BENCH_STORES, when set, narrows a run to the listed stores (comma-separated): CI's main
 * conformance job sets it to the light stores, and the heavy-stores job runs the rest.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withFixture } from './host.mjs';
import { sessionStores } from './sessions.mjs';
import { connectMongo } from './stores/mongodb.mjs';
import { connectRedis } from './stores/redis.mjs';
import { dynamoClient, fromItem, toItem } from './stores/dynamodb.mjs';
import { connectCassandra } from './stores/cassandra.mjs';
import { openSearchClient } from './stores/opensearch.mjs';

export const storeIds = ['mongodb', 'redis', 'dynamodb', 'cassandra', 'opensearch'];
/** Stores that need the compose `heavy-stores` profile and run in CI's separate heavy-stores job. */
export const heavyStoreIds = ['cassandra', 'opensearch'];
const modes = { mongodb: 'preview', redis: 'guard', dynamodb: 'guard', cassandra: 'guard', opensearch: 'guard' };
const names = { mongodb: 'MongoDB', redis: 'Redis', dynamodb: 'DynamoDB', cassandra: 'Cassandra', opensearch: 'OpenSearch' };

const servers = {
  mongodb: process.env.BENCH_MONGODB_SERVER_URL ?? 'mongodb://127.0.0.1:57017/?directConnection=true',
  redis: process.env.BENCH_REDIS_SERVER_URL ?? 'redis://:bench_redis_local@127.0.0.1:56379',
  dynamodb: process.env.BENCH_DYNAMODB_SERVER_URL ?? 'http://127.0.0.1:58000',
  cassandra: process.env.BENCH_CASSANDRA_SERVER ?? '127.0.0.1:59042',
  opensearch: process.env.BENCH_OPENSEARCH_SERVER_URL ?? 'http://127.0.0.1:59200',
};

/** The stores a run checks for a manifest entry: its `stores`, narrowed by BENCH_STORES when that is set. */
export function storesFor(binding) {
  const listed = binding.stores ?? [];
  if (process.env.BENCH_STORES === undefined) return listed;
  const only = process.env.BENCH_STORES.split(',').map(item => item.trim()).filter(Boolean);
  return listed.filter(store => only.includes(store));
}
// DynamoDB Local accepts any well-formed credentials; the secret is a marker that must never reach a capture.
const aws = { AWS_ACCESS_KEY_ID: 'benchlocal', AWS_SECRET_ACCESS_KEY: 'benchDynamoSecret' + randomBytes(6).toString('hex'), AWS_REGION: 'us-east-1' };

const base = '/tenant';
const rollback = { Prefer: 'tx=rollback' };
const fresh = () => 'tb_' + randomBytes(8).toString('hex');

/**
 * Provisions a namespace in each listed store, runs `run(env, readers)`, then removes it.
 * `env` is passed to the fixture; `readers` are the runner's independent clients.
 */
export async function withStores(stores, run) {
  const env = {};
  const readers = {};
  const cleanup = [];
  try {
    if (stores.includes('mongodb')) {
      const server = new URL(servers.mongodb);
      const target = new URL(server);
      target.pathname = '/' + fresh();
      env.BENCH_MONGODB_URL = target.href;
      readers.mongodb = await connectMongo(target.href);
      cleanup.push(async () => {
        await readers.mongodb.command({ dropDatabase: 1 });
        await readers.mongodb.close();
      });
    }
    if (stores.includes('redis')) {
      env.BENCH_REDIS_URL = servers.redis;
      env.BENCH_REDIS_PREFIX = fresh() + ':';
      readers.redis = await connectRedis(servers.redis);
      readers.redis.prefix = env.BENCH_REDIS_PREFIX;
      cleanup.push(async () => {
        const keys = await readers.redis.keys(env.BENCH_REDIS_PREFIX + '*');
        if (keys.length) await readers.redis.send('DEL', ...keys);
        await readers.redis.close();
      });
    }
    if (stores.includes('dynamodb')) {
      const table = fresh();
      Object.assign(env, aws, { BENCH_DYNAMODB_URL: servers.dynamodb, BENCH_DYNAMODB_TABLE: table });
      const client = dynamoClient({ endpoint: servers.dynamodb, region: aws.AWS_REGION, accessKeyId: aws.AWS_ACCESS_KEY_ID, secretAccessKey: aws.AWS_SECRET_ACCESS_KEY });
      await client.call('CreateTable', {
        TableName: table, BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      });
      readers.dynamodb = { ...client, table };
      cleanup.push(() => client.call('DeleteTable', { TableName: table }));
    }
    if (stores.includes('cassandra')) {
      const keyspace = fresh();
      Object.assign(env, { BENCH_CASSANDRA_CONTACT_POINT: servers.cassandra, BENCH_CASSANDRA_KEYSPACE: keyspace });
      const client = await connectCassandra(servers.cassandra);
      cleanup.push(async () => {
        await client.query(`DROP KEYSPACE IF EXISTS "${keyspace}"`);
        await client.close();
      });
      await client.query(`CREATE KEYSPACE "${keyspace}" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
      await client.query(`CREATE TABLE "${keyspace}".tickets (id text PRIMARY KEY, status text, hits int)`);
      readers.cassandra = { ...client, keyspace };
    }
    if (stores.includes('opensearch')) {
      const index = fresh();
      Object.assign(env, { BENCH_OPENSEARCH_URL: servers.opensearch, BENCH_OPENSEARCH_INDEX: index });
      const client = openSearchClient(servers.opensearch);
      cleanup.push(() => client.request('DELETE', '/' + index));
      const created = await client.request('PUT', '/' + index, {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: { properties: { title: { type: 'keyword' }, views: { type: 'integer' }, hidden: { type: 'boolean' } } },
      });
      assert.equal(created.status, 200, `Creating the OpenSearch index failed: ${JSON.stringify(created.body)}`);
      readers.opensearch = { ...client, index };
    }
    return await run(env, readers);
  } finally {
    for (const step of cleanup.reverse()) await step().catch(error => console.error(`Data store cleanup failed: ${error.message}`));
  }
}

async function status(response, expected) {
  const allowed = [expected].flat();
  if (!allowed.includes(response.status)) {
    assert.fail(`Expected HTTP ${allowed.join(' or ')}, got ${response.status} from ${response.url}\n${(await response.text()).slice(0, 1000)}`);
  }
  return response;
}

/** A successful Preview envelope, schema-checked, with the confirmation headers. */
async function confirmed(response, schemas) {
  await status(response, 200);
  assert.equal(response.headers.get('preference-applied'), 'tx=rollback');
  const envelope = await response.json();
  schemas.assert('preview', envelope);
  return envelope;
}

/** Ajv validator for the blocked-Preview problem body, compiled once. */
const blockedSchema = (async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile(new URL('../../spec/preview-unavailable.schema.json', import.meta.url), 'utf8'));
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
})();

/** A blocked Preview: 409 problem+json, never a confirmation, naming the store and the refused command. */
async function blocked(response, store, operation) {
  await status(response, 409);
  assert.equal(response.headers.get('preference-applied'), null, 'A blocked Preview must not claim a rollback');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json\b/);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  const problem = await response.json();
  const validate = await blockedSchema;
  assert(validate(problem), JSON.stringify(validate.errors));
  assert.equal(problem.store, store);
  assert.equal(problem.operation.toUpperCase(), operation.toUpperCase());
  return problem;
}

/** A Preview the server refused without confirming anything. */
async function unconfirmed(response, expected) {
  await status(response, expected);
  assert.equal(response.headers.get('preference-applied'), null);
  const content = await response.text();
  if (content && response.headers.get('content-type')?.includes('json')) assert.notEqual(JSON.parse(content).rolledBack, true);
}

const dbEntries = (logs, system, operation) => logs.filter(entry => entry.level === 'Db' && entry.db?.system === system &&
  (!operation || entry.db.operation.toUpperCase() === operation.toUpperCase()));

/**
 * Runs the data-store checks against a fresh standard-scenario fixture with the stores the entry
 * lists. `extra(request, cookie)` runs inside the same fixture first (the reference uses it for the
 * shared security rules). Entries without `stores` report the checks as not implemented.
 */
export async function dataStores(t, binding, schemas, extra) {
  const listed = binding.stores ?? [];
  assert(listed.every(store => storeIds.includes(store)), `Unknown store in ${binding.id}: ${listed}`);
  const stores = storesFor(binding);
  const skipped = listed.filter(store => !stores.includes(store));
  if (skipped.length) {
    await t.test(`Data stores: ${skipped.map(store => names[store]).join(', ')}`, { skip: 'excluded by BENCH_STORES; CI runs these in the heavy-stores job' }, () => {});
  }
  if (!stores.length) {
    if (!listed.length) await t.test('Data stores', { skip: 'not implemented: list "stores" in bindings.json and add the routes in spec/conformance/fixture.md' }, () => {});
    else if (extra) await withFixture(binding, 'standard', base, request => extra(request));
    return;
  }
  await withStores(stores, (env, readers) =>
    withFixture({ ...binding, env: { ...binding.env, ...env } }, 'standard', base, async request => {
      await extra?.(request);
      await checks(t, request, schemas, stores, env, readers);
    }));
}

async function checks(t, request, schemas, stores, env, readers) {
  const signIn = await status(await request(base + '/auth/sign-in', {
    method: 'POST', body: { email: 'admin@example.test', password: 'bench-fixture' },
  }), [200, 204]);
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Expected a session cookie');
  await signIn.body?.cancel();

  /** Every capture the checks see, searched for secrets at the end. */
  const captured = [];
  const go = (method, path, body) => request(base + '/sendproof/_preview' + path, { method, cookie, headers: rollback, body });
  const preview = async (method, path, body) => {
    const envelope = await confirmed(await go(method, path, body), schemas);
    captured.push(envelope);
    return envelope;
  };
  const send = async (method, path, body, expected) => {
    const response = await status(await request(base + path, { method, cookie, body, headers: { Prefer: 'trace' } }), expected);
    const result = await response.json();
    const id = response.headers.get('x-sendproof-trace');
    assert(id, `Expected a trace for observed Send of ${method} ${path}`);
    const trace = await (await status(await request(base + '/sendproof/_api/traces/' + encodeURIComponent(id), { cookie }), 200)).json();
    schemas.assert('trace', trace);
    captured.push(trace);
    return { result, trace };
  };

  const redisKey = key => readers.redis.prefix + 'counter:' + key;
  const order = async id => fromItem((await readers.dynamodb.call('GetItem', { TableName: readers.dynamodb.table, Key: { id: { S: id } }, ConsistentRead: true })).Item);
  const documents = filter => readers.mongodb.find('documents', filter);
  const ticket = async id => (await readers.cassandra.query(`SELECT id, status, hits FROM "${readers.cassandra.keyspace}".tickets WHERE id = ?`, [id])).rows[0] ?? null;
  const article = async id => {
    const reply = await readers.opensearch.request('GET', `/${readers.opensearch.index}/_doc/${encodeURIComponent(id)}`);
    return reply.body?.found ? reply.body._source : null;
  };

  // Seed data through the runner's own clients.
  if (readers.redis) await readers.redis.send('SET', redisKey('seeded'), '5');
  if (readers.dynamodb) await readers.dynamodb.call('PutItem', { TableName: readers.dynamodb.table, Item: toItem({ id: 'seeded', status: 'open', hits: 3 }) });
  if (readers.mongodb) {
    await readers.mongodb.command({ insert: 'documents', documents: [{ _id: 'seeded', name: 'Seeded', profile: { city: 'Leeds' }, password_hash: 'hashed:seeded-secret' }] });
  }
  if (readers.cassandra) {
    await readers.cassandra.query(`INSERT INTO "${readers.cassandra.keyspace}".tickets (id, status, hits) VALUES (?, ?, ?)`, ['seeded', 'open', 3]);
  }
  if (readers.opensearch) {
    const seeded = await readers.opensearch.request('PUT', `/${readers.opensearch.index}/_doc/seeded?refresh=true`, { title: 'Seeded', views: 3 });
    assert.equal(seeded.status, 201, `Seeding OpenSearch failed: ${JSON.stringify(seeded.body)}`);
  }

  /**
   * What each guard-mode store's checks do: the read route and its expected body and Db operation,
   * two guarded writes (each with an independent read proving nothing reached the store), the
   * write the mixed SQL route makes, and the preview:false route.
   */
  const guarded = {
    redis: {
      read: { path: '/counters/seeded', body: { key: 'seeded', value: 5 }, operation: 'GET' },
      writes: [
        { path: '/counters/blocked', operation: 'INCR', untouched: async () => assert.equal(await readers.redis.send('GET', redisKey('blocked')), null, 'INCR must not reach Redis') },
        // GETDEL looks like a read but deletes the key. Even if the handler swallows the error, the Preview must fail.
        { path: '/counters/seeded/take', operation: 'GETDEL', untouched: async () => assert.equal(await readers.redis.send('GET', redisKey('seeded')), '5', 'GETDEL must not reach Redis') },
      ],
      mixed: { operation: 'INCR', untouched: async id => assert.equal(await readers.redis.send('GET', redisKey('item-' + id)), null, 'The store write must not happen') },
    },
    dynamodb: {
      read: { path: '/orders/seeded', body: { id: 'seeded', status: 'open', hits: 3 }, operation: 'GetItem' },
      writes: [
        { path: '/orders/blocked/touch', operation: 'UpdateItem', untouched: async () => assert.equal(await order('blocked'), null, 'UpdateItem must not reach DynamoDB') },
        // A PartiQL UPDATE travels through ExecuteStatement, which also carries reads.
        { path: '/orders/seeded/cancel', operation: 'ExecuteStatement', untouched: async () => assert.equal((await order('seeded'))?.status, 'open', 'The PartiQL UPDATE must not reach DynamoDB') },
      ],
      mixed: { operation: 'UpdateItem', untouched: async id => assert.equal(await order('item-' + id), null, 'The store write must not happen') },
    },
    cassandra: {
      // The read is a prepared statement: the hook must classify EXECUTE by the text it saw prepared.
      read: { path: '/tickets/seeded', body: { id: 'seeded', status: 'open', hits: 3 }, operation: 'SELECT' },
      writes: [
        { path: '/tickets/blocked/touch', operation: 'INSERT', untouched: async () => assert.equal(await ticket('blocked'), null, 'INSERT must not reach Cassandra') },
        // A logged BATCH holding a lightweight transaction: a write even though its condition could fail.
        { path: '/tickets/seeded/close', operation: 'BATCH', untouched: async () => assert.equal((await ticket('seeded'))?.status, 'open', 'The BATCH must not reach Cassandra') },
      ],
      mixed: { operation: 'INSERT', untouched: async id => assert.equal(await ticket('item-' + id), null, 'The store write must not happen') },
    },
    opensearch: {
      // The read is a POST to _search: the method alone must not decide.
      read: {
        path: '/articles/seeded', body: { id: 'seeded', title: 'Seeded', views: 3 }, operation: 'search',
        redacted: entry => {
          assert.equal(entry.db.target, readers.opensearch.index, 'The Db entry names the index');
          assert(entry.db.statement && !entry.db.statement.includes('seeded'), 'The search body must reach the Db entry with its values replaced by ?');
        },
      },
      writes: [
        { path: '/articles/blocked/touch', operation: 'update', untouched: async () => assert.equal(await article('blocked'), null, 'The update must not reach OpenSearch') },
        // _update_by_query is a POST with a query, like a search. Even if the handler swallows the error, the Preview must fail.
        { path: '/articles/seeded/hide', operation: 'update_by_query', untouched: async () => assert.equal((await article('seeded'))?.hidden, undefined, '_update_by_query must not reach OpenSearch') },
      ],
      mixed: { operation: 'update', untouched: async id => assert.equal(await article('item-' + id), null, 'The store write must not happen') },
    },
  };
  const unavailableRoutes = { mongodb: '/documents/{id}', redis: '/counters/{key}', dynamodb: '/orders/{id}', cassandra: '/tickets/{id}', opensearch: '/articles/{id}' };

  const capabilities = await (await status(await request(base + '/sendproof/_api/capabilities', { cookie }), 200)).json();
  await t.test('Data stores: discovery lists each store and its mode', async () => {
    schemas.assert('capabilities', capabilities);
    captured.push(capabilities);
    for (const store of stores) {
      const entry = capabilities.dataStores?.find(item => item.system === store);
      assert(entry, `capabilities.dataStores must list ${store}`);
      assert.equal(entry.mode, modes[store], `${store} runs in ${modes[store]} mode against the compose service`);
    }
  });
  await sessionStores(t, request, schemas, capabilities, cookie, readers, stores.find(store => modes[store] === 'guard'));

  await t.test('Data stores: preview:false operations are not advertised and do not run', async () => {
    for (const store of stores) {
      const path = unavailableRoutes[store];
      assert(!capabilities.previewOperations.some(item => item.method === 'DELETE' && item.path === path), `DELETE ${path} must not be advertised`);
      const marked = capabilities.previewUnavailable?.find(item => item.method === 'DELETE' && item.path === path);
      assert(marked, `DELETE ${path} must appear in previewUnavailable`);
      assert.equal(marked.reason, `Preview unavailable: this operation writes to ${names[store]}`);
      assert.deepEqual(marked.stores, [store]);
      await unconfirmed(await go('DELETE', path.replace(/\{\w+\}/, 'seeded')), [404, 405, 409]);
    }
    if (readers.redis) assert.equal(await readers.redis.send('GET', redisKey('seeded')), '5');
    if (readers.dynamodb) assert.equal((await order('seeded'))?.status, 'open');
    if (readers.mongodb) assert.equal((await documents({ _id: 'seeded' })).length, 1);
    if (readers.cassandra) assert.equal((await ticket('seeded'))?.status, 'open');
    if (readers.opensearch) assert.equal((await article('seeded'))?.title, 'Seeded');
  });

  for (const store of stores.filter(item => modes[item] === 'guard')) {
    const spec = guarded[store];
    await t.test(`Data stores: a pure ${names[store]} read in Preview succeeds`, async () => {
      const envelope = await preview('GET', spec.read.path);
      assert.equal(envelope.status, 200);
      assert.deepEqual(envelope.body, spec.read.body);
      const [entry] = dbEntries(envelope.logs, store, spec.read.operation);
      assert(entry, `Expected a Db log entry for the ${names[store]} read`);
      assert.notEqual(entry.db.blocked, true);
      spec.read.redacted?.(entry);
    });

    await t.test(`Data stores: a guarded ${names[store]} write in Preview fails cleanly`, async () => {
      for (const write of spec.writes) {
        const response = await go('POST', write.path);
        await write.untouched();
        await blocked(response, store, write.operation);
      }
    });

    await t.test(`Data stores: SQL and a guarded ${names[store]} write roll back together`, async () => {
      const id = 'mixed-' + store;
      const response = await go('POST', `/items/${id}/remember?store=${store}`, { name: 'Mixed' });
      await status(await request(base + '/items/' + id, { cookie }), 404);
      await spec.mixed.untouched(id);
      await blocked(response, store, spec.mixed.operation);
    });
  }

  if (stores.includes('mongodb')) {
    await t.test('Data stores: a MongoDB Preview rolls back and reports document changes', async () => {
      const read = await preview('GET', '/documents/seeded');
      assert.deepEqual(read.body, { id: 'seeded', name: 'Seeded', city: 'Leeds' });

      const created = await preview('POST', '/documents', { id: 'preview-doc', name: 'Draft', city: 'York', password: 'mongo-secret-value' });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, { id: 'preview-doc', name: 'Draft', city: 'York' });
      const insert = created.changes.find(change => change.store === 'mongodb' && change.operation === 'insert');
      assert(insert, 'Expected a MongoDB insert change');
      assert.equal(insert.table, 'documents');
      assert.deepEqual(insert.key, { _id: 'preview-doc' });
      assert.equal(insert.before, null);
      assert.deepEqual(insert.after.profile, { city: 'York' }, 'Document snapshots keep their nesting');
      assert.equal(insert.after.password_hash, '[REDACTED]');
      assert(dbEntries(created.logs, 'mongodb', 'insert').some(entry => entry.db.target === 'documents'), 'Expected a Db entry for the insert');
      assert(created.logs.some(entry => entry.message.includes('created-document:preview-doc')));
      assert.deepEqual(await documents({ _id: 'preview-doc' }), [], 'An independent read must not find the previewed insert');

      const updated = await preview('PATCH', '/documents/seeded', { name: 'Renamed', city: 'Hull' });
      assert.equal(updated.status, 200);
      const update = updated.changes.find(change => change.store === 'mongodb' && change.operation === 'update');
      assert(update, 'Expected a MongoDB update change');
      assert.deepEqual(update.key, { _id: 'seeded' });
      assert.equal(update.before.name, 'Seeded');
      assert.equal(update.after.name, 'Renamed');
      assert.deepEqual([update.before.profile.city, update.after.profile.city], ['Leeds', 'Hull']);
      const [seeded] = await documents({ _id: 'seeded' });
      assert.deepEqual([seeded.name, seeded.profile.city], ['Seeded', 'Leeds'], 'An independent read must find the seeded document unchanged');

      // $out can't run inside a transaction; the binding blocks it with the reason instead of failing in the handler.
      const response = await go('POST', '/documents/archive');
      assert.deepEqual(await readers.mongodb.find('documents_archive'), [], '$out must not write the archive collection');
      const problem = await blocked(response, 'mongodb', 'aggregate');
      assert.match(problem.detail, /\$out/);
    });
  }

  await t.test('Data stores: observed Send commits once and traces Db entries', async () => {
    if (stores.includes('redis')) {
      const { result, trace } = await send('POST', '/counters/sent', undefined, 200);
      assert.deepEqual(result, { key: 'sent', value: 1 });
      assert(dbEntries(trace.logs, 'redis', 'INCR').length === 1, 'Expected one INCR in the trace');
      assert.equal(await readers.redis.send('GET', redisKey('sent')), '1', 'Observed Send must commit exactly once');
    }
    if (stores.includes('dynamodb')) {
      const { result, trace } = await send('POST', '/orders/sent/touch', undefined, 200);
      assert.deepEqual(result, { id: 'sent', status: 'new', hits: 1 });
      assert(dbEntries(trace.logs, 'dynamodb', 'UpdateItem').length === 1, 'Expected one UpdateItem in the trace');
      assert.equal((await order('sent'))?.hits, 1, 'Observed Send must commit exactly once');
    }
    if (stores.includes('mongodb')) {
      const { trace } = await send('POST', '/documents', { id: 'sent-doc', name: 'Sent', city: 'Ely', password: 'mongo-secret-value' }, 201);
      assert(dbEntries(trace.logs, 'mongodb', 'insert').length === 1, 'Expected one insert in the trace');
      const found = await documents({ _id: 'sent-doc' });
      assert.equal(found.length, 1, 'Observed Send must commit exactly once');
      assert.equal(found[0].password_hash, 'hashed:mongo-secret-value');
    }
    if (stores.includes('cassandra')) {
      const { result, trace } = await send('POST', '/tickets/sent/touch', undefined, 200);
      assert.deepEqual(result, { id: 'sent', status: 'new', hits: 1 });
      const entries = dbEntries(trace.logs, 'cassandra', 'INSERT');
      assert(entries.length === 1, 'Expected one INSERT in the trace');
      assert.equal(entries[0].db.target, 'tickets');
      assert(entries[0].db.statement && !/'new'|\b1\b/.test(entries[0].db.statement), 'CQL literals must be replaced by ? in the Db entry');
      assert.deepEqual(await ticket('sent'), { id: 'sent', status: 'new', hits: 1 }, 'Observed Send must commit exactly once');
    }
    if (stores.includes('opensearch')) {
      const { result, trace } = await send('POST', '/articles/sent/touch', undefined, 200);
      assert.deepEqual(result, { id: 'sent', title: 'Untitled', views: 1 });
      const entries = dbEntries(trace.logs, 'opensearch', 'update');
      assert(entries.length === 1, 'Expected one update in the trace');
      assert.equal(entries[0].db.target, readers.opensearch.index);
      assert(entries[0].db.statement && !/Untitled|ctx\._source/.test(entries[0].db.statement), 'Request body values must be replaced by ? in the Db entry');
      assert.equal((await article('sent'))?.views, 1, 'Observed Send must commit exactly once');
    }
  });

  await t.test('Data stores: secrets never reach discovery, envelopes or traces', () => {
    const text = JSON.stringify(captured);
    const secrets = [
      'mongo-secret-value', 'hashed:seeded-secret', env.BENCH_MONGODB_URL, env.BENCH_REDIS_URL,
      env.BENCH_REDIS_URL && decodeURIComponent(new URL(env.BENCH_REDIS_URL).password),
      env.AWS_SECRET_ACCESS_KEY, 'AWS4-HMAC-SHA256',
    ].filter(Boolean);
    for (const secret of secrets) assert(!text.includes(secret), `A capture contains a secret: ${secret.slice(0, 12)}…`);
    for (const entry of captured.flatMap(document => document.logs ?? []).filter(item => item.level === 'Db')) {
      assert(!/^(AUTH|HELLO|saslStart|saslContinue|authenticate)$/i.test(entry.db.operation), `Session command ${entry.db.operation} must not be logged`);
    }
  });
}

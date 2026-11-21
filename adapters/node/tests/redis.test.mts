// Redis write guard (`@sendproof/redis`) against the compose Redis service, for ioredis and
// node-redis. An independent, unhooked client reads Redis after every Preview, so a passing check
// proves the refused command never reached the server.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import type { DataStore } from '@sendproof/core';
import { redisStore } from '@sendproof/redis';
import { assertBlocked, dbEntries, fresh, handle, needs, services, startApp } from './support/stores.mts';

/** The calls the routes make, implemented once per client library. */
interface Driver {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  getdel(key: string): Promise<string | null>;
  pipelineSetIncr(a: string, b: string): Promise<unknown>;
  multiSetIncr(a: string, b: string): Promise<unknown>;
  module(key: string): Promise<unknown>;
  store?: DataStore;
}

/**
 * Client options that never reconnect: a Redis that drops the connection fails the test instead
 * of leaving a client retrying forever, which kept the test process alive after the last test.
 */
const ioredisOptions = { retryStrategy: () => null, maxRetriesPerRequest: 0, connectTimeout: 2000 };
const nodeRedisSocket = { reconnectStrategy: false as const, connectTimeout: 2000 };

const clients: Record<string, (hook: boolean, t: test.TestContext) => Promise<Driver>> = {
  async ioredis(hook, t) {
    const client = new Redis(services.redis, { ...ioredisOptions, lazyConnect: true });
    const store = hook ? redisStore(client, { name: 'cache', treatAsRead: ['ECHO'] }) : undefined;
    // disconnect() closes at once; quit() waits for a connection that may never come.
    t.after(() => client.disconnect());
    await client.connect();
    return {
      store, get: key => client.get(key), incr: key => client.incr(key), getdel: key => client.getdel(key),
      pipelineSetIncr: (a, b) => client.pipeline().set(a, '1').incr(b).exec(),
      multiSetIncr: (a, b) => client.multi().set(a, '1').incr(b).exec(),
      module: key => client.call('ECHO', key),
    };
  },
  async 'node-redis'(hook, t) {
    const client = createClient({ url: services.redis, socket: nodeRedisSocket });
    const store = hook ? redisStore(client, { name: 'cache', treatAsRead: ['ECHO'] }) : undefined;
    t.after(() => { if (client.isOpen) client.destroy(); });
    await client.connect();
    return {
      store, get: key => client.get(key), incr: key => client.incr(key), getdel: key => client.getDel(key),
      pipelineSetIncr: (a, b) => client.multi().set(a, '1').incr(b).execAsPipeline(),
      multiSetIncr: (a, b) => client.multi().set(a, '1').incr(b).exec(),
      module: key => client.sendCommand(['ECHO', key]),
    };
  },
};

/** Start an app whose routes use `driver`, with the store registered when `hook` is true. */
async function app(t: test.TestContext, library: string, hook = true) {
  const reader = new Redis(services.redis, ioredisOptions);
  const prefix = fresh('redis') + ':';
  t.after(async () => {
    try {
      const keys = await reader.keys(prefix + '*');
      if (keys.length) await reader.del(...keys);
    } finally {
      reader.disconnect();
    }
  });
  const driver = await clients[library]!(hook, t);
  const stores = driver.store ? [driver.store] : [];
  const key = (name: string) => prefix + name;
  const harness = await startApp(t, stores, bench => {
    bench.operation('GET', '/counters/{key}', handle(async (req, res) => {
      const value = await driver.get(key(req.params.key as string));
      if (value === null) res.status(404).end(); else res.json({ value: Number(value) });
    }));
    bench.operation('POST', '/counters/{key}', handle(async (req, res) => { res.json({ value: await driver.incr(key(req.params.key as string)) }); }));
    bench.operation('POST', '/counters/{key}/take', handle(async (req, res) => {
      let value = null;
      try { value = await driver.getdel(key(req.params.key as string)); } catch { /* swallowed on purpose */ }
      res.json({ value });
    }));
    bench.operation('POST', '/pipeline', handle(async (_req, res) => { res.json({ result: await driver.pipelineSetIncr(key('p1'), key('p2')) }); }));
    bench.operation('POST', '/multi', handle(async (_req, res) => { res.json({ result: await driver.multiSetIncr(key('m1'), key('m2')) }); }));
    bench.operation('POST', '/module/{key}', handle(async (req, res) => { res.json({ result: await driver.module(key(req.params.key as string)) }); }));
  });
  await reader.set(key('seeded'), '5');
  return { ...harness, reader, key };
}

/** The guard checks for one client library; the negative test expects them to fail unhooked. */
async function guardChecks(t: test.TestContext, library: string, hook = true) {
  const { reader, key, preview } = await app(t, library, hook);
  await assertBlocked(await preview('POST', '/counters/blocked'), 'redis', 'INCR');
  assert.equal(await reader.get(key('blocked')), null, 'INCR must not reach Redis');
  await assertBlocked(await preview('POST', '/counters/seeded/take'), 'redis', 'GETDEL');
  assert.equal(await reader.get(key('seeded')), '5', 'GETDEL must not reach Redis');
  await assertBlocked(await preview('POST', '/pipeline'), 'redis', 'SET');
  await assertBlocked(await preview('POST', '/multi'), 'redis', 'SET');
  assert.deepEqual(await reader.exists(key('p1'), key('p2'), key('m1'), key('m2')), 0, 'No command of a refused pipeline or MULTI may run');
}

for (const library of Object.keys(clients)) {
  test(`${library}: reads run in Preview and are logged without values`, await needs('redis'), async t => {
    const { confirmed } = await app(t, library);
    const envelope = await confirmed('GET', '/counters/seeded');
    assert.deepEqual(envelope.body, { value: 5 });
    const [entry] = dbEntries(envelope.logs, 'redis', 'GET');
    assert(entry, 'Expected a Db entry for GET');
    assert.match(entry.db.statement, /^GET tb_redis_\w+:seeded$/);
    assert.equal(entry.db.target, entry.db.statement.slice(4));
    assert.equal(dbEntries(envelope.logs).some(item => /^(AUTH|HELLO|SELECT|PING)$/.test(item.db.operation)), false);
    // A host-declared read is allowed by exact name.
    assert.equal((await confirmed('POST', '/module/x')).status, 200);
  });

  test(`${library}: writes, pipelines and MULTI are refused before any byte reaches Redis`, await needs('redis'), async t => {
    await guardChecks(t, library);
  });

  test(`${library}: the guard checks fail without the hook`, await needs('redis'), async t => {
    await assert.rejects(guardChecks(t, library, false), assert.AssertionError);
  });

  test(`${library}: observed Send commits once and traces the command without the password`, await needs('redis'), async t => {
    const { observed, reader, key } = await app(t, library);
    const { status, body, trace } = await observed('POST', '/counters/sent');
    assert.equal(status, 200);
    assert.deepEqual(body, { value: 1 });
    assert.equal(await reader.get(key('sent')), '1');
    const entries = dbEntries(trace.logs, 'redis', 'INCR');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].db.statement, `INCR ${key('sent')}`);
    assert(!JSON.stringify(trace).includes('bench_redis_local'), 'The Redis password must never reach a trace');
  });
}

test('node-redis: derived clients and pools stay guarded', await needs('redis'), async t => {
  const client = createClient({ url: services.redis, socket: nodeRedisSocket });
  const store = redisStore(client);
  t.after(() => { if (client.isOpen) client.destroy(); });
  await client.connect();
  const pool = client.createPool();
  t.after(() => pool.destroy());
  await pool.connect();
  const reader = new Redis(services.redis, ioredisOptions);
  const prefix = fresh('redis') + ':';
  t.after(async () => {
    try {
      const keys = await reader.keys(prefix + '*');
      if (keys.length) await reader.del(...keys);
    } finally {
      reader.disconnect();
    }
  });
  const writers: Record<string, (key: string) => Promise<unknown>> = {
    typed: key => client.withTypeMapping({}).incr(key),
    options: key => client.withCommandOptions({}).incr(key),
    pool: key => pool.incr(key),
    'pool-multi': key => pool.multi().incr(key).exec(),
  };
  const { preview, observed } = await startApp(t, [store], bench => {
    bench.operation('POST', '/{via}/{key}', handle(async (req, res) => {
      res.json({ value: await writers[req.params.via as string]!(prefix + req.params.key) });
    }));
  });
  for (const via of Object.keys(writers)) {
    await assertBlocked(await preview('POST', `/${via}/blocked`), 'redis', 'INCR');
  }
  assert.equal(await reader.exists(prefix + 'blocked'), 0, 'No derived client may write during a Preview');
  // Outside a Preview the pool works as before, and its commands are traced.
  const { status, trace } = await observed('POST', '/pool/sent');
  assert.equal(status, 200);
  assert.equal(dbEntries(trace.logs, 'redis', 'INCR').length, 1);
});

test('ioredis auto-pipelining is refused at registration and a client is hooked once', () => {
  assert.throws(() => redisStore(new Redis({ lazyConnect: true, enableAutoPipelining: true })), /enableAutoPipelining/);
  const client = new Redis({ lazyConnect: true });
  redisStore(client);
  assert.throws(() => redisStore(client), /already hooked/);
  assert.throws(() => redisStore(new Redis({ lazyConnect: true }), { name: 'redis://cache:6379' }), TypeError);
  assert.throws(() => redisStore({} as object), TypeError);
  client.disconnect();
});

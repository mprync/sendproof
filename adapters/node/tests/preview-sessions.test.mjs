import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBench, PreviewSessionEndedError } from '@sendproof/core';
import { SQLiteDatabase } from '@sendproof/sqlite';

const collection = '/sendproof/_api/sessions';
const request = (method, pathname, raw = null, headers = {}) =>
  ({ method, pathname, raw, headers, origin: 'http://localhost' });
const response = (status = 200) => ({ status, headers: {}, body: Buffer.alloc(0) });
const json = result => JSON.parse(result.body);
const makeBench = (previewProvider, options = {}) => createBench({
  environment: 'development', previewProvider, resolveIdentity: req => req.raw, ...options,
});
const open = (bench, caller) => bench.lookup(request('POST', collection, caller));
const end = (bench, id, caller) => bench.lookup(request('DELETE', collection + '/' + id, caller));
async function step(bench, id, dispatch, caller, headers = {}) {
  const context = request('POST', '/sendproof/_preview/items', caller, {
    prefer: 'tx=rollback', 'sendproof-session': id, ...headers,
  });
  const route = await bench.lookup(context);
  return 'target' in route ? bench.preview(context, dispatch, route.session) : route;
}
const lease = (options = {}) => ({
  checkpoint: async () => {}, run: (_capture, dispatch) => dispatch(), verify: async () => {},
  rewind: async () => {}, close: async () => {}, ...options,
});

test('session admission reserves concurrent slots and binds anonymous sessions to the same origin', async t => {
  let rollbacks = 0;
  const bench = makeBench({ preview: dispatch => dispatch(), openSession: async () => lease({
    close: async () => { rollbacks++; },
  }) });
  t.after(bench.close);
  assert.equal((await open(bench, { name: 'No stable subject' })).status, 403);
  const opens = await Promise.all(Array.from({ length: 5 }, () => open(bench)));
  assert.deepEqual(opens.map(result => result.status), [201, 201, 201, 201, 429]);
  assert.equal(json(opens[4]).code, 'session_limit');
  const { id } = json(opens[0]);
  assert.equal(json(await end(bench, id, { subject: 'admin' })).code, 'session_not_found');
  assert.equal(json(await step(bench, id, assert.fail, null, { origin: 'https://elsewhere.test' })).code, 'session_not_found');
  for (let i = 0; i < 12; i++) assert.equal((await open(bench, { subject: String(i) })).status, 201);
  assert.equal(json(await open(bench, { subject: 'extra' })).code, 'session_limit');
  await bench.close();
  assert.equal(rollbacks, 16);
  assert.equal(json(await end(bench, id)).code, 'session_not_found');
});

test('idle and maximum lifetime roll back, with maximum lifetime waiting for the active step', async t => {
  let rollbacks = 0;
  const provider = { preview: dispatch => dispatch(), openSession: async () => lease({
    close: async () => { rollbacks++; },
  }) };
  const idle = makeBench(provider, { previewSessions: { idleTimeoutSeconds: 1 } });
  const maximum = makeBench(provider, { previewSessions: { maxLifetimeSeconds: 1 } });
  t.after(async () => { await idle.close(); await maximum.close(); });
  const idleId = json(await open(idle)).id;
  const maximumId = json(await open(maximum)).id;
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const running = step(maximum, maximumId, async () => {
    entered.resolve();
    await resume.promise;
    return response();
  });
  await entered.promise;
  try {
    await delay(1150);
    assert.equal(json(await end(idle, idleId)).code, 'session_not_found');
    assert.equal(rollbacks, 1);
  } finally {
    resume.resolve();
  }
  assert.equal(json(await running).session.step, 1);
  assert.equal(rollbacks, 2);
  assert.equal(json(await end(maximum, maximumId)).code, 'session_not_found');
});

test('a store expiry closes the session and a failed acquisition unwinds earlier stores', async t => {
  let rollbacks = 0;
  const provider = { preview: dispatch => dispatch(), openSession: async () => lease({
    verify: async () => { throw new PreviewSessionEndedError('Expired'); },
    close: async () => { rollbacks++; },
  }) };
  const bench = makeBench(provider);
  t.after(bench.close);
  const { id } = json(await open(bench));
  assert.equal(json(await step(bench, id, async () => response())).code, 'session_failed');
  assert.equal(json(await end(bench, id)).code, 'session_not_found');
  const bad = makeBench(provider, { dataStores: [{
    system: 'other', describe: async () => ({ system: 'other', mode: 'preview' }),
    openSession: async () => { throw new Error('Connection denied'); },
  }] });
  t.after(bad.close);
  assert.equal(json(await open(bad)).code, 'session_failed');
  assert.equal(rollbacks, 2);
});

test('SQLite session refuses external locks quickly and rolls back a failed step before reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sendproof-session-'));
  const path = join(directory, 'store.db');
  const db = new SQLiteDatabase(path, { schema: 'CREATE TABLE items (id INTEGER PRIMARY KEY)', busyTimeoutMs: 6000 });
  const reader = new DatabaseSync(path);
  const bench = makeBench(db);
  t.after(async () => { await bench.close(); await db.close(); reader.close(); await rm(directory, { recursive: true }); });
  reader.exec('BEGIN IMMEDIATE');
  const start = performance.now();
  const busy = await open(bench);
  assert.equal(json(busy).code, 'store_busy');
  assert(performance.now() - start < 5000);
  reader.exec('ROLLBACK');

  const { id } = json(await open(bench));
  const write = value => db.write('INSERT INTO items VALUES (:value)', { value }, { table: 'items', keys: [{ id: value }] });
  assert.equal((await step(bench, id, async () => {
    await write(1);
    throw new Error('Handler failed');
  })).status, 500);

  // A nested transaction started during this request must not still be able to write in a later one.
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let stale;
  const kept = await step(bench, id, async () => {
    await write(2);
    stale = db.transaction(async () => {
      entered.resolve();
      await resume.promise;
      await write(3);
    });
    await entered.promise;
    assert.deepEqual((await db.all('SELECT id FROM items')).map(row => row.id), [2]);
    return response();
  });
  const refused = assert.rejects(stale, /transaction has ended/);
  resume.resolve();
  await refused;
  assert.equal(json(kept).session.step, 1);
  assert.deepEqual(reader.prepare('SELECT id FROM items').all(), []);
  await bench.close();
  assert.deepEqual(await db.all('SELECT id FROM items'), []);
});

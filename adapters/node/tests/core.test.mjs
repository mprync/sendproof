import assert from 'node:assert/strict';
import test from 'node:test';
import { createBench, currentCapture, deliverEffect } from '@test-bench/core';
import { SQLiteDatabase } from '@test-bench/sqlite';

const request = (method, pathname, headers = {}) =>
  ({ pathname, method, origin: 'http://localhost:8000', headers });

test('development discovery works without a provider and rejects unsafe route configuration', async () => {
  const bench = createBench({ environment: 'Development' });
  const response = await bench.lookup(request('GET', '/bench/_api/capabilities'));
  const capabilities = JSON.parse(response.body);
  assert.equal(capabilities.openApiUrl, '/openapi.json');
  assert.deepEqual(capabilities.previewOperations, []);
  assert.equal(capabilities.observedSend, false);
  assert.throws(() => createBench({ openApiUrl: '/%2fexample.org' }), TypeError);
  assert.throws(() => createBench({ openApiUrl: '/a/%2e%2e/b' }), TypeError);
  assert.throws(() => createBench({ captureLimits: { logs: -1 } }), TypeError);
});

test('production only enables the workbench with an explicit environment opt-in', async () => {
  const path = request('GET', '/bench/_api/capabilities');
  assert.equal((await createBench({ environment: 'production' }).lookup(path)).status, 404);
  assert.equal((await createBench({ environment: 'production', environments: ['production'] }).lookup(path)).status, 200);
});

test('SQLite keeps overlapping ordinary writes outside the preview and closes inherited transaction scopes', async t => {
  const db = new SQLiteDatabase(':memory:', { schema: 'CREATE TABLE items (id INTEGER PRIMARY KEY)' });
  t.after(() => db.close());
  const write = id => db.write('INSERT INTO items VALUES (:id)', { id }, { table: 'items', keys: [{ id }] });
  const bench = createBench({ environment: 'development', previewProvider: db });
  const previewRequest = request('POST', '/bench/_preview/items', { prefer: 'tx=rollback' });
  let allowExit;
  let started;
  let stale;
  let staleEffect;
  let letStaleWrite;
  const pause = new Promise(resolve => { allowExit = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const afterRequest = new Promise(resolve => { letStaleWrite = resolve; });
  let delivered = 0;

  const preview = bench.preview(previewRequest, async () => {
    await write(1);
    await deliverEffect({ kind: 'email', description: 'Draft' }, () => delivered++);
    stale = afterRequest.then(() => write(3));
    staleEffect = afterRequest.then(() => deliverEffect({ kind: 'email', description: 'Late draft' }, () => delivered++));
    started();
    await pause;
    return { status: 201, headers: {}, body: Buffer.alloc(0) };
  });
  await ready;
  const ordinary = write(2);
  allowExit();
  assert.equal(JSON.parse((await preview).body).rolledBack, true);
  await ordinary;
  const rejected = assert.rejects(stale, /transaction has ended/);
  letStaleWrite();
  await rejected;
  await staleEffect;
  assert.deepEqual((await db.all('SELECT id FROM items')).map(row => row.id), [2]);
  assert.equal(delivered, 0);
  assert.equal(currentCapture(), undefined);
});

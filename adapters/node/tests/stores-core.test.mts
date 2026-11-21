// The shared data-store core (spec/data-stores.md "The shared core every binding adds"): the
// classifiers against the shared vectors, the embedded tables against spec/data-stores/, the
// guard's blocked mark, the Preview pipeline order, the 409 response and discovery.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Capture, classifyDynamo, classifyMongo, classifyRedis, currentPreview, detached, dynamodbTable, guard, mongodbTable,
  PreviewWriteBlockedError, redactDeep, redisTable, refuseInPreview, sanitizeDocument,
} from '@sendproof/core';
import type { CaptureRecorder, DataStore } from '@sendproof/core';
import type { Request } from 'express';
import { assertBlocked, assertUnconfirmed, cases, dbEntries, handle, specTable, startApp } from './support/stores.mts';

test('embedded data-store tables match spec/data-stores', () => {
  // Regenerate with `npm run embed-store-tables --workspace @sendproof/core` when this fails.
  assert.deepEqual(redisTable, specTable('redis'));
  assert.deepEqual(mongodbTable, specTable('mongodb'));
  assert.deepEqual(dynamodbTable, specTable('dynamodb'));
});

test('the classifiers pass every shared classification vector', () => {
  for (const { command: [name, ...args], expect } of cases.redis) assert.equal(classifyRedis(name, args), expect, name);
  for (const { command, expect, refusedInTransaction } of cases.mongodb) {
    const result = classifyMongo(command);
    assert.equal(result.kind, expect, JSON.stringify(command));
    assert.equal(result.refusedInTransaction, refusedInTransaction, JSON.stringify(command));
  }
  for (const { operation, input, expect } of cases.dynamodb) {
    assert.equal(classifyDynamo(operation, input), expect, `${operation} ${JSON.stringify(input)}`);
  }
});

test('host-declared reads match exact names only', () => {
  const reads = new Set(['MYMODULE.GET']);
  assert.equal(classifyRedis('mymodule.get', ['k'], reads), 'read');
  assert.equal(classifyRedis('MYMODULE.GETALL', ['k'], reads), 'write');
  assert.equal(classifyMongo({ customRead: 1 }, new Set(['customread'])).kind, 'read');
  assert.equal(classifyDynamo('GetThing', {}, new Set(['GetThing'])), 'read');
  assert.equal(classifyDynamo('GetThings', {}, new Set(['GetThing'])), 'write');
});

test('redaction reaches every depth and sanitizing keeps only names and operators', () => {
  assert.deepEqual(redactDeep({ name: 'a', profile: { apiKey: 'k', city: 'York' }, list: [{ password_hash: 'h' }], idempotency_key: 'i' }),
    { name: 'a', profile: { apiKey: '[REDACTED]', city: 'York' }, list: [{ password_hash: '[REDACTED]' }], idempotency_key: 'i' });
  assert.deepEqual(sanitizeDocument({ update: 'documents', updates: [{ q: { _id: 'x' }, u: { $set: { name: 'n' } } }] }),
    { update: '?', updates: [{ q: { _id: '?' }, u: { $set: { name: '?' } } }] });
});

test('the guard does nothing outside a Preview and blocks a write inside one', async () => {
  assert.doesNotThrow(() => guard('redis', 'INCR', 'write'));
  const send = new Capture('send');
  send.run(() => assert.doesNotThrow(() => guard('redis', 'INCR', 'write')));
  const preview = new Capture('preview');
  preview.run(() => {
    assert.doesNotThrow(() => guard('redis', 'GET', 'read'));
    assert.throws(() => guard('redis', 'INCR', 'write'), PreviewWriteBlockedError);
    assert.throws(() => guard('dynamodb', 'PutItem', 'write'), PreviewWriteBlockedError);
  });
  // The first block wins, and the refused command is logged as a blocked Db entry.
  assert.deepEqual(preview.blocked, { store: 'redis', operation: 'INCR', detail: 'Preview unavailable: this operation writes to Redis' });
  const { capture } = preview.finish();
  assert.deepEqual(dbEntries(capture.logs).map(entry => [entry.db.operation, entry.db.blocked]), [['INCR', true], ['PutItem', true]]);
  // A write sent after the Preview finished is still refused rather than sent unguarded.
  preview.run(() => {
    assert.equal(currentPreview(), preview);
    assert.throws(() => guard('redis', 'SET', 'write'), PreviewWriteBlockedError);
  });
});

/** A stand-in store whose hook calls the guard, or skips it when `hooked` is false. */
function fakeStore(options: { hooked?: boolean; finish?: (capture: CaptureRecorder) => Promise<void> } = {}) {
  const writes: string[] = [];
  const store: DataStore & { incr(key: string): Promise<void>; writes: string[] } = {
    system: 'redis', writes,
    describe: async () => ({ system: 'redis', name: 'cache', mode: 'guard' }),
    ...(options.finish ? { finishPreview: options.finish } : {}),
    async incr(key) {
      if (options.hooked !== false) guard('redis', 'INCR', classifyRedis('INCR', [key]));
      writes.push(key);
    },
  };
  return store;
}

/**
 * The binding's own guard checks, run against a store. They pass for a hooked store; the negative
 * test below runs them against an unhooked one and expects them to fail.
 */
async function guardChecks(t: test.TestContext, store: ReturnType<typeof fakeStore>) {
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/counters/{key}', handle(async (req, res) => {
      await store.incr(req.params.key as string);
      res.json({ ok: true });
    }));
    bench.operation('POST', '/counters/{key}/swallow', handle(async (req, res) => {
      // The handler catches the refusal and claims success: the mark still decides the outcome.
      try { await store.incr(req.params.key as string); } catch { /* ignored */ }
      res.status(200).json({ ok: true });
    }));
    bench.operation('POST', '/items/{id}/remember', handle(async (req, res) => {
      await app.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: req.params.id as string, name: 'Mixed' }, { table: 'items', keys: [{ id: req.params.id }] });
      await store.incr('item-' + req.params.id);
      res.status(201).json({ id: req.params.id });
    }));
  });
  await assertBlocked(await app.preview('POST', '/counters/a'), 'redis', 'INCR');
  await assertBlocked(await app.preview('POST', '/counters/b/swallow'), 'redis', 'INCR');
  await assertBlocked(await app.preview('POST', '/items/mixed/remember'), 'redis', 'INCR');
  assert.deepEqual(store.writes, [], 'No write may reach the store during a Preview');
  assert.equal(await app.db.get('SELECT id FROM items WHERE id = :id', { id: 'mixed' }), undefined, 'The SQL insert rolls back with the blocked Preview');
}

test('a blocked Preview answers 409 even when the handler catches the error and returns 200', async t => {
  const store = fakeStore();
  await guardChecks(t, store);
});

test('the guard checks fail when the hook is removed', async t => {
  // Proof that the checks above catch a binding that lets writes through.
  await assert.rejects(guardChecks(t, fakeStore({ hooked: false })), assert.AssertionError);
});

test('a failed store abort and a recorded fault outrank a blocked write', async t => {
  const failing = fakeStore({ finish: async () => { throw new Error('abort failed'); } });
  let app = await startApp(t, [failing], bench => {
    bench.operation('POST', '/counters/{key}', handle(async (req, res) => {
      try { await failing.incr(req.params.key as string); } catch { /* ignored */ }
      res.json({ ok: true });
    }));
  });
  await assertUnconfirmed(await app.preview('POST', '/counters/x'));
  assert(app.errors.some(error => (error as Error).message === 'abort failed'));

  const store = fakeStore();
  app = await startApp(t, [store], bench => {
    bench.operation('POST', '/commit', handle(async (_req, res) => {
      try { await store.incr('k'); } catch { /* ignored */ }
      try { throw refuseInPreview('handler commit') ?? new Error('outside'); } catch { /* ignored */ }
      res.json({ ok: true });
    }));
    bench.operation('POST', '/sql-commit', handle(async (_req, res) => {
      // A raw COMMIT through the SQLite provider fails the Preview even when it is caught.
      await app.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: 'c', name: 'C' }, { table: 'items', keys: [{ id: 'c' }] });
      try { await app.db.write('COMMIT'); } catch { /* ignored */ }
      res.status(201).json({ ok: true });
    }));
  });
  await assertUnconfirmed(await app.preview('POST', '/commit'));
  await assertUnconfirmed(await app.preview('POST', '/sql-commit'));
  assert.equal(await app.db.get('SELECT id FROM items WHERE id = :id', { id: 'c' }), undefined);
});

test('every cleanup step runs when one store fails to finish, and the Preview answers 500', async t => {
  const finished: string[] = [];
  const failing = fakeStore({ finish: async () => { finished.push('failing'); throw new Error('abort failed'); } });
  const healthy = fakeStore({ finish: async () => { finished.push('healthy'); } });
  const app = await startApp(t, [failing, healthy], bench => {
    bench.operation('POST', '/items/{id}', handle(async (req, res) => {
      await app.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: req.params.id as string, name: 'Cleanup' }, { table: 'items', keys: [{ id: req.params.id }] });
      res.status(201).json({ ok: true });
    }));
  });
  await assertUnconfirmed(await app.preview('POST', '/items/cleanup'));
  assert.deepEqual(finished, ['failing', 'healthy'], 'A failed abort must not skip the other stores');
  assert.equal(await app.db.get('SELECT id FROM items WHERE id = :id', { id: 'cleanup' }), undefined, 'A failed abort must not skip the SQL rollback');
});

test('a client that disconnects mid-Preview still gets every store finished and SQL rolled back', async t => {
  const finished: string[] = [];
  let done: () => void = () => {};
  const allFinished = new Promise<void>(resolve => { done = resolve; });
  const store = fakeStore({ finish: async () => { finished.push('store'); done(); } });
  const hold = holder();
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/items/{id}', (req: Request, _res: unknown, next: (error?: unknown) => void) => {
      app.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: req.params.id as string, name: 'Abandoned' }, { table: 'items', keys: [{ id: req.params.id }] })
        .then(() => next(), next);
    }, hold.route);
  });
  // JavaScript can't cancel a running handler, and a dropped connection doesn't interrupt the
  // Preview pipeline: the handler finishes, then every cleanup step runs.
  const abort = new AbortController();
  const request = fetch(app.url + '/sendproof/_preview/items/abandoned', { method: 'POST', headers: { prefer: 'tx=rollback', origin: app.url }, signal: abort.signal });
  await hold.held(1);
  abort.abort();
  await assert.rejects(request);
  hold.release();
  await allFinished;
  assert.deepEqual(finished, ['store']);
  // The SQLite Preview turn was released: the next Preview runs, and the abandoned insert is gone.
  const next = app.preview('POST', '/items/next');
  await hold.held(1);
  hold.release();
  assert.equal((await next).status, 200);
  assert.equal(await app.db.get('SELECT id FROM items WHERE id = :id', { id: 'abandoned' }), undefined);
});

/** A route that holds every Preview that reaches it until `release()`, so a test can act while Previews are open. */
function holder() {
  let entered = 0;
  let waiting: (() => void)[] = [];
  let open: () => void = () => {};
  let released = new Promise<void>(resolve => { open = resolve; });
  return {
    route: handle(async (_req, res) => {
      entered++;
      for (const wake of waiting.splice(0)) wake();
      await released;
      res.json({ ok: true });
    }),
    /** Resolves once `count` requests are being held. */
    async held(count: number) {
      while (entered < count) await new Promise<void>(resolve => waiting.push(resolve));
    },
    release() {
      open();
      entered = 0;
      waiting = [];
      released = new Promise<void>(resolve => { open = resolve; });
    },
  };
}

test('a write outside any request fails every open Preview unless it is marked detached', async t => {
  const store = fakeStore();
  const hold = holder();
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/hold', hold.route);
    bench.operation('POST', '/counters/{key}', handle(async (req, res) => {
      await store.incr(req.params.key as string);
      res.json({ ok: true });
    }));
    // No SQL provider: its Previews take turns, and this test holds two open at once.
  }, { sqlProvider: false });

  // Without an open Preview, background writes are none of the binding's business.
  await store.incr('idle');

  // A Send, even untraced, is a request: its write is attributed and leaves the Preview alone.
  const pending = app.confirmed('POST', '/hold');
  await hold.held(1);
  assert.equal((await fetch(app.url + '/counters/sent', { method: 'POST' })).status, 200);
  // Background work marked detached is attributed too.
  await detached(() => store.incr('background'));
  hold.release();
  await pending;

  // An unattributed write may belong to any open Preview: every one of them fails with 500.
  const first = app.preview('POST', '/hold');
  const second = app.preview('POST', '/hold');
  await hold.held(2);
  await store.incr('stray');
  hold.release();
  await assertUnconfirmed(await first);
  await assertUnconfirmed(await second);
  assert.deepEqual(store.writes, ['idle', 'sent', 'background', 'stray'], 'Unattributed writes are reported, not blocked');

  // Detached work inside a Preview is still that Preview's: the guard keeps blocking it.
  await assertBlocked(await app.preview('POST', '/counters/inside'), 'redis', 'INCR');
  new Capture('preview').run(() => assert.throws(() => detached(() => guard('redis', 'INCR', 'write')), PreviewWriteBlockedError));
});

test('discovery lists data stores and preview:false operations, which never run in Preview', async t => {
  const store = fakeStore();
  let ran = 0;
  const app = await startApp(t, [store], bench => {
    bench.operation('GET', '/counters/{key}', (_req, res) => { res.json({ ok: true }); });
    bench.unavailable('DELETE', '/counters/{key}', { stores: ['redis'] }, (_req, res) => { ran++; res.sendStatus(204); });
    bench.unavailable('POST', '/sessions/{id}/refresh', { reason: 'Preview unavailable: this refreshes a session' }, (_req, res) => { ran++; res.sendStatus(204); });
  });
  const capabilities = await app.capabilities();
  assert.deepEqual(capabilities.dataStores, [{ system: 'redis', name: 'cache', mode: 'guard' }]);
  assert.deepEqual(capabilities.previewOperations, [{ method: 'GET', path: '/counters/{key}' }]);
  assert.deepEqual(capabilities.previewUnavailable, [
    { method: 'DELETE', path: '/counters/{key}', reason: 'Preview unavailable: this operation writes to Redis', stores: ['redis'] },
    { method: 'POST', path: '/sessions/{id}/refresh', reason: 'Preview unavailable: this refreshes a session' },
  ]);
  await assertUnconfirmed(await app.preview('DELETE', '/counters/a'), 409);
  assert.equal(ran, 0, 'A preview:false handler must not run in Preview');
  assert.equal((await fetch(app.url + '/counters/a', { method: 'DELETE' })).status, 204, 'Send still runs it');
  assert.equal(ran, 1);
  assert.throws(() => app.bench.unavailable('PUT', '/x', {}, (_req, res) => { res.end(); }), TypeError);
});

test('Preview runs without a SQL provider when the only stores are hooked ones', async t => {
  // A guard-only app: reads confirm, writes still block.
  const guarded = fakeStore();
  let app = await startApp(t, [guarded], bench => {
    bench.operation('GET', '/counters/{key}', (_req, res) => { res.json({ ok: true }); });
    bench.operation('POST', '/counters/{key}', handle(async (req, res) => { await guarded.incr(req.params.key as string); res.json({ ok: true }); }));
  }, { sqlProvider: false });
  assert.deepEqual((await app.capabilities()).previewOperations, [{ method: 'GET', path: '/counters/{key}' }, { method: 'POST', path: '/counters/{key}' }]);
  assert.equal((await app.capabilities()).observedSend, true);
  assert.deepEqual((await app.confirmed('GET', '/counters/a')).body, { ok: true });
  await assertBlocked(await app.preview('POST', '/counters/a'), 'redis', 'INCR');
  assert.deepEqual(guarded.writes, []);

  // A transactional store as the only database: its finishPreview still runs, and its failure
  // still withholds confirmation.
  let finished = 0;
  const transactional = fakeStore({ finish: async () => { finished++; } });
  app = await startApp(t, [transactional], bench => {
    bench.operation('GET', '/counters/{key}', (_req, res) => { res.json({ ok: true }); });
  }, { sqlProvider: false });
  await app.confirmed('GET', '/counters/a');
  assert.equal(finished, 1);
  const failing = fakeStore({ finish: async () => { throw new Error('abort failed'); } });
  app = await startApp(t, [failing], bench => {
    bench.operation('GET', '/counters/{key}', (_req, res) => { res.json({ ok: true }); });
  }, { sqlProvider: false });
  await assertUnconfirmed(await app.preview('GET', '/counters/a'));
});

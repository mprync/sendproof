// Firestore write guard (`@sendproof/firestore`). Firestore has no compose service, so the hook is
// proven three ways: the recorded requests of spec/data-stores/recordings/ are replayed through a
// guarded GAPIC client over a fake one; the real `@google-cloud/firestore` SDK runs against an
// in-process gRPC server that records every RPC it receives; and the SDK's client-method names
// are checked against what the hook treats as RPCs, so an SDK upgrade that adds one fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import firestoreSdk from '@google-cloud/firestore';
import { grpc, GrpcClient } from 'google-gax';
import { Capture, detached, PreviewWriteBlockedError } from '@sendproof/core';
import { firestoreStore } from '@sendproof/firestore';
import { assertBlocked, dbEntries, handle, startApp } from './support/stores.mts';

const { Firestore, v1 } = firestoreSdk;
const recordings = JSON.parse(readFileSync(new URL('../../../spec/data-stores/recordings/firestore.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);

// ---- the recordings, replayed through a guarded client over a fake one ----

const streaming = new Set(['batchGetDocuments', 'runQuery', 'runAggregationQuery', 'listen', 'write', 'listDocumentsStream']);

/** A GAPIC client that answers every RPC and records the method names that reach it. */
function fakeClient() {
  const reached: string[] = [];
  const client = new Proxy({}, {
    get: (_target, method: string) => (..._args: unknown[]) => {
      reached.push(method);
      // Streams are returned at once and have no `then`; unary calls return a promise of `[response]`.
      return streaming.has(method) ? { on() {}, pipe() {} } : Promise.resolve([{}]);
    },
  });
  return { client, reached };
}

/** The GAPIC method name of an RPC path: `/google.firestore.v1.Firestore/Commit` is `commit`. */
const methodOf = (rpc: string) => { const name = rpc.split('/').at(-1)!; return name.charAt(0).toLowerCase() + name.slice(1); };

/** A store over an instance that never sends anything. */
const storeOf = () => firestoreStore(new Firestore({ projectId: 'p' }), { name: 'orders' });

/** Names, not values: collection, field and alias names may appear in a Db entry; values and document paths may not. */
function values(value: unknown, key?: string): string[] {
  if (Array.isArray(value)) return value.flatMap(item => values(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([name, inner]) => values(inner, name));
  return typeof value === 'string' && !['collectionId', 'fieldPath', 'alias'].includes(key ?? '') && value.length > 1 ? [value] : [];
}

/**
 * Replay every recording inside a Preview scope: a write is refused with the store's blocked error
 * and never reaches the client; a read reaches it and is logged without values; a session call
 * reaches it unlogged; outside a Preview everything is sent, writes included.
 */
async function replay(hooked: boolean) {
  const store = storeOf();
  let checked = 0;
  for (const recording of recordings.recordings) {
    for (const request of recording.requests) {
      const { kind, operation } = request.expect;
      const label = `${recording.name}: ${operation}`;
      const method = methodOf(request.rpc);
      const { client, reached } = fakeClient();
      const sender: any = hooked ? store.guardClient(client) : client;
      const preview = new Capture('preview');
      if (kind === 'write') {
        assert.throws(() => preview.run(() => sender[method](request.rest.body, {})),
          (error: unknown) => error instanceof PreviewWriteBlockedError && error.store === 'firestore' && error.operation === operation, label);
        assert.deepEqual(reached, [], `${label} must not reach the store`);
        assert.equal(preview.blocked?.store, 'firestore', `${label} must mark the Preview blocked`);
      } else {
        await preview.run(() => sender[method](request.rest.body, {}));
        assert.deepEqual(reached, [method], `${label} must reach the store`);
        const logs = preview.finish().capture.logs.filter((entry: any) => entry.level === 'Db');
        if (kind === 'read') {
          const entry = logs.find((item: any) => item.db.operation === operation);
          assert(entry, `${label} must be logged`);
          for (const value of values(request.rest.body)) assert(!JSON.stringify(entry).includes(value), `${label} must not log ${value}`);
        } else {
          assert.equal(logs.length, 0, `${label} is session state and isn't logged`);
        }
      }
      // Outside a Preview everything is sent, writes included.
      const outside = fakeClient();
      await (hooked ? store.guardClient(outside.client) : outside.client as any)[method](request.rest.body, {});
      assert.deepEqual(outside.reached, [method], `${label} must run outside a Preview`);
      checked++;
    }
  }
  return checked;
}

test('Firestore recordings replay through the guarded client: writes never reach it, reads are logged without values', async () => {
  assert((await replay(true)) >= 15);
});

test('the Firestore replay fails when the hook is removed', async () => {
  await assert.rejects(replay(false), assert.AssertionError);
});

test('the streaming Write RPC is refused at the call, Listen runs, and methods the table does not know are writes', () => {
  const store = storeOf();
  const { client, reached } = fakeClient();
  const guarded: any = store.guardClient(client);
  const preview = new Capture('preview');
  assert.throws(() => preview.run(() => guarded.write({})), PreviewWriteBlockedError);
  assert.equal(preview.blocked?.operation, 'Write');
  assert.doesNotThrow(() => new Capture('preview').run(() => guarded.listen({})));
  assert.doesNotThrow(() => new Capture('preview').run(() => guarded.listDocumentsStream({ parent: 'x' })));
  assert.throws(() => new Capture('preview').run(() => guarded.executePipeline({})), PreviewWriteBlockedError);
  assert.throws(() => new Capture('preview').run(() => guarded.listLocationsAsync({})), PreviewWriteBlockedError);
  // The client's own helpers are not RPCs.
  assert.doesNotThrow(() => new Capture('preview').run(() => guarded.getProjectId()));
  assert.deepEqual(reached, ['listen', 'listDocumentsStream', 'getProjectId']);
});

test('every callable member of the SDK GAPIC client is a known RPC or a listed helper', () => {
  // An SDK upgrade that adds a client method that sends a request must be classified before it ships.
  const known = new Set(['getDocument', 'updateDocument', 'deleteDocument', 'beginTransaction', 'commit', 'rollback', 'batchWrite', 'createDocument', 'batchGetDocuments',
    'runQuery', 'runAggregationQuery', 'write', 'listen', 'listDocuments', 'listDocumentsStream', 'listDocumentsAsync', 'partitionQuery', 'partitionQueryStream',
    'partitionQueryAsync', 'listCollectionIds', 'listCollectionIdsStream', 'listCollectionIdsAsync', 'getLocation', 'listLocationsAsync']);
  const helpers = new Set(['constructor', 'initialize', 'apiEndpoint', 'universeDomain', 'getProjectId', 'close']);
  for (const name of Object.getOwnPropertyNames(v1.FirestoreClient.prototype)) {
    assert(known.has(name) || helpers.has(name), `Unclassified GAPIC client member: ${name}`);
  }
});

// ---- the real SDK against an in-process gRPC server ----

/** A Firestore gRPC server that answers every method plausibly and records the names it receives. */
async function fakeServer(t: test.TestContext) {
  const protos = new GrpcClient({}).loadProtoJSON(require(require.resolve('@google-cloud/firestore').replace(/src\/index\.js$/, 'protos/v1.json')));
  const Service = (protos as any).google.firestore.v1.Firestore;
  const received: string[] = [];
  const time = { seconds: '1', nanos: 0 };
  const note = (name: string) => received.push(name);
  const server = new grpc.Server();
  server.addService(Service.service, {
    getDocument(_call: any, callback: any) { note('GetDocument'); callback(null, { name: 'projects/p/databases/(default)/documents/orders/o-1', fields: {}, createTime: time, updateTime: time }); },
    batchGetDocuments(call: any) { note('BatchGetDocuments'); for (const name of call.request.documents) call.write({ missing: name, readTime: time, ...(call.request.newTransaction ? { transaction: Buffer.from('tx') } : {}) }); call.end(); },
    runQuery(call: any) { note('RunQuery'); call.write({ readTime: time }); call.end(); },
    runAggregationQuery(call: any) { note('RunAggregationQuery'); call.write({ result: { aggregateFields: { aggregate_0: { integerValue: '0' } } }, readTime: time }); call.end(); },
    listCollectionIds(_call: any, callback: any) { note('ListCollectionIds'); callback(null, { collectionIds: ['orders'] }); },
    beginTransaction(_call: any, callback: any) { note('BeginTransaction'); callback(null, { transaction: Buffer.from('tx') }); },
    rollback(_call: any, callback: any) { note('Rollback'); callback(null, {}); },
    commit(call: any, callback: any) { note(call.request.writes?.length ? 'Commit' : 'Commit(empty)'); callback(null, { writeResults: (call.request.writes ?? []).map(() => ({ updateTime: time })), commitTime: time }); },
    batchWrite(call: any, callback: any) { note('BatchWrite'); callback(null, { writeResults: call.request.writes.map(() => ({ updateTime: time })), status: call.request.writes.map(() => ({ code: 0 })) }); },
    listen(call: any) { note('Listen'); call.on('data', () => {}); call.on('end', () => call.end()); },
    write(call: any) { note('Write'); call.on('data', () => {}); call.on('end', () => call.end()); },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound)));
  t.after(() => server.forceShutdown());
  return { received, host: `127.0.0.1:${port}` };
}

/** An app whose routes use a hooked (or bare) Firestore against the fake server in every way the SDK can write. */
async function app(t: test.TestContext, hook = true) {
  const { received, host } = await fakeServer(t);
  const firestore = new Firestore({ projectId: 'p', host, ssl: false });
  const store = hook ? firestoreStore(firestore, { name: 'orders' }) : undefined;
  t.after(() => firestore.terminate());
  const orders = () => firestore.collection('orders');
  const harness = await startApp(t, store ? [store] : [], bench => {
    bench.operation('GET', '/orders/{id}', handle(async (req, res) => {
      const snapshot = await orders().doc(req.params.id as string).get();
      res.json({ exists: snapshot.exists });
    }));
    bench.operation('GET', '/queries', handle(async (_req, res) => {
      await orders().where('status', '==', 'open').limit(5).get();
      await orders().count().get();
      await firestore.listCollections();
      res.json({ ok: true });
    }));
    bench.operation('POST', '/write/{how}', handle(async (req, res) => {
      const doc = orders().doc('o-1');
      switch (req.params.how) {
        case 'set': await doc.set({ status: 'new' }); break;
        case 'create': await doc.create({ status: 'new' }); break;
        case 'update': await doc.update({ status: 'x' }); break;
        case 'delete': await doc.delete(); break;
        case 'add': await orders().add({ status: 'new' }); break;
        case 'batch': { const batch = firestore.batch(); batch.set(doc, { a: 1 }); batch.delete(orders().doc('o-2')); await batch.commit(); break; }
        case 'bulk': { const writer = firestore.bulkWriter(); void writer.set(doc, { a: 1 }).catch(() => {}); await writer.close(); break; }
        case 'transaction': await firestore.runTransaction(async transaction => { await transaction.get(doc); transaction.set(doc, { a: 1 }); }); break;
        case 'swallow': try { await doc.set({ status: 'x' }); } catch { /* ignored */ } break;
        case 'collection': await firestore.collection('other').doc('d').set({ a: 1 }); break;
        default: res.status(400).end(); return;
      }
      res.json({ ok: true });
    }));
    bench.operation('POST', '/error', handle(async (_req, res) => {
      try { await orders().doc('o-1').set({ a: 1 }); res.json({}); } catch (error) { res.json({ name: (error as Error).name, store: (error as any).store, operation: (error as any).operation }); }
    }));
  });
  return { ...harness, received, firestore };
}

test('firestore: the real SDK reads in Preview, logged by collection without values', async t => {
  const { confirmed, received } = await app(t);
  const envelope = await confirmed('GET', '/orders/o-1');
  assert.deepEqual(envelope.body, { exists: false });
  const [entry] = dbEntries(envelope.logs, 'firestore', 'BatchGetDocuments');
  assert(entry, 'Expected a Db entry for BatchGetDocuments');
  assert(!JSON.stringify(entry).includes('o-1'), 'Document paths are values');
  assert.deepEqual(received, ['BatchGetDocuments']);
  const queries = await confirmed('GET', '/queries');
  assert.deepEqual(dbEntries(queries.logs).map(item => item.db.operation).sort(), ['ListCollectionIds', 'RunAggregationQuery', 'RunQuery']);
  assert.equal(dbEntries(queries.logs, 'firestore', 'RunQuery')[0].db.target, 'orders');
  assert(!JSON.stringify(queries.logs).includes('open'), 'Query values must not be logged');
});

test('firestore: every write the SDK can make is refused before it reaches the server', async t => {
  const { preview, received } = await app(t);
  const expected: Record<string, string> = {
    set: 'Commit', create: 'Commit', update: 'Commit', delete: 'Commit', add: 'Commit', batch: 'Commit', bulk: 'BatchWrite', transaction: 'Commit', swallow: 'Commit', collection: 'Commit',
  };
  for (const [how, operation] of Object.entries(expected)) await assertBlocked(await preview('POST', `/write/${how}`), 'firestore', operation);
  // A transaction begins and reads before it writes, and rolls back after the refusal; those are allowed. Nothing that writes is.
  assert(received.every(name => !['Commit', 'BatchWrite', 'Write'].includes(name)), `No write RPC may reach the server, got ${received.join(', ')}`);
});

test('firestore: the handler sees the blocked error itself in a Preview, and the write succeeds in Send', async t => {
  const { preview, observed, received } = await app(t);
  const { status } = await observed('POST', '/error');
  assert.equal(status, 200);
  assert.deepEqual(received, ['Commit']);
  const body = await (await preview('POST', '/error')).json();
  assert.equal(body.code, 'preview_unavailable');
});

test('firestore: the guard checks fail without the hook', async t => {
  const { preview, received } = await app(t, false);
  await assert.rejects(assertBlocked(await preview('POST', '/write/set'), 'firestore', 'Commit'), assert.AssertionError);
  assert(received.includes('Commit'), 'Without the hook the write is sent');
});

test('firestore: observed Send commits once and traces the request without values', async t => {
  const { observed, received } = await app(t);
  const { status, trace } = await observed('POST', '/write/set');
  assert.equal(status, 200);
  assert.deepEqual(received, ['Commit']);
  const [entry] = dbEntries(trace.logs, 'firestore', 'Commit');
  assert(entry);
  assert.equal(entry.db.target, 'orders');
  assert(!entry.db.statement.includes('o-1') && !entry.db.statement.includes('new'), 'Paths and values are replaced');
});

test('firestore: a shared BulkWriter never sends a Preview\'s write, and its unattributed sends are refused while a Preview is open', async t => {
  const { host, received } = await fakeServer(t);
  const firestore = new Firestore({ projectId: 'p', host, ssl: false });
  // Made before the hook: BulkWriters already in use must be guarded too.
  const early = firestore.bulkWriter();
  const store = firestoreStore(firestore, { name: 'orders' });
  t.after(() => firestore.terminate());
  const shared = firestore.bulkWriter();
  let open: () => void = () => {};
  const released = new Promise<void>(resolve => { open = resolve; });
  let entered: () => void = () => {};
  const inside = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => open());
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/enqueue/{which}', handle(async (req, res) => {
      const writer = req.params.which === 'early' ? early : shared;
      void writer.set(firestore.doc(`orders/${req.params.which}`), { a: 1 }).catch(() => {});
      res.json({ ok: true });
    }));
    bench.operation('POST', '/flush', handle(async (_req, res) => { await shared.flush(); await early.flush(); res.json({ ok: true }); }));
    bench.operation('POST', '/hold', handle(async (_req, res) => { entered(); await released; res.json({ ok: true }); }));
  }, { sqlProvider: false });
  const batchWrites = () => received.filter(name => name === 'BatchWrite').length;

  // A BulkWriter batches writes and sends them later, from whichever request or timer completes the
  // batch: the Preview's write is refused when it is enqueued, so a later Send that flushes the
  // shared writer in its own request sends nothing of the Preview's.
  await assertBlocked(await app.preview('POST', '/enqueue/shared'), 'firestore', 'BatchWrite');
  await assertBlocked(await app.preview('POST', '/enqueue/early'), 'firestore', 'BatchWrite');
  assert.equal((await fetch(app.url + '/flush', { method: 'POST' })).status, 200);
  assert.equal(batchWrites(), 0, 'A write a Preview enqueued must never be sent');

  // The writer's own send with no request attribution while a Preview is open (background work
  // enqueued it, a timer flushes it) is refused before it is sent, and the open Preview is blocked.
  const pending = app.preview('POST', '/hold');
  await inside;
  await assert.rejects(shared.set(firestore.doc('orders/stray'), { a: 2 }), PreviewWriteBlockedError);
  const background = detached(() => shared.set(firestore.doc('orders/background'), { a: 3 }));
  background.catch(() => {});
  await shared.flush();
  await assert.rejects(background);
  assert.equal(batchWrites(), 0, 'An unattributed BulkWriter send must not reach the server');
  open();
  await assertBlocked(await pending, 'firestore', 'BatchWrite');

  // recursiveDelete() enqueues on its own BulkWriter from stream listeners: refused, without an uncaught exception.
  await assert.rejects(new Capture('preview').run(() => firestore.recursiveDelete(firestore.doc('orders/tree'))));
  assert.equal(batchWrites(), 0);

  // Work in detached() is never refused, and with no Preview open the writer sends as usual.
  await detached(async () => { const write = shared.set(firestore.doc('orders/job'), { a: 4 }); await shared.flush(); await write; });
  assert.equal(batchWrites(), 1);
  await early.close();
  await shared.close();
});

test('firestore: a hooked instance works before and after its first request, and a second hook is refused', async t => {
  const { host, received } = await fakeServer(t);
  const firestore = new Firestore({ projectId: 'p', host, ssl: false });
  // Used before the hook: an unguarded request is fine, then the hook guards every later one.
  await firestore.collection('orders').doc('o-1').set({ a: 1 });
  const store = firestoreStore(firestore, { name: 'orders' });
  t.after(() => firestore.terminate());
  assert.deepEqual(await store.describe(), { system: 'firestore', name: 'orders', mode: 'guard' });
  await assert.rejects(new Capture('preview').run(() => firestore.collection('orders').doc('o-1').set({ a: 2 })), PreviewWriteBlockedError);
  assert.deepEqual(received, ['Commit']);
  assert.throws(() => firestoreStore(firestore), /already hooked/);
  assert.throws(() => firestoreStore({} as object), TypeError);
  assert.throws(() => firestoreStore(new Firestore({ projectId: 'p' }), { name: 'projects/p/databases/(default)' }), TypeError);
});

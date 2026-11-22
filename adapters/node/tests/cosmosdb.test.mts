// Cosmos DB write guard (`@sendproof/cosmosdb`). Cosmos DB has no compose service, so the hook is
// proven two ways: the recorded requests of spec/data-stores/recordings/ are replayed through the
// plugin over a fake transport, and the real `@azure/cosmos` SDK runs against a fake `httpClient`
// that records every request that reaches the wire.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import { CosmosClient } from '@azure/cosmos';
import { Capture, PreviewWriteBlockedError } from '@sendproof/core';
import { cosmosStore } from '@sendproof/cosmosdb';
import type { CosmosPlugin } from '@sendproof/cosmosdb';
import { assertBlocked, dbEntries, handle, startApp } from './support/stores.mts';

const recordings = JSON.parse(readFileSync(new URL('../../../spec/data-stores/recordings/cosmosdb.json', import.meta.url), 'utf8'));

/** String values in a request body (parameter values, documents): none may appear in a Db entry. */
function leaves(value: unknown, key?: string): string[] {
  if (Array.isArray(value)) return value.flatMap(item => leaves(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([name, inner]) => leaves(inner, name));
  return typeof value === 'string' && key !== 'query' && key !== 'name' && value.length > 1 ? [value] : [];
}

/** A hooked plugin over a fake transport that records what reaches it, or the bare transport when `hooked` is false. */
function wired(hooked: boolean) {
  const reached: string[] = [];
  const store = cosmosStore(new CosmosClient({ endpoint: 'https://fake.documents.azure.com:443/', key: Buffer.from('k').toString('base64') }));
  const transport = async (context: { method: string; path?: string }) => { reached.push(`${context.method} ${context.path}`); return { status: 200 }; };
  const plugin: CosmosPlugin = hooked ? store.plugin : (context, _diagnostics, next) => next(context);
  const send = (request: any) => plugin({
    method: request.http.method, path: request.http.path, headers: request.http.headers, body: request.http.body,
    operationType: request.sdk.operationType, resourceType: request.sdk.resourceType,
  }, undefined, transport as never);
  return { send, reached };
}

/**
 * Replays every recorded request through the plugin inside a Preview scope: a write is refused
 * with the store's blocked error and never reaches the transport; a read reaches it and is logged
 * without values; outside a Preview everything passes.
 */
async function replay(hooked: boolean) {
  let checked = 0;
  for (const recording of recordings.recordings) {
    const { send, reached } = wired(hooked);
    for (const request of recording.requests) {
      // One Preview scope per request, so its log and blocked mark belong to that request alone.
      const preview = new Capture('preview');
      const { kind, operation } = request.expect.sdk;
      const label = `${recording.name}: ${operation}`;
      const before = reached.length;
      if (kind === 'write') {
        await assert.rejects(preview.run(() => send(request)), (error: unknown) => error instanceof PreviewWriteBlockedError && error.store === 'cosmosdb' && error.operation === operation, label);
        assert.equal(reached.length, before, `${label} must not reach the store`);
        assert.equal(preview.blocked?.store, 'cosmosdb', `${label} must mark the Preview blocked`);
      } else {
        await preview.run(() => send(request));
        assert.equal(reached.length, before + 1, `${label} must reach the store`);
        const entry = preview.finish().capture.logs.find((item: any) => item.level === 'Db' && item.db.operation === operation);
        assert(entry, `${label} must be logged`);
        for (const value of leaves(request.http.body)) assert(!JSON.stringify(entry).includes(value), `${label} must not log ${value}`);
      }
      checked++;
    }
    // Outside a Preview nothing is refused, writes included.
    const outside = wired(hooked);
    for (const request of recording.requests) await outside.send(request);
    assert.equal(outside.reached.length, recording.requests.length, `${recording.name} must run outside a Preview`);
  }
  return checked;
}

test('Cosmos DB recordings replay through the plugin: writes are refused, reads are logged', async () => {
  assert((await replay(true)) >= 20);
});

test('the Cosmos DB replay fails when the hook is removed', async () => {
  await assert.rejects(replay(false), assert.AssertionError);
});

test('the recordings cover the cases the table singles out', () => {
  const names = recordings.recordings.map((item: { name: string }) => item.name);
  for (const name of ['execute a stored procedure', 'create a document with a pre-trigger', 'run a transactional batch', 'run bulk operations', 'patch a document', 'query documents']) {
    assert(names.includes(name), `Cosmos DB recordings need "${name}"`);
  }
});

// ---- the real SDK over a fake transport ----

const account = {
  id: 'fake', _self: '', _rid: 'r', media: '//media/', addresses: '//addresses/', _dbs: '//dbs/',
  writableLocations: [{ name: 'Fake', databaseAccountEndpoint: 'https://fake.documents.azure.com:443/' }],
  readableLocations: [{ name: 'Fake', databaseAccountEndpoint: 'https://fake.documents.azure.com:443/' }],
  enableMultipleWriteLocations: false, userReplicationPolicy: {}, userConsistencyPolicy: { defaultConsistencyLevel: 'Session' },
  systemReplicationPolicy: {}, readPolicy: {}, queryEngineConfiguration: '{}',
};

/** A `CosmosClient` over a fake `httpClient` that answers every request with a plausible reply and records it. */
function sdk(hook: boolean) {
  const wire: string[] = [];
  const client = new CosmosClient({
    endpoint: 'https://fake.documents.azure.com:443/', key: Buffer.from('fake-key').toString('base64'),
    httpClient: {
      async sendRequest(request: any) {
        const url = new URL(request.url);
        wire.push(`${request.method} ${url.pathname}`);
        const body = url.pathname === '/' ? account : { id: 'o-1', pk: 'p1', _rid: 'r', _self: 's', _etag: 'e', _ts: 1 };
        return { request, status: 200, headers: createHttpHeaders({ 'content-type': 'application/json', 'x-ms-request-charge': '1' }), bodyAsText: JSON.stringify(body) };
      },
    },
  });
  const store = hook ? cosmosStore(client, { name: 'orders' }) : undefined;
  return { client, store, wire };
}

/** An app whose routes use the SDK in every way it can write. */
async function app(t: test.TestContext, hook = true) {
  const { client, store, wire } = sdk(hook);
  t.after(() => client.dispose());
  // Settle the SDK's own start-up request before the Preview so it isn't counted as the handler's.
  await client.getDatabaseAccount();
  wire.length = 0;
  const container = () => client.database('shop').container('orders');
  const harness = await startApp(t, store ? [store] : [], bench => {
    bench.operation('GET', '/orders/{id}', handle(async (req, res) => {
      const { resource } = await container().item(req.params.id as string, 'p1').read();
      res.json(resource);
    }));
    bench.operation('POST', '/write/{how}', handle(async (req, res) => {
      const orders = container();
      switch (req.params.how) {
        case 'create': await orders.items.create({ id: 'n', pk: 'p1' }); break;
        case 'upsert': await orders.items.upsert({ id: 'n', pk: 'p1' }); break;
        case 'replace': await orders.item('o-1', 'p1').replace({ id: 'o-1', pk: 'p1' }); break;
        case 'patch': await orders.item('o-1', 'p1').patch([{ op: 'add', path: '/status', value: 'x' }]); break;
        case 'delete': await orders.item('o-1', 'p1').delete(); break;
        case 'batch': await orders.items.batch([{ operationType: 'Create', resourceBody: { id: 'b', pk: 'p1' } }], 'p1'); break;
        case 'sproc': await orders.scripts.storedProcedure('readOnly').execute('p1', []); break;
        case 'trigger': await orders.items.create({ id: 'n', pk: 'p1' }, { preTriggerInclude: ['stamp'] }); break;
        case 'swallow': try { await orders.item('o-1', 'p1').delete(); } catch { /* ignored */ } break;
        default: res.status(400).end(); return;
      }
      res.json({ ok: true });
    }));
  });
  return { ...harness, wire, client };
}

test('cosmosdb: the real SDK reads in Preview, logged by container and database', async t => {
  const { confirmed, wire } = await app(t);
  const envelope = await confirmed('GET', '/orders/o-1');
  assert.equal(envelope.body.id, 'o-1');
  const entry = dbEntries(envelope.logs, 'cosmosdb', 'Read').find(item => item.db.target === 'orders');
  assert(entry, 'Expected a Db entry for Read of the orders container');
  assert.equal(entry.db.namespace, 'shop');
  assert(wire.includes('GET /dbs/shop/colls/orders/docs/o-1'));
  assert(wire.every(item => item.startsWith('GET ')), 'Only reads reach the wire');
});

test('cosmosdb: every write the SDK can make is refused before it reaches the wire', async t => {
  const { preview, wire } = await app(t);
  const expected: Record<string, string> = {
    create: 'Create', upsert: 'Upsert', replace: 'Replace', patch: 'Patch', delete: 'Delete', batch: 'Batch', sproc: 'Execute', trigger: 'Create', swallow: 'Delete',
  };
  for (const [how, operation] of Object.entries(expected)) await assertBlocked(await preview('POST', `/write/${how}`), 'cosmosdb', operation);
  // The SDK reads the container's definition before a write; that read is allowed, and nothing else is sent.
  assert(wire.every(item => item.startsWith('GET ')), `No refused write may be sent, got ${wire.join(', ')}`);
});

test('cosmosdb: the guard checks fail without the hook', async t => {
  const { preview, wire } = await app(t, false);
  await assert.rejects(assertBlocked(await preview('POST', '/write/create'), 'cosmosdb', 'Create'), assert.AssertionError);
  assert(wire.some(item => item.startsWith('POST /dbs/shop/colls/orders/docs')), 'Without the hook the write is sent');
});

test('cosmosdb: observed Send sends the write once and traces it without the document or the key', async t => {
  const { observed, wire } = await app(t);
  const { status, trace } = await observed('POST', '/write/create');
  assert.equal(status, 200);
  assert.equal(wire.filter(item => !item.startsWith('GET ')).length, 1, 'The write is sent once');
  assert.equal(wire.at(-1), 'POST /dbs/shop/colls/orders/docs');
  assert.equal(dbEntries(trace.logs, 'cosmosdb', 'Create').length, 1);
  assert(!JSON.stringify(trace).includes(Buffer.from('fake-key').toString('base64')), 'The account key must never reach a trace');
});

test('cosmosdb: the SDK is pinned to the 4.10 line, and a client of any other version is refused at registration', async () => {
  // The request-plugin option is undocumented: an unpinned range could install a line that no longer runs it.
  const manifest = JSON.parse(readFileSync(new URL('../cosmosdb/package.json', import.meta.url), 'utf8'));
  assert.match(manifest.peerDependencies['@azure/cosmos'], /^~4\.10\.\d+$/, 'The peer range must stay on the 4.10 line');
  assert.match(manifest.devDependencies['@azure/cosmos'], /^4\.10\.\d+$/, 'Tests run against an exact 4.10 release');
  const installed = JSON.parse(readFileSync(new URL('../node_modules/@azure/cosmos/package.json', import.meta.url), 'utf8')).version;
  assert.match(installed, /^4\.10\./);
  const client = new CosmosClient({ endpoint: 'https://fake.documents.azure.com:443/', key: Buffer.from('k').toString('base64') });
  const headers = (client as any).clientContext.cosmosClientOptions.defaultHeaders;
  for (const agent of ['Node.js/24 azure-cosmos-js/4.11.0', 'Node.js/24 azure-cosmos-js/5.0.0', 'Node.js/24', 'Node.js/24 azure-cosmos-js/4.1.0 suffix azure-cosmos-js/4.10.2']) {
    headers['User-Agent'] = agent;
    assert.throws(() => cosmosStore(client), /4\.10/, `A client reporting "${agent}" must be refused`);
  }
  client.dispose();
});

test('cosmosdb: query literals are logged as ?, double-quoted strings included', async () => {
  const { client, store } = sdk(true) as any;
  const preview = new Capture('preview');
  await preview.run(() => store.plugin({
    method: 'POST', path: '/dbs/shop/colls/orders/docs', operationType: 'Query', headers: { 'x-ms-documentdb-isquery': 'True' },
    body: { query: 'SELECT * FROM c WHERE c.token = "tok-s3cret" AND c.owner = \'alice\' AND c.note = \'it\\\'s hush\' AND c.n = 42 AND c["key"] = @key', parameters: [{ name: '@key', value: 'hidden' }] },
  }, undefined, async () => ({})));
  const [entry] = dbEntries(preview.finish().capture.logs, 'cosmosdb', 'Query');
  assert(entry, 'Expected a Db entry for the query');
  assert.equal(entry.db.statement, 'SELECT * FROM c WHERE c.token = ? AND c.owner = ? AND c.note = ? AND c.n = ? AND c[?] = @key');
  assert(!/s3cret|alice|hush|hidden/.test(JSON.stringify(entry)));
  // The entry also carries timings and ids that can contain "42" by chance, so the number is checked where it was written.
  assert(!/42/.test(entry.db.statement));
  client.dispose();
});

test('cosmosdb: registration refuses a second hook, a non-client and a URL label, and advertises guard mode', async () => {
  const { client } = sdk(false);
  const store = cosmosStore(client, { name: 'orders' });
  assert.deepEqual(await store.describe(), { system: 'cosmosdb', name: 'orders', mode: 'guard' });
  assert.throws(() => cosmosStore(client), /already hooked/);
  assert.throws(() => cosmosStore({} as object), /4\.10/);
  assert.throws(() => cosmosStore(sdk(false).client, { name: 'https://account.documents.azure.com' }), TypeError);
  client.dispose();
});

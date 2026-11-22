// Elasticsearch and OpenSearch write guard (`@sendproof/elasticsearch`). OpenSearch runs against the
// compose `opensearch` service (heavy-stores profile), read back by an unhooked client after every
// Preview. The Elasticsearch 8 client refuses to talk to anything but Elasticsearch, so it runs
// against a local HTTP server that answers like one and records every request it receives: a
// refused request must never show up there.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Client as ElasticClient } from '@elastic/elasticsearch';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { elasticsearchStore, opensearchStore } from '@sendproof/elasticsearch';
import { detached } from '@sendproof/core';
import { assertBlocked, assertUnconfirmed, dbEntries, fresh, handle, needs, services, startApp } from './support/stores.mts';

/** The calls the routes make, written once against `client.transport.request`, which both libraries share. */
interface Search {
  request(method: string, path: string, body?: unknown): Promise<any>;
  /** The client library's own typed calls, which differ in shape between the two libraries. */
  typed: Record<string, (index: string, id: string) => Promise<unknown>>;
  child(): Search;
}

/** Wrap a client of either library in the calls the routes use. */
function searchOf(client: any, library: 'elasticsearch' | 'opensearch'): Search {
  const body = (reply: any) => library === 'opensearch' ? reply.body : reply;
  const doc = (value: object) => library === 'opensearch' ? { body: value } : { document: value };
  return {
    async request(method, path, content) {
      return body(await client.transport.request({ method, path, ...(content === undefined ? {} : { body: content }) }));
    },
    typed: {
      search: async (index, id) => body(await client.search({ index, ...(library === 'opensearch' ? { body: { query: { ids: { values: [id] } } } } : { query: { ids: { values: [id] } } }) })),
      index: (index, id) => client.index({ index, id, refresh: true, ...doc({ title: 'T', views: 1 }) }),
      bulk: (index, id) => client.bulk({ refresh: true, ...(library === 'opensearch' ? { body: [{ index: { _index: index, _id: id } }, { title: 'B' }] } : { operations: [{ index: { _index: index, _id: id } }, { title: 'B' }] }) }),
      helper: (index, id) => client.helpers.bulk({ datasource: [{ title: 'H' }], onDocument: () => ({ index: { _index: index, _id: id } }), refreshOnCompletion: index }),
      updateByQuery: (index, id) => client.updateByQuery({ index, refresh: true, ...(library === 'opensearch'
        ? { body: { query: { ids: { values: [id] } }, script: { source: 'ctx._source.hidden = true' } } }
        : { query: { ids: { values: [id] } }, script: { source: 'ctx._source.hidden = true' } }) }),
      delete: (index, id) => client.delete({ index, id, refresh: true }),
      createIndex: index => client.indices.create({ index: index + '_new' }),
    },
    child: () => searchOf(client.child(), library),
  };
}

/** The routes: reads that use POST, and every kind of write. `how` picks a typed call or a raw transport request. */
function routes(search: Search, index: string) {
  return (bench: any) => {
    bench.operation('GET', '/articles/{id}', handle(async (req, res) => {
      const reply = await search.request('POST', `/${index}/_search`, { query: { ids: { values: [req.params.id] } }, size: 1 });
      const hit = reply.hits.hits[0];
      res.status(hit ? 200 : 404).json(hit ? { id: hit._id, ...hit._source } : {});
    }));
    bench.operation('POST', '/articles/{id}/touch', handle(async (req, res) => {
      const reply = await search.request('POST', `/${index}/_update/${req.params.id}?refresh=true`, {
        script: { source: 'ctx._source.views += params.step', params: { step: 1 } }, upsert: { title: 'Untitled', views: 1 }, _source: true,
      });
      res.json(reply.get?._source ?? {});
    }));
    bench.operation('POST', '/articles/{id}/hide', handle(async (req, res) => {
      // The handler swallows the refusal: the Preview is still a 409.
      try { await search.typed.updateByQuery!(index, req.params.id as string); } catch { /* ignored */ }
      res.status(404).end();
    }));
    bench.operation('POST', '/typed/{how}/{id}', handle(async (req, res) => {
      await search.typed[req.params.how as string]!(index, req.params.id as string);
      res.json({ ok: true });
    }));
    bench.operation('POST', '/child/{id}', handle(async (req, res) => {
      await search.child().typed.index!(index, req.params.id as string);
      res.json({ ok: true });
    }));
    bench.operation('POST', '/raw', handle(async (req, res) => {
      const { method, path, body } = req.body as { method: string; path: string; body?: unknown };
      res.json(await search.request(method, path.replace('<index>', index), body));
    }));
  };
}

const ignore = () => {};

// ---- OpenSearch, against the service ----

/** A fresh index with `title`, `views` and `hidden`, an unhooked reader, and a hooked client when asked. */
async function openSearchApp(t: test.TestContext, hook = true) {
  const index = fresh('os');
  const reader = new OpenSearchClient({ node: services.opensearch });
  await reader.indices.create({ index, body: { settings: { number_of_replicas: 0 }, mappings: { properties: { title: { type: 'keyword' }, views: { type: 'integer' }, hidden: { type: 'boolean' } } } } });
  t.after(async () => { try { await reader.indices.delete({ index }); } finally { await reader.close(); } });
  await reader.index({ index, id: 'seeded', refresh: true, body: { title: 'Seeded', views: 1 } });
  const client = new OpenSearchClient({ node: services.opensearch });
  const store = hook ? opensearchStore(client, { name: 'search' }) : undefined;
  t.after(() => client.close());
  const harness = await startApp(t, store ? [store] : [], routes(searchOf(client, 'opensearch'), index));
  const read = async (id: string) => {
    const reply = await reader.search({ index, body: { query: { ids: { values: [id] } } } });
    return (reply.body.hits.hits as any[])[0]?._source;
  };
  const total = async () => Number((await reader.count({ index })).body.count);
  return { ...harness, index, reader, read, total, client };
}

/** The guard checks; the negative test expects them to fail without the hook. */
async function guardChecks(t: test.TestContext, hook = true) {
  const { preview, read, total, reader, index } = await openSearchApp(t, hook);
  await assertBlocked(await preview('POST', '/articles/new/touch'), 'opensearch', 'update');
  await assertBlocked(await preview('POST', '/articles/seeded/hide'), 'opensearch', 'update_by_query');
  assert.equal(await read('new'), undefined, 'The upsert must not reach OpenSearch');
  assert.equal((await read('seeded')).hidden, undefined, 'The update-by-query must not reach OpenSearch');
  assert.equal(await total(), 1);
  void reader; void index;
}

test('opensearch: a POST search runs in Preview and is logged without values', await needs('opensearch'), async t => {
  const { confirmed, index } = await openSearchApp(t);
  const envelope = await confirmed('GET', '/articles/seeded');
  assert.deepEqual(envelope.body, { id: 'seeded', title: 'Seeded', views: 1 });
  const [entry] = dbEntries(envelope.logs, 'opensearch', 'search');
  assert(entry, 'Expected a Db entry for search');
  assert.equal(entry.db.target, index);
  assert.equal(entry.db.statement, '{"query":{"ids":{"values":["?"]}},"size":"?"}');
  assert.equal(entry.db.rowsAffected, 1);
  assert(!JSON.stringify(entry).includes('seeded'));
});

test('opensearch: updates and update-by-query are refused before they are sent', await needs('opensearch'), async t => {
  await guardChecks(t);
});

test('opensearch: the guard checks fail without the hook', await needs('opensearch'), async t => {
  await assert.rejects(guardChecks(t, false), assert.AssertionError);
});

test('opensearch: typed calls, helpers, children and raw transport requests are all guarded', await needs('opensearch'), async t => {
  const { preview, total, read } = await openSearchApp(t);
  const typed: Record<string, string> = { index: 'index', bulk: 'bulk', helper: 'bulk', updateByQuery: 'update_by_query', delete: 'delete', createIndex: 'indices.create' };
  for (const [how, operation] of Object.entries(typed)) await assertBlocked(await preview('POST', `/typed/${how}/seeded`), 'opensearch', operation);
  await assertBlocked(await preview('POST', '/child/seeded'), 'opensearch', 'index');
  const raw = (method: string, path: string, body?: unknown) => preview('POST', '/raw', { method, path, body });
  await assertBlocked(await raw('PUT', '/<index>/_doc/seeded', { title: 'Overwritten' }), 'opensearch', 'index');
  await assertBlocked(await raw('POST', '/_plugins/_sql', { query: 'DELETE FROM <index>' }), 'opensearch', 'sql.query');
  await assertBlocked(await raw('POST', '/_bulk', [{ delete: { _id: 'seeded' } }]), 'opensearch', 'bulk');
  assert.equal(await total(), 1);
  assert.equal((await read('seeded')).title, 'Seeded', 'No guarded call may reach OpenSearch');
});

test('opensearch: sessions run unlogged, reads of every shape pass, and SQL reads are allowed', await needs('opensearch'), async t => {
  const { confirmed, index } = await openSearchApp(t);
  const raw = (method: string, path: string, body?: unknown) => confirmed('POST', '/raw', { method, path, body });
  const scroll = await raw('POST', '/<index>/_search?scroll=1m', { query: { match_all: {} } });
  assert.equal(scroll.status, 200);
  const cleared = await raw('DELETE', '/_search/scroll', { scroll_id: scroll.body._scroll_id });
  assert.equal(dbEntries(cleared.logs).length, 0, 'Clearing a scroll is session state and is not logged');
  assert.equal(dbEntries(scroll.logs, 'opensearch', 'search').length, 1);
  const sql = await raw('POST', '/_plugins/_sql', { query: `SELECT title FROM ${index}` });
  assert.equal(dbEntries(sql.logs, 'opensearch', 'sql.query').length, 1);
  assert.equal((await raw('GET', '/_cat/indices')).status, 200);
});

test('opensearch: observed Send writes once and traces the request body without values', await needs('opensearch'), async t => {
  const { observed, read } = await openSearchApp(t);
  const { status, trace } = await observed('POST', '/articles/sent/touch');
  assert.equal(status, 200);
  assert.deepEqual(await read('sent'), { title: 'Untitled', views: 1 });
  const [entry] = dbEntries(trace.logs, 'opensearch', 'update');
  assert(entry);
  assert(!entry.db.statement.includes('Untitled') && !entry.db.statement.includes('ctx._source'), 'Literals must be replaced');
  assert(!JSON.stringify(trace).includes('/_update/'), 'The path, which can hold document ids, is not logged');
});

test('opensearch: a mixed SQL and store route rolls the SQL insert back with the blocked Preview', await needs('opensearch'), async t => {
  const index = fresh('os');
  const reader = new OpenSearchClient({ node: services.opensearch });
  await reader.indices.create({ index, body: { settings: { number_of_replicas: 0 } } });
  t.after(async () => { try { await reader.indices.delete({ index }); } finally { await reader.close(); } });
  const client = new OpenSearchClient({ node: services.opensearch });
  const store = opensearchStore(client);
  t.after(() => client.close());
  const search = searchOf(client, 'opensearch');
  const app = await startApp(t, [store], (bench, db) => {
    bench.operation('POST', '/items/{id}/remember', handle(async (req, res) => {
      await db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: req.params.id as string, name: 'Mixed' }, { table: 'items', keys: [{ id: req.params.id }] });
      await search.request('POST', `/${index}/_update/item-${req.params.id}?refresh=true`, { doc: { title: 'x' }, doc_as_upsert: true });
      res.status(201).json({ id: req.params.id });
    }));
  });
  await assertBlocked(await app.preview('POST', '/items/mixed/remember'), 'opensearch', 'update');
  assert.equal(await app.db.get('SELECT id FROM items WHERE id = :id', { id: 'mixed' }), undefined);
  assert.equal(Number((await reader.count({ index })).body.count), 0);
});

// ---- OpenSearch registration, without the service ----

test('opensearch: extensions made before the hook are refused at registration, and ones made after, and on children, are guarded', async t => {
  const early = new OpenSearchClient({ node: 'http://127.0.0.1:1' });
  early.extend('custom.write', ({ makeRequest }: any) => (params: any) => makeRequest({ method: 'PUT', path: '/x', ...params }));
  assert.throws(() => opensearchStore(early), /client\.extend\(\)/);
  await early.close();

  const client = new OpenSearchClient({ node: 'http://127.0.0.1:1', maxRetries: 0 });
  const store = opensearchStore(client, { name: 'search' });
  assert.deepEqual(await store.describe(), { system: 'opensearch', name: 'search', mode: 'guard' });
  client.extend('custom.write', ({ makeRequest }: any) => (params: any) => makeRequest({ method: 'PUT', path: '/x', ...params }));
  const child = client.child();
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/extended/{who}/{id}', handle(async (req, res) => {
      await (req.params.who === 'child' ? child : client).custom.write();
      res.json({ ok: true });
    }));
  });
  await assertBlocked(await app.preview('POST', '/extended/parent/x'), 'opensearch', 'indices.create');
  await assertBlocked(await app.preview('POST', '/extended/child/x'), 'opensearch', 'indices.create');
  assert.throws(() => opensearchStore(client), /already hooked/);
  assert.throws(() => opensearchStore({} as object), TypeError);
  assert.throws(() => opensearchStore(new OpenSearchClient({ node: 'http://127.0.0.1:1' }), { name: 'http://opensearch:9200' }), TypeError);
  await client.close();
});

// ---- Elasticsearch 8, against a local server that answers like one ----

/** A server that records `METHOD path` for every request and answers like Elasticsearch 8. */
async function fakeElasticsearch(t: test.TestContext) {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url!.split('?')[0]}`);
    req.resume();
    req.on('end', () => {
      const reply = req.url!.includes('_search') ? { hits: { hits: [{ _id: 'seeded', _source: { title: 'Seeded', views: 1 } }] } } : { result: 'created', updated: 1 };
      res.writeHead(200, { 'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { received, node: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('elasticsearch: reads pass, writes of every shape never reach the server, and children stay guarded', async t => {
  const { received, node } = await fakeElasticsearch(t);
  const client = new ElasticClient({ node, maxRetries: 0 });
  const store = elasticsearchStore(client, { name: 'search' });
  t.after(() => client.close());
  assert.deepEqual(await store.describe(), { system: 'elasticsearch', name: 'search', mode: 'guard' });
  const app = await startApp(t, [store], routes(searchOf(client, 'elasticsearch'), 'articles'));

  const envelope = await app.confirmed('GET', '/articles/seeded');
  assert.deepEqual(envelope.body, { id: 'seeded', title: 'Seeded', views: 1 });
  assert.equal(dbEntries(envelope.logs, 'elasticsearch', 'search').length, 1);
  assert.deepEqual(received, ['POST /articles/_search']);

  const typed: Record<string, string> = { index: 'index', bulk: 'bulk', helper: 'bulk', updateByQuery: 'update_by_query', delete: 'delete', createIndex: 'indices.create' };
  for (const [how, operation] of Object.entries(typed)) await assertBlocked(await app.preview('POST', `/typed/${how}/seeded`), 'elasticsearch', operation);
  await assertBlocked(await app.preview('POST', '/child/seeded'), 'elasticsearch', 'index');
  await assertBlocked(await app.preview('POST', '/articles/n/touch'), 'elasticsearch', 'update');
  await assertBlocked(await app.preview('POST', '/articles/seeded/hide'), 'elasticsearch', 'update_by_query');
  assert.deepEqual(received, ['POST /articles/_search'], 'No refused request may reach the server');

  // Send runs the same calls, including through a child client, and traces every one.
  const sent = await app.observed('POST', '/child/seeded');
  assert.equal(sent.status, 200);
  assert.equal(dbEntries(sent.trace.logs, 'elasticsearch', 'index').length, 1);
  assert(received.includes('PUT /articles/_doc/seeded') || received.includes('POST /articles/_doc/seeded') || received.some(item => item.includes('/articles/_doc/seeded')));
  assert.throws(() => elasticsearchStore(client), /already hooked/);
});

test('elasticsearch: the same writes reach the server when the hook is removed (the negative case)', async t => {
  const { received, node } = await fakeElasticsearch(t);
  const client = new ElasticClient({ node, maxRetries: 0 });
  t.after(() => client.close());
  const app = await startApp(t, [], routes(searchOf(client, 'elasticsearch'), 'articles'));
  const reply = await app.preview('POST', '/articles/n/touch');
  assert.notEqual(reply.status, 409);
  assert(received.some(item => item.includes('_update')), 'Without the hook the write is sent');
  ignore();
});

test('elasticsearch: NDJSON bodies are logged one sanitized line each, and a string body is read the same way', async t => {
  const { node } = await fakeElasticsearch(t);
  const client = new ElasticClient({ node, maxRetries: 0 });
  const store = elasticsearchStore(client);
  t.after(() => client.close());
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/multi', handle(async (_req, res) => {
      await client.msearch({ searches: [{ index: 'articles' }, { query: { match: { title: 'secret' } } }] });
      await client.transport.request({ method: 'POST', path: '/articles/_search', body: '{"query":{"term":{"title":"hush"}}}' });
      res.json({ ok: true });
    }));
  });
  const { logs } = await app.confirmed('POST', '/multi');
  const [multi] = dbEntries(logs, 'elasticsearch', 'msearch');
  assert.equal(multi.db.statement, '{"index":"?"}\n{"query":{"match":{"title":"?"}}}');
  const [text] = dbEntries(logs, 'elasticsearch', 'search');
  assert.equal(text.db.statement, '{"query":{"term":{"title":"?"}}}');
  assert(!JSON.stringify(logs).match(/secret|hush/));
});

test('elasticsearch: a write outside any request fails an open Preview unless it is marked detached, and is sent either way', async t => {
  const { received, node } = await fakeElasticsearch(t);
  const client = new ElasticClient({ node, maxRetries: 0 });
  const store = elasticsearchStore(client);
  t.after(() => client.close());
  let open: () => void = () => {};
  const released = new Promise<void>(resolve => { open = resolve; });
  let entered: () => void = () => {};
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/hold', handle(async (_req, res) => { entered(); await released; res.json({ ok: true }); }));
  }, { sqlProvider: false });
  const pending = app.preview('POST', '/hold');
  await inside;
  const write = () => client.index({ index: 'articles', id: 'stray', document: { title: 'x' } });
  // Background work marked detached is attributed: it does not fail the Preview.
  await detached(write);
  assert.equal(received.length, 1);
  // Unattributed work may be the Preview's own write that lost its async context: the Preview fails, and the write is not blocked.
  await write();
  assert.equal(received.length, 2);
  open();
  await assertUnconfirmed(await pending);
});

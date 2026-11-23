// The Sendproof MCP server (@sendproof/cli) against a fake API that speaks protocol v1 under a path
// base: discovery, operations and models, lookups, Preview (confirmed, unconfirmed and blocked),
// Send with its guard and trace, personas, journeys, and the stdio lifecycle.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '@sendproof/cli';
import type { SendPolicy } from '@sendproof/cli';

const TRACE = '0123456789abcdef0123456789abcdef';
const TRACE_QUOTE = 'fedcba9876543210fedcba9876543210';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

function fakeApi(environment = 'Development') {
  const seen: Seen[] = [];
  let signedIn: string | null = null;
  const openapi = {
    openapi: '3.1.0', info: { title: 'Shop', version: '2.0.0' },
    paths: {
      '/orders': {
        get: { operationId: 'Orders.List', summary: 'List orders', tags: ['Orders'], parameters: [{ name: 'pageSize', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'A page' } } },
        post: {
          operationId: 'Orders.Place', summary: 'Place order', tags: ['Orders'], security: [{ cookie: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaceOrder' } } } },
          responses: { 201: { description: 'Placed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
        },
      },
      '/orders/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        get: { operationId: 'Orders.Get', summary: 'Get order', tags: ['Orders'], responses: { 200: { description: 'The order' } } },
      },
      '/quotes': { post: { operationId: 'Quotes.Create', summary: 'Quote', tags: ['Carts'], responses: { 200: { description: 'A quote' } } } },
      '/coupons/{code}/redemptions': { post: { operationId: 'Coupons.Redeem', summary: 'Redeem', tags: ['Coupons'], parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Redeemed' } } } },
      '/old': { get: { operationId: 'Old.Get', summary: 'Moved', tags: ['Other'], responses: { 302: { description: 'Moved' } } } },
    },
    components: { schemas: {
      PlaceOrder: { type: 'object', description: 'An order to place.', required: ['customerId', 'items'], properties: {
        customerId: { type: 'string', format: 'uuid', 'x-lookup': { url: '/customers', valueField: 'id', labelField: 'name' } },
        items: { type: 'array', items: { $ref: '#/components/schemas/Line' } },
        speed: { type: 'string', enum: ['Standard', 'Express'] },
      } },
      Line: { type: 'object', properties: { sku: { type: 'string', 'x-lookup': { url: '/stock', valueField: 'sku', labelField: 'name', searchParam: 'q' } }, quantity: { type: 'integer' } } },
      Order: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
    } },
  };
  const capabilities = () => ({
    protocolVersion: 1, apiName: 'Shop', environment, openApiUrl: '/tenant/openapi.json',
    database: { name: 'shop.db', system: 'sqlite' }, identity: signedIn ? { name: signedIn } : null,
    authProviders: [{ label: 'Seeded accounts', kind: 'personas', url: '/tenant/auth/personas' }, { label: 'Password', kind: 'cookie', url: '/tenant/auth/login' }],
    dataStores: [{ system: 'redis', name: 'cache', mode: 'guard' }],
    previewOperations: [{ method: 'POST', path: '/orders' }, { method: 'GET', path: '/orders' }, { method: 'POST', path: '/coupons/{code}/redemptions' }],
    previewUnavailable: [{ method: 'POST', path: '/quotes', reason: 'Quotes are cached in Redis.', stores: ['redis'] }],
    observedSend: true, previewSessions: true,
    journeys: [{ name: 'Shop journeys', arazzoUrl: '/tenant/sendproof/journeys/shop.arazzo.json', expectationsUrl: '/tenant/sendproof/journeys/shop.expect.json', source: 'code' }],
  });
  const sessions = new Map<string, { step: number }>();
  const arazzo = { arazzo: '1.1.0', info: { title: 'Shop', version: '1' }, sourceDescriptions: [{ name: 'shop', url: '/tenant/openapi.json', type: 'openapi' }],
    workflows: [{ workflowId: 'placeAndRead', summary: 'Place and read an order', inputs: { type: 'object', properties: { customerId: { type: 'string' } } },
      steps: [
        { stepId: 'place', operationId: 'Orders.Place', requestBody: { payload: { customerId: '$inputs.customerId', items: [] } }, successCriteria: [{ condition: '$statusCode == 201' }], outputs: { orderId: '$response.body#/id' } },
        { stepId: 'read', operationId: 'Orders.Get', parameters: [{ name: 'id', in: 'path', value: '$steps.place.outputs.orderId' }], successCriteria: [{ condition: '$statusCode == 200' }] },
      ] },
    { workflowId: 'priceWithCoupon', summary: 'Price with a coupon', steps: [
      { stepId: 'quote', operationId: 'Quotes.Create', successCriteria: [{ condition: '$statusCode == 200' }], outputs: { quoteId: '$response.body#/id' } },
    ] }] };
  const expectations = { sendproofExpectations: '1.0', journeys: {
    placeAndRead: { steps: { place: { writes: [{ store: 'sqlite', table: 'Orders', op: 'insert' }] } } },
    // A Send-only journey whose Redis write a traced Send records as a Db log entry, not a change.
    priceWithCoupon: { sendOnly: true, sendOnlyReason: 'Quotes are cached in Redis, which Preview can’t roll back...', steps: { quote: { writes: [
      { store: 'redis', key: 'quote:{$steps.quote.outputs.quoteId}', op: 'SET' },
      { store: 'redis', key: 'coupon:ACME10:uses', op: 'INCRBY' },
      { store: 'mongodb', collection: 'audit', op: 'insert' },
    ] } } },
  },
    approvedDifferences: [{ id: 'AD-0001', journey: 'placeAndRead', step: 'place', kind: 'extra', reason: 'Audit rows since 2.1.' }] };

  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      const url = new URL(request.url ?? '/', 'http://x');
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(JSON.stringify(value));
      };
      const cookie = request.headers.cookie ?? '';
      if (cookie.includes('session=')) signedIn = decodeURIComponent(/session=([^;]+)/.exec(cookie)![1]);
      const p = url.pathname;
      if (p === '/tenant/sendproof/_api/capabilities') return json(200, capabilities());
      if (p === '/tenant/openapi.json') return json(200, openapi);
      if (p === '/tenant/sendproof/journeys/shop.arazzo.json') return json(200, arazzo);
      if (p === '/tenant/sendproof/journeys/shop.expect.json') return json(200, expectations);
      if (p === '/tenant/customers') return json(200, { items: [{ id: 'c1', name: 'Mia' }, { id: 'c2', name: 'Leo' }] });
      if (p === '/tenant/stock') return json(200, [{ sku: 'SKU-' + (url.searchParams.get('q') ?? 'ALL'), name: 'Jacket' }]);
      if (p === '/tenant/auth/personas' && request.method === 'GET') return json(200, [{ email: 'ada@shop.dev', name: 'Ada Admin', role: 'admin' }]);
      if (p.startsWith('/tenant/auth/personas/') && request.method === 'POST') {
        response.writeHead(204, { 'Set-Cookie': `session=${encodeURIComponent('Ada Admin')}; Path=/; HttpOnly` });
        return response.end();
      }
      const sessionId = request.headers['sendproof-session'] as string | undefined;
      /** `null` means the session is unknown: the caller returns a 404 session_not_found itself. */
      const sessionField = (): { session?: { id: string; step: number } } | null => {
        if (!sessionId) return {};
        const session = sessions.get(sessionId);
        if (!session) return null;
        session.step += 1;
        return { session: { id: sessionId, step: session.step } };
      };
      if (p === '/tenant/sendproof/_api/sessions' && request.method === 'POST') {
        const id = 'sess-' + Math.random().toString(16).slice(2);
        sessions.set(id, { step: 0 });
        return json(201, { id, idleTimeoutSeconds: 300, maxLifetimeSeconds: 1800 });
      }
      if (p.startsWith('/tenant/sendproof/_api/sessions/') && p.endsWith('/rewind') && request.method === 'POST') {
        const id = p.split('/')[4];
        const session = sessions.get(id);
        if (!session) return json(404, { title: 'Not found', status: 404, code: 'session_not_found' });
        session.step = Math.max(0, JSON.parse(body || '{}').step - 1);
        response.writeHead(204); return response.end();
      }
      if (p.startsWith('/tenant/sendproof/_api/sessions/') && request.method === 'DELETE') {
        sessions.delete(p.split('/')[4]);
        response.writeHead(204); return response.end();
      }
      if (p === '/tenant/sendproof/_preview/orders' && request.method === 'POST') {
        if (request.headers.prefer !== 'tx=rollback') return json(400, { title: 'Missing Prefer' });
        const extra = sessionField();
        if (extra === null) return json(404, { title: 'Not found', status: 404, code: 'session_not_found', detail: 'Unknown, expired or foreign.' });
        const parsed = JSON.parse(body || '{}');
        if (parsed.unconfirmed) return json(200, { status: 201, body: {}, rolledBack: false });
        return json(200, { status: 201, headers: { 'content-type': 'application/json' }, body: { id: 'o1', status: 'Paid' },
          changes: [{ operation: 'insert', table: 'Orders', key: { Id: 'o1' }, before: null, after: { Id: 'o1' } }, { operation: 'insert', table: 'OrderLines', key: { Id: 1 }, before: null, after: {} }],
          effects: [{ kind: 'email', description: 'Order received' }],
          logs: [{ level: 'Debug', message: 'noise' }, { level: 'Information', message: 'Placed order' }, { level: 'Sql', message: 'INSERT', sql: { text: 'INSERT INTO Orders', parameters: [] } }],
          rolledBack: true, ...extra }, { 'Server-Timing': 'auth;dur=1.5, handler;dur=12, db;dur=3;desc="2 queries"' });
      }
      if (p.startsWith('/tenant/sendproof/_preview/orders/') && request.method === 'GET') {
        const extra = sessionField();
        if (extra === null) return json(404, { title: 'Not found', status: 404, code: 'session_not_found', detail: 'Unknown, expired or foreign.' });
        return json(200, { status: 200, headers: { 'content-type': 'application/json' }, body: { id: p.split('/').pop(), status: 'Paid' },
          changes: [], effects: [], logs: [], rolledBack: true, ...extra });
      }
      if (p === '/tenant/sendproof/_preview/coupons/ACME10/redemptions') return json(409, { title: 'Preview unavailable', status: 409, detail: 'Preview unavailable: this operation writes to Redis', code: 'preview_unavailable', store: 'redis', operation: 'INCRBY', rolledBack: false });
      if (p === '/tenant/orders' && request.method === 'GET') return json(200, { items: [], page: 1, pageSize: Number(url.searchParams.get('pageSize')) });
      if (p === '/tenant/orders' && request.method === 'POST') return json(201, { id: 'o2', status: 'Paid' }, request.headers.prefer?.includes('trace') ? { 'X-Sendproof-Trace': TRACE } : {});
      if (p === `/tenant/sendproof/_api/traces/${TRACE}`) return json(200, { changes: [{ operation: 'insert', table: 'Orders' }], effects: [], logs: [], timing: { handler: 9, queryCount: 1 } });
      if (p === '/tenant/quotes' && request.method === 'POST') return json(200, { id: 'q1' }, request.headers.prefer?.includes('trace') ? { 'X-Sendproof-Trace': TRACE_QUOTE } : {});
      if (p === `/tenant/sendproof/_api/traces/${TRACE_QUOTE}`) return json(200, { changes: [], effects: [], logs: [{ level: 'Db', message: 'SET quote:q1', db: { system: 'redis', operation: 'SET', target: 'quote:q1' } }], timing: { handler: 4, queryCount: 0 } });
      if (p.startsWith('/tenant/orders/')) return json(200, { id: p.split('/').pop(), status: 'Paid' });
      if (p === '/tenant/old') { response.writeHead(302, { Location: '/tenant/new' }); return response.end(); }
      json(404, { title: 'Not found' });
    });
  });
  return { server, seen, listen: () => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tenant`))) };
}

async function connect(api: string, allowSend: SendPolicy = 'off') {
  const { server } = createServer({ api, allowSend });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

type CallResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => await client.callTool({ name, arguments: args }) as CallResult;

test('initialize advertises tools with input and output schemas, including personas and journeys', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  assert.equal(client.getServerVersion()?.name, 'sendproof');
  assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: true });
  assert.ok(client.getInstructions()?.includes('preview_request'));
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const name of ['get_api', 'list_operations', 'describe_operation', 'list_models', 'describe_model', 'find_values', 'preview_request', 'send_request', 'get_trace', 'list_personas', 'switch_persona', 'list_journeys', 'describe_journey']) assert.ok(names.includes(name), name);
  for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.outputSchema?.type, 'object'); }
  assert.equal(tools.find(t => t.name === 'send_request')?.annotations?.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'list_operations')?.annotations?.readOnlyHint, true);
});

test('get_api, list_operations and describe_operation read capabilities and the OpenAPI document', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const info = await call(client, 'get_api');
  assert.equal(info.content[0].text, 'Shop (Development), not signed in: 6 operations, 3 previewable.');
  assert.equal(info.structuredContent?.documents[0].title, 'Shop');

  const list = await call(client, 'list_operations', { search: 'order' });
  assert.deepEqual(list.structuredContent?.operations.map((o: any) => o.operationId), ['Orders.List', 'Orders.Place', 'Orders.Get']);
  const quote = (await call(client, 'list_operations', { previewable: false })).structuredContent?.operations.find((o: any) => o.operationId === 'Quotes.Create');
  assert.equal(quote.previewReason, 'Quotes are cached in Redis.');

  const place = await call(client, 'describe_operation', { operationId: 'post /orders' });
  assert.equal(place.structuredContent?.operationId, 'Orders.Place');
  assert.deepEqual(place.structuredContent?.requestBody.content['application/json'].schema, { $ref: 'PlaceOrder' });
  const get = await call(client, 'describe_operation', { operationId: 'Orders.Get' });
  assert.deepEqual(get.structuredContent?.parameters.map((p: any) => [p.name, p.in, p.required]), [['id', 'path', true]]);
  const missing = await call(client, 'describe_operation', { operationId: 'Orders.Plac' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Did you mean Orders\.Place/);

  const model = await call(client, 'describe_model', { name: 'Line' });
  assert.deepEqual(model.structuredContent?.usedBy, []);
  const order = await call(client, 'describe_model', { name: 'PlaceOrder' });
  assert.deepEqual(order.structuredContent?.usedBy, ['Orders.Place']);
  assert.deepEqual(order.structuredContent?.schema.properties.items.items, { $ref: 'Line' });
  assert.equal((await call(client, 'list_models', { search: 'order' })).structuredContent?.models.length, 2);
});

test('find_values follows lookups, nested array fields and enums, and names the fields that exist', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const customers = await call(client, 'find_values', { operationId: 'Orders.Place', field: 'customerId' });
  assert.deepEqual(customers.structuredContent?.values, [{ value: 'c1', label: 'Mia' }, { value: 'c2', label: 'Leo' }]);
  const skus = await call(client, 'find_values', { operationId: 'Orders.Place', field: 'items[].sku', search: 'JKT' });
  assert.deepEqual(skus.structuredContent?.values, [{ value: 'SKU-JKT', label: 'Jacket' }]);
  const speed = await call(client, 'find_values', { operationId: 'Orders.Place', field: 'speed' });
  assert.equal(speed.structuredContent?.source, 'enum');
  const wrong = await call(client, 'find_values', { operationId: 'Orders.Place', field: 'items[].variant' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /Fields here: items\[\]\.sku, items\[\]\.quantity/);
});

test('preview_request posts to the preview route under the path base and reports what would be written', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const result = await call(client, 'preview_request', { operationId: 'Orders.Place', body: { customerId: 'c1', items: [] } });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'POST /orders → 201 in ' + result.structuredContent?.durationMs + ' ms, rolled back: insert Orders, insert OrderLines, 1 effect held.');
  const request = api.seen.find(s => s.url === '/tenant/sendproof/_preview/orders')!;
  assert.equal(request.headers.prefer, 'tx=rollback');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.origin, undefined);
  assert.equal(result.structuredContent?.rolledBack, true);
  assert.deepEqual(result.structuredContent?.serverTiming, { auth: 1.5, handler: 12, db: 3 });
  assert.deepEqual(result.structuredContent?.logs.map((l: any) => l.level), ['Information', 'Sql'], 'summary leaves Debug out');
  assert.equal(result.structuredContent?.logCount, 3);

  const unconfirmed = await call(client, 'preview_request', { operationId: 'Orders.Place', body: { unconfirmed: true } });
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /wasn’t confirmed as rolled back/);

  const blocked = await call(client, 'preview_request', { operationId: 'Coupons.Redeem', path: { code: 'ACME10' } });
  assert.equal(blocked.isError, undefined);
  assert.equal(blocked.content[0].text, 'Preview stopped before the write: this operation writes to Redis (INCRBY). Nothing was written; only a Send can run it.');
  assert.equal(blocked.structuredContent?.written, false);
  assert.equal(blocked.structuredContent?.blocked.store, 'redis');

  const marked = await call(client, 'preview_request', { operationId: 'Quotes.Create' });
  assert.equal(marked.isError, true);
  assert.match(marked.content[0].text, /Quotes are cached in Redis/);
  const missingPath = await call(client, 'preview_request', { operationId: 'Coupons.Redeem' });
  assert.match(missingPath.content[0].text, /code \(path\) is required/);
  const unknownQuery = await call(client, 'preview_request', { operationId: 'Orders.List', query: { size: 2 } });
  assert.match(unknownQuery.content[0].text, /has no query parameter “size”/);
});

test('send_request always allows reads, refuses writes without --allow-send or confirmSend, and traces a confirmed Send', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const off = await connect(url);
  const read = await call(off, 'send_request', { operationId: 'Orders.List', query: { pageSize: 2 } });
  assert.equal(read.structuredContent?.body.pageSize, 2);
  assert.equal(read.structuredContent?.committed, false);
  assert.ok(api.seen.some(s => s.url === '/tenant/orders?pageSize=2'));
  const refused = await call(off, 'send_request', { operationId: 'Orders.Place', body: {}, confirmSend: true });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /without --allow-send/);
  assert.equal(api.seen.filter(s => s.method === 'POST' && s.url === '/tenant/orders').length, 0);

  const on = await connect(url, 'development');
  const unconfirmed = await call(on, 'send_request', { operationId: 'Orders.Place', body: {} });
  assert.match(unconfirmed.content[0].text, /Pass confirmSend: true/);
  const sent = await call(on, 'send_request', { operationId: 'Orders.Place', body: { customerId: 'c1', items: [] }, confirmSend: true });
  assert.equal(sent.structuredContent?.status, 201);
  assert.equal(sent.structuredContent?.committed, true);
  assert.equal(sent.structuredContent?.traceId, TRACE);
  assert.deepEqual(sent.structuredContent?.timing, { handler: 9, queryCount: 1 });
  assert.match(sent.content[0].text, /committed, traced: insert Orders\.$/);
  assert.equal(api.seen.find(s => s.method === 'POST' && s.url === '/tenant/orders')?.headers.prefer, 'trace');
  const trace = await call(on, 'get_trace', { traceId: TRACE });
  assert.equal(trace.structuredContent?.changes.length, 1);

  const redirect = await call(on, 'send_request', { operationId: 'Old.Get' });
  assert.equal(redirect.isError, true);
  assert.match(redirect.content[0].text, /never follows redirects/);
});

test('Send stays off outside Development unless the server allows it anywhere', async t => {
  const api = fakeApi('Production'); const url = await api.listen(); t.after(() => api.server.close());
  const development = await connect(url, 'development');
  const refused = await call(development, 'send_request', { operationId: 'Orders.Place', body: {}, confirmSend: true });
  assert.match(refused.content[0].text, /environment “Production”/);
  const anywhere = await connect(url, 'anywhere');
  assert.equal((await call(anywhere, 'send_request', { operationId: 'Orders.Place', body: {}, confirmSend: true })).structuredContent?.status, 201);
});

test('switch_persona keeps the session cookie for later requests', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const personas = await call(client, 'list_personas');
  assert.deepEqual(personas.structuredContent?.personas, [{ email: 'ada@shop.dev', name: 'Ada Admin', role: 'admin' }]);
  const switched = await call(client, 'switch_persona', { email: 'ada@shop.dev' });
  assert.equal(switched.content[0].text, 'Signed in as Ada Admin.');
  assert.ok(api.seen.some(s => s.method === 'POST' && s.url === '/tenant/auth/personas/ada%40shop.dev'));
  await call(client, 'send_request', { operationId: 'Orders.Get', path: { id: 'o9' } });
  assert.equal(api.seen.find(s => s.url === '/tenant/orders/o9')?.headers.cookie, 'session=Ada%20Admin');
  assert.match((await call(client, 'get_api')).content[0].text, /signed in as Ada Admin/);
});

test('list_journeys and describe_journey read the Arazzo and expectations documents', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const list = await call(client, 'list_journeys');
  assert.deepEqual(list.structuredContent?.journeys.map((j: any) => [j.journeyId, j.steps]), [['placeAndRead', 2], ['priceWithCoupon', 1]]);
  const journey = await call(client, 'describe_journey', { journeyId: 'placeAndRead' });
  assert.equal(journey.content[0].text, 'Place and read an order: 2 steps.');
  assert.deepEqual(journey.structuredContent?.steps[0].expected, { writes: [{ store: 'sqlite', table: 'Orders', op: 'insert' }] });
  assert.equal(journey.structuredContent?.approvedDifferences[0].id, 'AD-0001');
});

test('start_run, run_step, run_remaining, get_run, end_run and draft_approved_difference run a journey through one Preview session', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);

  const started = await call(client, 'start_run', { journeyId: 'placeAndRead', mode: 'preview', inputs: { customerId: 'c1' } });
  assert.equal(started.isError, undefined);
  const runId = started.structuredContent?.runId;
  assert.equal(started.structuredContent?.status, 'running');
  assert.ok(api.seen.some(s => s.url === '/tenant/sendproof/_api/sessions' && s.method === 'POST'));

  const place = await call(client, 'run_step', { runId });
  assert.equal(place.structuredContent?.stepId, 'place');
  assert.equal(place.structuredContent?.httpStatus, 201);
  assert.equal(place.structuredContent?.outputs.orderId, 'o1');
  const extraFinding = place.structuredContent?.findings.find((f: any) => f.kind === 'extra');
  assert.equal(extraFinding?.target, 'OrderLines');
  const sessionHeader = api.seen.filter(s => s.url === '/tenant/sendproof/_preview/orders').at(-1)?.headers['sendproof-session'];
  assert.ok(sessionHeader, 'the Preview carried the session header');

  const rest = await call(client, 'run_remaining', { runId });
  assert.equal(rest.structuredContent?.status, 'failed', 'the unlisted OrderLines write keeps the run from a clean pass');
  assert.deepEqual(rest.structuredContent?.steps.map((s: any) => s.stepId), ['place', 'read']);
  assert.equal(rest.structuredContent?.steps[1].status, 'passed');
  assert.ok(api.seen.some(s => s.url === '/tenant/sendproof/_preview/orders/o1'));

  const fetched = await call(client, 'get_run', { runId });
  assert.equal(fetched.structuredContent?.runId, runId);

  const draft = await call(client, 'draft_approved_difference', { runId, stepId: 'place', findingId: extraFinding.id, reason: 'Audit rows added in 2.1.' });
  assert.equal(draft.isError, undefined);
  assert.equal(draft.structuredContent?.source, 'code');
  assert.equal(draft.structuredContent?.records[0].kind, 'extra');
  assert.match(draft.structuredContent?.records[0].code, /ApprovedDifference<object>/);

  await call(client, 'end_run', { runId });
  assert.ok(api.seen.some(s => s.method === 'DELETE' && s.url.startsWith('/tenant/sendproof/_api/sessions/')));
});

test('a Send-only journey can’t start in Preview, and starting Send needs confirmSend and --allow-send', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const off = await connect(url);
  const noConfirm = await call(off, 'start_run', { journeyId: 'placeAndRead', mode: 'send' });
  assert.equal(noConfirm.isError, true);
  assert.match(noConfirm.content[0].text, /confirmSend: true/);
  const noAllow = await call(off, 'start_run', { journeyId: 'placeAndRead', mode: 'send', confirmSend: true });
  assert.equal(noAllow.isError, true);
  assert.match(noAllow.content[0].text, /--allow-send/);

  const on = await connect(url, 'development');
  const started = await call(on, 'start_run', { journeyId: 'placeAndRead', mode: 'send', confirmSend: true });
  assert.equal(started.isError, undefined);
  assert.equal(started.structuredContent?.mode, 'send');
  await call(on, 'end_run', { runId: started.structuredContent?.runId });
});

test('resources expose the capabilities and the OpenAPI document', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const client = await connect(url);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map(r => r.uri), ['sendproof://capabilities', 'sendproof://openapi/Shop']);
  const read = await client.readResource({ uri: 'sendproof://openapi/Shop' });
  assert.equal(JSON.parse((read.contents[0] as { text: string }).text).info.title, 'Shop');
});

test('the stdio command completes the MCP lifecycle and keeps stdout to the protocol', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const cli = fileURLToPath(new URL('../cli/dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'mcp', '--api', url, '--persona', 'ada@shop.dev'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  const waitFor = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const line = stdout.split('\n').find(l => l.includes(`"id":${id}`));
      if (line) return JSON.parse(line);
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`no response ${id}; stderr: ${stderr}`);
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
  const init = await waitFor(1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'sendproof');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_api', arguments: {} } });
  const result = await waitFor(2);
  assert.match(result.result.content[0].text, /signed in as Ada Admin/);
  for (const line of stdout.split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.match(stderr, /MCP server for http:\/\/127\.0\.0\.1:\d+\/tenant\/ on stdio/);
});

const execFileAsync = promisify(execFile);

test('sendproof journeys list and run drive the same runner from the terminal', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const cli = fileURLToPath(new URL('../cli/dist/cli.js', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'sendproof-journeys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const list = await execFileAsync(process.execPath, [cli, 'journeys', 'list', '--api', url]);
  assert.match(list.stdout, /placeAndRead/);

  const inputsPath = join(dir, 'inputs.json');
  const outPath = join(dir, 'run.json');
  const junitPath = join(dir, 'report.xml');
  await writeFile(inputsPath, JSON.stringify({ customerId: 'c1' }));

  const run = await execFileAsync(process.execPath,
    [cli, 'journeys', 'run', '--all', '--api', url, '--inputs', inputsPath, '--out', outPath, '--junit', junitPath],
    { encoding: 'utf8' }).catch(error => error as { stdout: string; stderr: string; code: number });
  assert.equal(run.code, 1, 'the unlisted OrderLines write fails the run, and the skipped Send-only journey isn’t a “couldn’t run”');
  assert.match(run.stderr, /placeAndRead/);
  assert.match(run.stderr, /OrderLines missing|OrderLines extra/);
  assert.match(run.stderr, /Price with a coupon \(priceWithCoupon\) — preview\n  - skipped: .*is Send only: Quotes are cached in Redis, which Preview can’t roll back\. Run it with --mode send\./);
  assert.doesNotMatch(run.stderr, /couldn.t run|\.\.\./);

  const exported = JSON.parse(await readFile(outPath, 'utf8'));
  assert.deepEqual(exported.map((item: any) => [item.journeyId, item.status]), [['placeAndRead', 'failed'], ['priceWithCoupon', 'skipped']]);
  const junit = await readFile(junitPath, 'utf8');
  assert.match(junit, /<testsuites>/);
  assert.match(junit, /<testsuite name="Place and read an order"/);
  assert.match(junit, /<testsuite name="Price with a coupon" tests="1" failures="0" skipped="1"/);

  const unknown = await execFileAsync(process.execPath, [cli, 'journeys', 'run', 'noSuchJourney', '--api', url])
    .catch(error => error as { stdout: string; stderr: string; code: number });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /couldn.t run/);

  // Naming a Send-only journey in Preview is still "couldn't run", and says how to run it.
  const named = await execFileAsync(process.execPath, [cli, 'journeys', 'run', 'priceWithCoupon', '--api', url])
    .catch(error => error as { stdout: string; stderr: string; code: number });
  assert.equal(named.code, 2);
  assert.match(named.stderr, /couldn.t run — .*is Send only: Quotes are cached in Redis, which Preview can’t roll back\. Run it with --mode send\./);
  assert.doesNotMatch(named.stderr, /\.\.\./);
});

test('sendproof journeys run in Send checks Redis commands against the trace’s Db log entries', async t => {
  const api = fakeApi(); const url = await api.listen(); t.after(() => api.server.close());
  const cli = fileURLToPath(new URL('../cli/dist/cli.js', import.meta.url));
  const send = await execFileAsync(process.execPath, [cli, 'journeys', 'run', 'priceWithCoupon', '--mode', 'send', '--yes', '--allow-send', '--api', url])
    .catch(error => error as { stdout: string; stderr: string; code: number });
  assert.equal(send.code, 1, 'the INCRBY nothing recorded is missing');
  assert.doesNotMatch(send.stderr, /quote:q1/, 'the SET was found in the Db log entries');
  assert.match(send.stderr, /coupon:ACME10:uses missing/);
  assert.match(send.stderr, /audit not checked/, 'MongoDB isn’t hooked on this API');
});

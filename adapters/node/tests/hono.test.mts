import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { testBench } from '@test-bench/hono';
import type { TestBenchOptions } from '@test-bench/hono';

/** A preview provider that adds no transaction: enough to exercise the router itself. */
const passthrough = { async preview<T>(dispatch: () => Promise<T>): Promise<T> { return dispatch(); } };
const rollback = { Prefer: 'tx=rollback' };
const jsonHeaders = { 'Content-Type': 'application/json' };

function create(options: TestBenchOptions = {}) {
  return testBench({ environment: 'development', previewProvider: passthrough, ...options });
}

/** The JSON envelope the workbench returns for a Preview. */
async function envelope(response: Response) {
  return await response.json() as {
    status: number; headers: Record<string, string>; body: unknown; rolledBack: boolean;
  };
}

test('route templates map to Hono patterns and unregistered previews are rejected', async () => {
  const bench = create();
  bench.operation('GET', '/items/{id}', c => c.json({ id: c.req.param('id') }));

  const matched = await bench.request('http://localhost/bench/_preview/items/42', { headers: rollback });
  assert.equal(matched.status, 200);
  assert.equal(matched.headers.get('preference-applied'), 'tx=rollback');
  const preview = await envelope(matched);
  assert.deepEqual(preview.body, { id: '42' });
  assert.equal(preview.rolledBack, true);

  const unknownPath = await bench.request('http://localhost/bench/_preview/missing', { headers: rollback });
  assert.equal(unknownPath.status, 409);
  const wrongMethod = await bench.request('http://localhost/bench/_preview/items/42', { method: 'POST', headers: rollback });
  assert.equal(wrongMethod.status, 409);
});

test('invalid or duplicate registrations are refused before any request', () => {
  const bench = create();
  const handler = (c: Context) => c.text('ok');
  for (const template of ['items', '/items?x=1', '/a/../b', '/a/./b', '/items/{id', '/bench', '/Bench/x', '/items/', '//items']) {
    assert.throws(() => bench.operation('GET', template, handler), /OpenAPI route template/, template);
  }
  assert.throws(() => bench.operation('TRACE', '/items', handler), /supported HTTP method/);
  assert.throws(() => bench.operation('GET', '/items'), /supply the route handler/);
  bench.operation('GET', '/items', handler);
  assert.throws(() => bench.operation('get', '/items', handler), /already registered/);
  bench.operation('POST', '/items', handler);
});

test('guards registered with an operation decide both Preview and Send', async () => {
  let calls = 0;
  const guard: MiddlewareHandler = async (c, next) => {
    const role = c.req.header('x-role');
    if (!role) return c.text('', 401);
    if (role !== 'admin') return c.text('', 403);
    await next();
  };
  const bench = create();
  bench.operation('DELETE', '/items/{id}', guard, c => { calls++; return c.body(null, 204); });
  const preview = (role?: string) => bench.request('http://localhost/bench/_preview/items/1', {
    method: 'DELETE', headers: { ...rollback, ...(role ? { 'X-Role': role } : {}) },
  });

  assert.equal((await preview()).status, 401);
  assert.equal((await preview('viewer')).status, 403);
  assert.equal(calls, 0, 'a rejected guard must stop the handler');
  const allowed = await preview('admin');
  assert.equal(allowed.status, 200);
  assert.equal((await envelope(allowed)).status, 204);
  assert.equal(calls, 1);

  const sent = await bench.request('http://localhost/items/1', { method: 'DELETE', headers: { 'X-Role': 'viewer' } });
  assert.equal(sent.status, 403);
  assert.equal(calls, 1);
});

test('JSON request bodies reach the handler in Preview and in an observed Send', async () => {
  const bench = create({
    resolveIdentity: () => ({ name: 'Tester', role: 'admin', subject: 'tester@example.test', scheme: 'unit' }),
  });
  bench.operation('POST', '/items', async c => {
    const body = await c.req.json<{ name: string }>();
    return c.json({ created: body.name }, 201);
  });
  const init = { method: 'POST', body: JSON.stringify({ name: 'widget' }) };

  const previewed = await bench.request('http://localhost/bench/_preview/items', {
    ...init, headers: { ...jsonHeaders, ...rollback },
  });
  const preview = await envelope(previewed);
  assert.equal(preview.status, 201);
  assert.deepEqual(preview.body, { created: 'widget' });

  const sent = await bench.request('http://localhost/items', { ...init, headers: { ...jsonHeaders, Prefer: 'trace' } });
  assert.equal(sent.status, 201);
  assert.deepEqual(await sent.json(), { created: 'widget' });
  const trace = sent.headers.get('x-testbench-trace');
  assert(trace, 'an authenticated observed Send returns a trace id');
  const stored = await bench.request(`http://localhost/bench/_api/traces/${trace}`);
  assert.equal(stored.status, 200);

  const plain = await bench.request('http://localhost/items', { ...init, headers: jsonHeaders });
  assert.equal(plain.status, 201);
  assert.equal(plain.headers.get('x-testbench-trace'), null, 'no trace is recorded without Prefer: trace');
});

test('middleware registered with an operation runs for Send and Preview, parent state does not', async () => {
  const app = new Hono<{ Variables: { actor: string; parent: string } }>();
  const bench = testBench<{ Variables: { actor: string; parent: string } }>({
    environment: 'development', previewProvider: passthrough,
  });
  app.use('*', async (c, next) => { c.set('parent', 'set'); await next(); });
  bench.operation('GET', '/whoami',
    async (c, next) => { c.set('actor', 'operation-middleware'); await next(); },
    c => c.json({ actor: c.get('actor'), parent: c.get('parent') ?? null }));
  app.route('/', bench);

  const sent = await app.request('http://localhost/whoami');
  assert.deepEqual(await sent.json(), { actor: 'operation-middleware', parent: 'set' });

  const previewed = await app.request('http://localhost/bench/_preview/whoami', { headers: rollback });
  assert.deepEqual((await envelope(previewed)).body, { actor: 'operation-middleware', parent: null });
});

test('options control availability, discovery and validation', async () => {
  const disabled = create({ environment: 'production' });
  assert.equal((await disabled.request('http://localhost/bench/')).status, 404);

  const bench = create({ apiName: 'Unit API', openApiUrl: '/docs/openapi.json', database: 'Test DB' });
  bench.operation('POST', '/items', c => c.text('ok')).operation('GET', '/items/{id}', c => c.text('ok'));
  const capabilities = await (await bench.request('http://localhost/bench/_api/capabilities')).json() as {
    apiName: string; database: string; openApiUrl: string; observedSend: boolean; previewOperations: unknown[];
  };
  assert.equal(capabilities.apiName, 'Unit API');
  assert.equal(capabilities.database, 'Test DB');
  assert.equal(capabilities.openApiUrl, '/docs/openapi.json');
  assert.equal(capabilities.observedSend, true);
  assert.deepEqual(capabilities.previewOperations, [
    { method: 'POST', path: '/items' }, { method: 'GET', path: '/items/{id}' },
  ]);

  const withoutProvider = testBench({ environment: 'development' });
  withoutProvider.operation('GET', '/items', c => c.text('ok'));
  assert.equal((await withoutProvider.request('http://localhost/bench/_preview/items', { headers: rollback })).status, 503);
  const quiet = await (await withoutProvider.request('http://localhost/bench/_api/capabilities')).json() as {
    previewOperations: unknown[]; observedSend: boolean;
  };
  assert.deepEqual(quiet.previewOperations, []);
  assert.equal(quiet.observedSend, false);

  assert.throws(() => create({ openApiUrl: 'https://example.test/openapi.json' }), /same-origin/);
  assert.throws(() => create({ maxResponseBytes: 0 }), /positive integers/);
  assert.throws(() => create({ traceTtlMs: 1.5 }), /positive integers/);
});

test('Preview insists on the rollback preference, the same origin and authorization', async () => {
  const bench = create({ authorize: ({ headers }) => headers['x-allowed'] === 'yes' });
  bench.operation('GET', '/items', c => c.json([]));
  const url = 'http://localhost/bench/_preview/items';

  assert.equal((await bench.request(url, { headers: { Prefer: 'tx=rollback' } })).status, 401, 'workbench access is denied');
  const allowed = { 'X-Allowed': 'yes' };
  assert.equal((await bench.request(url, { headers: allowed })).status, 400, 'the preference is required');
  assert.equal((await bench.request(url, { headers: { ...allowed, ...rollback, Origin: 'http://evil.test' } })).status, 403);
  assert.equal((await bench.request(url, { headers: { ...allowed, ...rollback, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await bench.request(url, { headers: { ...allowed, ...rollback, Origin: 'http://localhost' } })).status, 200);
  assert.equal((await bench.request('http://localhost/bench/_preview/bench/x', { headers: { ...allowed, ...rollback } })).status, 400,
    'the workbench itself cannot be a preview target');
  assert.equal((await bench.request('http://localhost/items', { headers: { ...allowed, ...rollback } })).status, 400,
    'the preference is only honoured on the preview URL');
});

test('a router mounted under a base path prefixes discovery and resolves previews', async () => {
  const app = new Hono();
  const bench = create({ basePath: '/tenant', openApiUrl: '/openapi.json', documents: [{ name: 'Guide', url: '/guide' }] });
  bench.operation('GET', '/items/{id}', c => c.json({ id: c.req.param('id') }));
  app.route('/tenant', bench);

  const capabilities = await (await app.request('http://localhost/tenant/bench/_api/capabilities')).json() as {
    openApiUrl: string; documents: { url: string }[];
  };
  assert.equal(capabilities.openApiUrl, '/tenant/openapi.json');
  assert.equal(capabilities.documents[0]?.url, '/tenant/guide');
  assert.equal((await app.request('http://localhost/tenant/bench', { redirect: 'manual' })).headers.get('location'), '/tenant/bench/');
  const index = await app.request('http://localhost/tenant/bench/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);

  const previewed = await app.request('http://localhost/tenant/bench/_preview/items/7', { headers: rollback });
  assert.equal(previewed.status, 200);
  assert.deepEqual((await envelope(previewed)).body, { id: '7' });
  assert.equal((await app.request('http://localhost/bench/_api/capabilities')).status, 404, 'nothing is served outside the mount');

  for (const basePath of ['/tenant/', 'tenant', '/a/../b', '/a//b', '/te nant']) {
    assert.throws(() => create({ basePath }), /basePath must be an absolute path/, basePath);
  }
});

test('preview cancels a response stream as soon as it exceeds the capture limit', async () => {
  let cancelled = false;
  let reads = 0;
  const bench = create({ maxResponseBytes: 8 });
  bench.operation('GET', '/stream', () => new Response(new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(8));
    },
    cancel() { cancelled = true; },
  })));

  const response = await bench.request('http://localhost/bench/_preview/stream', { headers: rollback });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('preference-applied'), null);
  assert.equal(cancelled, true);
  assert(reads <= 3, 'the adapter must not buffer the remaining response');
});

test('a response exactly at the limit is returned and one byte over is refused', async () => {
  const bench = create({ maxResponseBytes: 16 });
  bench.operation('GET', '/exact', c => c.text('x'.repeat(16)));
  bench.operation('GET', '/over', c => c.text('x'.repeat(17)));
  assert.equal((await bench.request('http://localhost/bench/_preview/exact', { headers: rollback })).status, 200);
  assert.equal((await bench.request('http://localhost/bench/_preview/over', { headers: rollback })).status, 413);
});

test('handler failures and bodiless responses are reported without leaking state', async () => {
  mock.method(console, 'error', () => {}); // Hono logs unhandled handler errors
  const bench = create();
  bench.operation('GET', '/broken', () => { throw new Error('secret detail'); });
  bench.operation('GET', '/empty', c => c.body(null, 204));
  const broken = await bench.request('http://localhost/bench/_preview/broken', { headers: rollback });
  assert.equal(broken.status, 500);
  assert(!(await broken.text()).includes('secret detail'));
  const empty = await bench.request('http://localhost/bench/_preview/empty', { headers: rollback });
  assert.equal(empty.status, 200);
  const preview = await envelope(empty);
  assert.equal(preview.status, 204);
  assert.equal(preview.body, null);
});

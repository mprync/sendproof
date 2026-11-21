// Fastify adapter tests. Requests go through `app.inject`, which runs Fastify's real router, hooks,
// validation and serialization without a socket; a real SQLite database sits behind the provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, LightMyRequestResponse } from 'fastify';
import { deliverEffect } from '@test-bench/core';
import { testBench } from '@test-bench/fastify';
import type { FastifyBenchOptions } from '@test-bench/fastify';
import type { SQLiteDatabase } from '@test-bench/sqlite';
import { createItems, exists, identityFor } from './support/items.mts';
import type { PreviewResult, Problem } from './support/items.mts';

interface Harness {
  app: FastifyInstance;
  /** The scope the bench is registered in; equals `app` unless a prefix is used. */
  scope: FastifyInstance;
  db: SQLiteDatabase;
  errors: unknown[];
  hooks: string[];
}

/** Gate a route like application auth: 401 anonymous, 403 for anyone but an admin. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = identityFor(request.headers['x-user']);
  if (!identity) await reply.code(401).send({ message: 'Sign in' });
  else if (identity.role !== 'admin') await reply.code(403).send({ message: 'Forbidden' });
}

const itemBody = {
  type: 'object', required: ['id', 'name'], additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } },
} as const;

/**
 * Build an app with the standard operations. `prefix` registers the whole application in a
 * prefixed scope; `configure` can register extra operations before the app is ready.
 */
async function start(t: test.TestContext, options: FastifyBenchOptions = {}, prefix = '',
  configure: (scope: FastifyInstance, db: SQLiteDatabase) => void = () => {}): Promise<Harness> {
  const db = createItems();
  const app = Fastify();
  t.after(async () => { await app.close(); await db.close(); });
  const errors: unknown[] = [];
  const hooks: string[] = [];
  let scope!: FastifyInstance;

  await app.register(async inner => {
    scope = inner;
    // An application-level hook, which must run for the in-process Preview dispatch too.
    inner.addHook('onRequest', async request => { hooks.push(request.url); });
    await inner.register(testBench, {
      environment: 'development',
      previewProvider: db,
      resolveIdentity: ({ raw }) => identityFor(raw.headers['x-user']),
      onError: error => { errors.push(error); },
      ...options,
    });
    inner.testBench.operation('POST', '/items', {
      preHandler: requireAdmin,
      schema: { body: itemBody },
      async handler(request, reply) {
        const { id, name } = request.body as { id: string; name: string };
        await db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id, name }, { table: 'items', keys: [{ id }] });
        await deliverEffect({ kind: 'email', description: 'Created item' }, () => undefined);
        return reply.code(201).send({ id, name });
      },
    });
    inner.testBench.operation('GET', '/items/{id}', async (request, reply) => {
      const row = await db.get('SELECT id, name FROM items WHERE id = :id', { id: (request.params as { id: string }).id });
      return row ? { ...row } : reply.code(404).send({ message: 'Not found' });
    });
    inner.testBench.operation('PATCH', '/items/{id}', {
      preHandler: requireAdmin,
      async handler(request, reply) {
        const { id } = request.params as { id: string };
        const { name } = request.body as { name: string };
        await db.write('UPDATE items SET name = :name WHERE id = :id', { id, name }, { table: 'items', keys: [{ id }] });
        const { tag } = request.query as { tag?: string };
        if (tag) void reply.header('X-Fixture-Tag', tag);
        return { id, name };
      },
    });
    inner.testBench.operation('POST', '/items/{id}/fail', async request => {
      const { id } = request.params as { id: string };
      await db.write('INSERT INTO items (id, name) VALUES (:id, :id)', { id }, { table: 'items', keys: [{ id }] });
      throw new Error('handler exploded');
    });
    configure(inner, db);
    inner.get('/openapi.json', async () => ({ openapi: '3.1.0' }));
    // Not registered as an operation, so Preview must refuse it.
    inner.post('/items/:id/ordinary', async (request, reply) => {
      const { id } = request.params as { id: string };
      await db.write('INSERT INTO items (id, name) VALUES (:id, :id)', { id });
      return reply.code(201).send({ id });
    });
  }, prefix ? { prefix } : {});
  await app.ready();
  return { app, scope, db, errors, hooks };
}

const rollback = { prefer: 'tx=rollback' };

async function preview(h: Harness, path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD'; user?: string;
  payload?: unknown; headers?: Record<string, string>; prefix?: string } = {}): Promise<{ response: LightMyRequestResponse; body: any }> {
  const response = await h.app.inject({
    method: init.method ?? 'POST',
    url: `${init.prefix ?? ''}/bench/_preview${path}`,
    headers: { ...rollback, ...(init.user ? { 'x-user': init.user } : {}), ...init.headers },
    ...(init.payload === undefined ? {} : { payload: init.payload as object }),
  });
  let body: unknown;
  try { body = response.json(); } catch { body = undefined; }
  return { response, body };
}

test('Preview dispatches the registered route, captures the change and rolls the write back', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items', { user: 'admin', payload: { id: 'one', name: 'First' } });
  const result = body as PreviewResult;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['preference-applied'], 'tx=rollback');
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: 'one', name: 'First' });
  assert.equal(result.rolledBack, true);
  assert.deepEqual(result.changes?.map(c => [c.operation, c.table, c.key]), [['insert', 'items', { id: 'one' }]]);
  assert.deepEqual(result.effects, [{ kind: 'email', description: 'Created item' }], 'the effect is suppressed, not delivered');
  assert.equal(await exists(h.db, 'one'), false, 'the database is unchanged after Preview');
  assert.deepEqual(h.hooks, ['/bench/_preview/items', '/items'], 'application hooks run for the real request and the rewritten dispatch');

  const sent = await h.app.inject({ method: 'POST', url: '/items', headers: { 'x-user': 'admin' }, payload: { id: 'two', name: 'Second' } });
  assert.equal(sent.statusCode, 201);
  assert.equal(await exists(h.db, 'two'), true, 'ordinary Send persists');
});

test('route templates bind parameters and the query string, and only the registered method matches', async t => {
  const h = await start(t);
  await h.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: 'a b', name: 'Spaced' });
  const wrongMethod = await preview(h, '/items/a%20b?tag=urgent', { method: 'POST', user: 'admin', payload: { name: 'Renamed' } });
  assert.equal(wrongMethod.response.statusCode, 409, 'POST is not registered for /items/{id}');
  assert.equal((wrongMethod.body as Problem).title, 'This operation is unavailable for preview.');

  const update = await preview(h, '/items/a%20b?tag=urgent', { method: 'PATCH', user: 'admin', payload: { name: 'Renamed' } });
  const result = update.body as PreviewResult;
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: 'a b', name: 'Renamed' });
  assert.equal(result.headers['x-fixture-tag'], 'urgent');
  assert.deepEqual(result.changes?.map(c => [c.operation, c.before, c.after]), [
    ['update', { id: 'a b', name: 'Spaced' }, { id: 'a b', name: 'Renamed' }],
  ]);
  assert.equal((await h.db.get('SELECT name FROM items WHERE id = :id', { id: 'a b' }))?.name, 'Spaced');

  const read = await preview(h, '/items/a%20b', { method: 'GET' });
  assert.deepEqual((read.body as PreviewResult).body, { id: 'a b', name: 'Spaced' });
});

test('an application route that is not registered as an operation is refused by Preview', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items/x/ordinary', { user: 'admin' });
  assert.equal(response.statusCode, 409);
  assert.equal((body as Problem).title, 'This operation is unavailable for preview.');
  assert.equal(await exists(h.db, 'x'), false);
  const sent = await h.app.inject({ method: 'POST', url: '/items/x/ordinary' });
  assert.equal(sent.statusCode, 201);
  assert.equal(await exists(h.db, 'x'), true, 'the ordinary route still works for Send');
  assert.equal((await preview(h, '/missing')).response.statusCode, 409, 'an unknown path is also unavailable');
});

test('a Fastify prefix is reflected in discovery and Preview, and /bench outside the prefix is not served', async t => {
  const h = await start(t, { documents: [{ name: 'Guide', url: '/guide.md' }] }, '/tenant');
  const capabilities = (await h.app.inject({ url: '/tenant/bench/_api/capabilities' })).json() as Record<string, any>;
  assert.equal(capabilities.openApiUrl, '/tenant/openapi.json');
  assert.deepEqual(capabilities.documents, [{ name: 'Guide', url: '/tenant/guide.md' }]);
  assert.deepEqual(capabilities.previewOperations.map((o: any) => `${o.method} ${o.path}`),
    ['POST /items', 'GET /items/{id}', 'PATCH /items/{id}', 'POST /items/{id}/fail']);
  assert.equal(capabilities.observedSend, true);

  const redirect = await h.app.inject({ url: '/tenant/bench?x=1' });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, '/tenant/bench/?x=1');
  assert.equal((await h.app.inject({ url: '/tenant/bench/' })).statusCode, 200);

  const { body } = await preview(h, '/items', { prefix: '/tenant', user: 'admin', payload: { id: 'mounted', name: 'N' } });
  assert.equal((body as PreviewResult).status, 201);
  assert.equal(await exists(h.db, 'mounted'), false);
  assert.equal((await h.app.inject({ url: '/bench/_api/capabilities' })).statusCode, 404);
});

test('authorization is enforced for the workbench, for Preview and by route hooks inside Preview', async t => {
  const h = await start(t, { authorize: (_request, identity) => identity !== null });
  const anonymous = await h.app.inject({ url: '/bench/_api/capabilities' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((anonymous.json() as Problem).title, 'Workbench access denied.');
  const signedIn = await h.app.inject({ url: '/bench/_api/capabilities', headers: { 'x-user': 'viewer' } });
  assert.equal(signedIn.statusCode, 200);
  assert.deepEqual(signedIn.json().identity, { name: 'Fixture Viewer', role: 'viewer' });

  assert.equal((await preview(h, '/items', { payload: { id: 'q', name: 'Q' } })).response.statusCode, 401, 'anonymous preview');
  const denied = await preview(h, '/items', { user: 'viewer', payload: { id: 'q', name: 'Q' } });
  assert.equal(denied.response.statusCode, 403, 'the route preHandler rejects a viewer inside the rewritten request');
  assert.equal((denied.body as Problem).title, 'Preview access denied.');
  assert.equal(await exists(h.db, 'q'), false);
});

test('Fastify schema validation runs inside Preview and its 400 is reported as the operation result', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items', { user: 'admin', payload: { id: 'only-id' } });
  const result = body as PreviewResult;
  assert.equal(response.statusCode, 200);
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.body), /name/);
  assert.equal(result.rolledBack, true);
  const empty = await preview(h, '/items', { user: 'admin', payload: { id: 'a', name: '' } });
  assert.equal((empty.body as PreviewResult).status, 400, 'minLength is enforced');
  assert.equal(await exists(h.db, 'a'), false);
  assert.equal(await exists(h.db, 'only-id'), false);
});

test('Preview requests are validated before any handler runs', async t => {
  let ran = 0;
  const h = await start(t, {}, '', scope => { scope.testBench.operation('POST', '/probe', async (_request, reply) => { ran++; return reply.code(204).send(); }); });
  const call = (url: string, method: 'POST' | 'HEAD', headers: Record<string, string> = {}) => h.app.inject({ method, url, headers });
  const cases: [string, string, 'POST' | 'HEAD', Record<string, string>, number, string][] = [
    ['missing Prefer', '/bench/_preview/probe', 'POST', {}, 400, 'A Test Bench preview requires Prefer: tx=rollback.'],
    ['rollback outside the preview URL', '/probe', 'POST', rollback, 400, 'Use the Test Bench preview URL.'],
    ['cross-origin', '/bench/_preview/probe', 'POST', { ...rollback, origin: 'http://evil.example' }, 403, 'Preview is restricted to the application origin.'],
    ['cross-site fetch metadata', '/bench/_preview/probe', 'POST', { ...rollback, 'sec-fetch-site': 'cross-site' }, 403, 'Preview is restricted to the application origin.'],
    ['HEAD', '/bench/_preview/probe', 'HEAD', rollback, 405, ''],
    ['self target', '/bench/_preview/bench/_api/capabilities', 'POST', rollback, 400, 'The Test Bench preview target is invalid.'],
    ['empty target', '/bench/_preview', 'POST', rollback, 400, 'The Test Bench preview target is invalid.'],
    ['non-GET discovery', '/bench/_api/capabilities', 'POST', {}, 405, 'Use GET for workbench discovery and assets.'],
  ];
  for (const [label, url, method, headers, status, title] of cases) {
    const response = await call(url, method, headers);
    assert.equal(response.statusCode, status, label);
    if (title) assert.equal((response.json() as Problem).title, title, label);
  }
  assert.equal(ran, 0, 'no rejected request reached the handler');
  assert.equal((await call('/bench/_preview/probe', 'POST', rollback)).statusCode, 200);
  assert.equal(ran, 1);
});

test('a preview target with encoded dot segments is rejected on the wire', async t => {
  let ran = 0;
  const h = await start(t, {}, '', scope => { scope.testBench.operation('POST', '/probe', async (_request, reply) => { ran++; return reply.code(204).send(); }); });
  // inject() and fetch() normalise dot segments before sending, so use a real socket and a raw request line.
  const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
  const { hostname, port } = new URL(address);
  const status = await new Promise<number>((resolve, reject) => {
    const request = http.request({ hostname, port, path: '/bench/_preview/a/%2e%2e/probe', method: 'POST', headers: rollback },
      response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 400);
  assert.equal(ran, 0);
});

test('operation() rejects unsafe or duplicate registrations', async t => {
  const handler = async (): Promise<string> => 'ok';
  let chained = false;
  // Fastify only accepts routes before the instance is ready, so the successful registration happens during setup.
  const h = await start(t, {}, '', ({ testBench: bench }) => { chained = bench.operation('delete', '/ok/{id}', handler) === bench; });
  assert.equal(chained, true, 'registration is chainable');
  const { testBench: api } = h.scope;
  for (const template of ['items', '/items/*', '/items/:id', '/items/{id}/{', '/a/../b', '/bench', '/Bench/x', '/items//x', '/items?x', '/items/(.*)']) {
    assert.throws(() => api.operation('POST', template, handler), TypeError, template);
  }
  assert.throws(() => api.operation('TRACE', '/x', handler), TypeError);
  assert.throws(() => api.operation('POST', '/x', {} as never), TypeError, 'a handler is required');
  assert.throws(() => api.operation('post', '/items', handler), /already registered/, 'method case is normalised');
  assert.throws(() => api.operation('DELETE', '/ok/{id}', handler), /already registered/, 'the chained registration is recorded');
});

test('a streamed response that passes maxResponseBytes ends the stream, returns 413 and stops reading', async t => {
  let reads = 0;
  let destroyed = false;
  const h = await start(t, { maxResponseBytes: 64 }, '', scope => {
    scope.testBench.operation('GET', '/stream', async (_request, reply) => {
      const stream = new Readable({
        read() { reads++; this.push(Buffer.alloc(32)); },
        destroy(error, callback) { destroyed = true; callback(error); },
      });
      return reply.type('application/octet-stream').send(stream);
    });
  });
  const { response, body } = await preview(h, '/stream', { method: 'GET' });
  assert.equal(response.statusCode, 413);
  assert.equal(response.headers['preference-applied'], undefined);
  assert.equal((body as Problem).title, 'The preview response exceeds the configured size limit.');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(destroyed, true, 'the producer is told the response closed');
  assert(reads <= 8, `the adapter stopped buffering after the cap (${reads} reads)`);
});

test('a small streamed response is assembled whole, and a single oversized payload is also rejected', async t => {
  const h = await start(t, { maxResponseBytes: 64 }, '', scope => {
    scope.testBench.operation('GET', '/chunks', async (_request, reply) =>
      reply.type('text/plain').send(Readable.from(['hello ', 'streamed ', 'world'])));
    scope.testBench.operation('GET', '/huge', async (_request, reply) => reply.type('text/plain').send('x'.repeat(65)));
  });
  const chunked = await preview(h, '/chunks', { method: 'GET' });
  assert.equal((chunked.body as PreviewResult).body, 'hello streamed world');
  assert.equal((await preview(h, '/huge', { method: 'GET' })).response.statusCode, 413);
});

test('handler and provider failures return a safe 500 problem, roll back and report through onError', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items/boom/fail', { user: 'admin' });
  assert.equal(response.statusCode, 500);
  assert.equal((body as Problem).title, 'The preview operation did not complete safely.', 'Fastify turns the throw into a 500 response');
  assert.doesNotMatch(JSON.stringify(body), /exploded/, 'the error message does not leak');
  assert.equal(await exists(h.db, 'boom'), false);
  assert.equal((await h.app.inject({ method: 'POST', url: '/items/boom/fail' })).statusCode, 500);

  const thrown = await start(t, { previewProvider: { async preview() { throw new Error('provider down'); } } });
  const failed = await preview(thrown, '/items', { user: 'admin', payload: { id: 'p', name: 'P' } });
  assert.equal(failed.response.statusCode, 500);
  assert.equal((failed.body as Problem).title, 'The preview could not be completed safely.');
  assert.equal(thrown.errors.length, 1);
  assert.match(String((thrown.errors[0] as Error).message), /provider down/);
});

test('preview responses drop connection-scoped headers and cookies', async t => {
  const h = await start(t, {}, '', scope => {
    scope.testBench.operation('POST', '/headers', async (_request, reply) => reply
      .headers({ 'Set-Cookie': 'sid=secret', Location: '/elsewhere', 'X-Visible': 'yes', Connection: 'X-Hop', 'X-Hop': 'dropped' })
      .code(201).send({ ok: true }));
  });
  const { body } = await preview(h, '/headers');
  const { headers, status } = body as PreviewResult;
  assert.equal(status, 201);
  assert.equal(headers['x-visible'], 'yes');
  for (const name of ['set-cookie', 'location', 'connection', 'x-hop']) assert.equal(headers[name], undefined, name);
});

test('Send with Prefer: trace records an owner-bound trace that other subjects cannot read', async t => {
  const h = await start(t);
  const sent = await h.app.inject({ method: 'POST', url: '/items', headers: { 'x-user': 'admin', prefer: 'trace' }, payload: { id: 'traced', name: 'T' } });
  assert.equal(sent.statusCode, 201);
  const id = sent.headers['x-testbench-trace'];
  assert.match(String(id), /^[0-9a-f-]{36}$/);
  assert.equal(await exists(h.db, 'traced'), true, 'observed Send is a normal, committed request');

  const trace = await h.app.inject({ url: `/bench/_api/traces/${id}`, headers: { 'x-user': 'admin' } });
  assert.equal(trace.statusCode, 200);
  const recorded = trace.json() as PreviewResult & { timing: unknown };
  assert.deepEqual(recorded.changes?.map(c => c.operation), ['insert']);
  assert.deepEqual(recorded.effects, [{ kind: 'email', description: 'Created item', delivered: true }]);
  assert.equal(typeof recorded.timing, 'object');

  assert.equal((await h.app.inject({ url: `/bench/_api/traces/${id}`, headers: { 'x-user': 'viewer' } })).statusCode, 404);
  assert.equal((await h.app.inject({ url: `/bench/_api/traces/${id}` })).statusCode, 404, 'anonymous callers cannot read it');

  const untraced = await h.app.inject({ method: 'POST', url: '/items', headers: { 'x-user': 'admin' }, payload: { id: 'plain', name: 'P' } });
  assert.equal(untraced.headers['x-testbench-trace'], undefined);
  const rejected = await h.app.inject({ method: 'POST', url: '/items', headers: { 'x-user': 'viewer', prefer: 'trace' }, payload: { id: 'v', name: 'V' } });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers['x-testbench-trace'], undefined, 'failed authorization is never traced');
  const ordinary = await h.app.inject({ method: 'POST', url: '/items/o/ordinary', headers: { 'x-user': 'admin', prefer: 'trace' } });
  assert.equal(ordinary.headers['x-testbench-trace'], undefined, 'only registered operations are observed');
});

test('workbench assets are served with validators and the workbench is unavailable outside its environments', async t => {
  const h = await start(t);
  const index = await h.app.inject({ url: '/bench/' });
  assert.equal(index.statusCode, 200);
  assert.match(String(index.headers['content-type']), /text\/html/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const cached = await h.app.inject({ url: '/bench/', headers: { 'if-none-match': String(index.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  assert.equal((await h.app.inject({ url: '/bench/%2e%2e/package.json' })).statusCode, 404);
  assert.equal((await h.app.inject({ url: '/bench/missing.js' })).statusCode, 404);

  const production = await start(t, { environment: 'production' });
  assert.equal((await production.app.inject({ url: '/bench/_api/capabilities' })).statusCode, 404);
  assert.equal((await production.app.inject({ url: '/openapi.json' })).statusCode, 200, 'application routes are unaffected');
  const sent = await production.app.inject({ method: 'POST', url: '/items', headers: { 'x-user': 'admin', prefer: 'trace' }, payload: { id: 'p', name: 'P' } });
  assert.equal(sent.headers['x-testbench-trace'], undefined, 'no tracing when disabled');
});

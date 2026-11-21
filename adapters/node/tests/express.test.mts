// Express adapter tests. Each test starts a real Express app on a loopback socket and drives it
// over HTTP, with a real SQLite database behind the rollback provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { deliverEffect } from '@test-bench/core';
import { testBench } from '@test-bench/express';
import type { TestBenchMiddleware } from '@test-bench/express';
import type { SQLiteDatabase } from '@test-bench/sqlite';
import { createItems, exists, identityFor } from './support/items.mts';
import type { PreviewResult, Problem } from './support/items.mts';

interface Harness {
  url: string;
  db: SQLiteDatabase;
  bench: TestBenchMiddleware;
  errors: unknown[];
}

/** Gate a route like application auth: 401 anonymous, 403 for anyone but an admin. */
const requireAdmin: RequestHandler = (req, res, next) => {
  const identity = identityFor(req.get('x-user'));
  if (!identity) { res.status(401).json({ message: 'Sign in' }); return; }
  if (identity.role !== 'admin') { res.status(403).json({ message: 'Forbidden' }); return; }
  next();
};

/** Listen on a loopback port and close the server when the test ends. */
async function listen(t: test.TestContext, app: Express): Promise<string> {
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Build an app with the bench mounted at `mount` and the standard test operations registered.
 * `configure` can adjust bench options and register extra operations before the app starts.
 */
async function start(t: test.TestContext, options: Parameters<typeof testBench>[0] = {}, mount = '',
  configure: (bench: TestBenchMiddleware, db: SQLiteDatabase) => void = () => {}): Promise<Harness> {
  const db = createItems();
  t.after(() => db.close());
  const errors: unknown[] = [];
  const bench = testBench({
    environment: 'development',
    previewProvider: db,
    resolveIdentity: ({ raw }) => identityFor(raw.get('x-user')),
    onError: error => { errors.push(error); },
    ...options,
  });
  const router = express.Router();
  router.use(express.json());
  router.use(bench);

  bench.operation('POST', '/items', requireAdmin, async (req: Request, res: Response) => {
    const { id, name } = req.body ?? {};
    if (typeof id !== 'string' || typeof name !== 'string') {
      res.status(422).json({ message: 'id and name are required' });
      return;
    }
    await db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id, name }, { table: 'items', keys: [{ id }] });
    await deliverEffect({ kind: 'email', description: 'Created item' }, () => undefined);
    res.status(201).json({ id, name });
  });
  bench.operation('GET', '/items/{id}', async (req, res) => {
    const row = await db.get('SELECT id, name FROM items WHERE id = :id', { id: String(req.params.id) });
    if (row) res.json(row); else res.status(404).json({ message: 'Not found' });
  });
  bench.operation('PATCH', '/items/{id}', requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    await db.write('UPDATE items SET name = :name WHERE id = :id', { id, name: String(req.body?.name) }, { table: 'items', keys: [{ id }] });
    if (typeof req.query.tag === 'string') res.set('X-Fixture-Tag', req.query.tag);
    res.json({ id, name: req.body?.name });
  });
  bench.operation('POST', '/items/{id}/fail', async (req, res) => {
    const id = String(req.params.id);
    await db.write('INSERT INTO items (id, name) VALUES (:id, :id)', { id }, { table: 'items', keys: [{ id }] });
    throw new Error('handler exploded');
  });
  configure(bench, db);
  router.get('/openapi.json', (_req, res) => { res.json({ openapi: '3.1.0' }); });
  // Not registered as an operation, so Preview must refuse it.
  router.post('/items/:id/ordinary', async (req, res) => {
    await db.write('INSERT INTO items (id, name) VALUES (:id, :id)', { id: req.params.id ?? '' });
    res.status(201).json({ id: req.params.id });
  });

  const app = express();
  app.use(mount || '/', router);
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    res.status(500).json({ message: 'Fixture request failed' });
  });
  return { url: await listen(t, app) + mount, db, bench, errors };
}

/** POST with an exact, un-normalised request path and return the status code. */
function rawPost(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path, method: 'POST', headers: { Prefer: 'tx=rollback' } },
      response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
    request.on('error', reject);
    request.end();
  });
}

const json = { 'Content-Type': 'application/json' };
const rollback = { ...json, Prefer: 'tx=rollback' };

async function preview(h: Harness, path: string, init: { method?: string; user?: string; body?: unknown;
  headers?: Record<string, string> } = {}): Promise<{ response: Response0; body: any }> {
  const response = await fetch(`${h.url}/bench/_preview${path}`, {
    method: init.method ?? 'POST',
    headers: { ...rollback, ...(init.user ? { 'x-user': init.user } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { response, body: await response.json().catch(() => undefined) };
}
type Response0 = globalThis.Response;

test('Preview dispatches the registered handler chain, captures the change and rolls the write back', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items', { user: 'admin', body: { id: 'one', name: 'First' } });
  const result = body as PreviewResult;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('preference-applied'), 'tx=rollback');
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: 'one', name: 'First' });
  assert.equal(result.rolledBack, true);
  assert.deepEqual(result.changes?.map(c => [c.operation, c.table, c.key]), [['insert', 'items', { id: 'one' }]]);
  assert.deepEqual(result.effects, [{ kind: 'email', description: 'Created item' }], 'the effect is suppressed, not delivered');
  assert.equal(await exists(h.db, 'one'), false, 'the database is unchanged after Preview');

  const sent = await fetch(`${h.url}/items`, { method: 'POST', headers: { ...json, 'x-user': 'admin' }, body: JSON.stringify({ id: 'two', name: 'Second' }) });
  assert.equal(sent.status, 201);
  assert.equal(await exists(h.db, 'two'), true, 'ordinary Send persists');
});

test('route templates bind parameters and the query string, and only the registered method matches', async t => {
  const h = await start(t);
  await h.db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id: 'a b', name: 'Spaced' });
  const patched = await preview(h, '/items/a%20b?tag=urgent', { method: 'POST', user: 'admin', body: { name: 'Renamed' } });
  assert.equal(patched.response.status, 409, 'POST is not registered for /items/{id}');
  assert.equal((patched.body as Problem).title, 'This operation is unavailable for preview.');

  const update = await preview(h, '/items/a%20b?tag=urgent', { method: 'PATCH', user: 'admin', body: { name: 'Renamed' } });
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
  assert.equal(response.status, 409);
  assert.equal((body as Problem).title, 'This operation is unavailable for preview.');
  assert.equal(await exists(h.db, 'x'), false);
  const sent = await fetch(`${h.url}/items/x/ordinary`, { method: 'POST' });
  assert.equal(sent.status, 201);
  assert.equal(await exists(h.db, 'x'), true, 'the ordinary route still works for Send');
});

test('a mount path is reflected in discovery and Preview, and /bench outside the mount is not served', async t => {
  const h = await start(t, { documents: [{ name: 'Guide', url: '/guide.md' }] }, '/tenant');
  const capabilities = await (await fetch(`${h.url}/bench/_api/capabilities`)).json() as Record<string, any>;
  assert.equal(capabilities.openApiUrl, '/tenant/openapi.json');
  assert.deepEqual(capabilities.documents, [{ name: 'Guide', url: '/tenant/guide.md' }]);
  assert.deepEqual(capabilities.previewOperations.map((o: any) => `${o.method} ${o.path}`),
    ['POST /items', 'GET /items/{id}', 'PATCH /items/{id}', 'POST /items/{id}/fail']);
  assert.equal(capabilities.observedSend, true);

  const redirect = await fetch(`${h.url}/bench?x=1`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/tenant/bench/?x=1');

  const { body } = await preview(h, '/items', { user: 'admin', body: { id: 'mounted', name: 'N' } });
  assert.equal((body as PreviewResult).status, 201);
  assert.equal((await fetch(h.url.replace('/tenant', '') + '/bench/_api/capabilities')).status, 404);
});

test('authorization is enforced for the workbench, for Preview and by route middleware inside Preview', async t => {
  const h = await start(t, { authorize: (_request, identity) => identity !== null });
  const anonymous = await fetch(`${h.url}/bench/_api/capabilities`);
  assert.equal(anonymous.status, 401);
  assert.equal(((await anonymous.json()) as Problem).title, 'Workbench access denied.');
  const signedIn = await fetch(`${h.url}/bench/_api/capabilities`, { headers: { 'x-user': 'viewer' } });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(((await signedIn.json()) as any).identity, { name: 'Fixture Viewer', role: 'viewer' });

  assert.equal((await preview(h, '/items', { body: { id: 'q', name: 'Q' } })).response.status, 401, 'anonymous preview');
  const denied = await preview(h, '/items', { user: 'viewer', body: { id: 'q', name: 'Q' } });
  assert.equal(denied.response.status, 403, 'the route chain rejects a viewer inside the rewritten request');
  assert.equal((denied.body as Problem).title, 'Preview access denied.');
  assert.equal(await exists(h.db, 'q'), false);
});

test('Preview requests are validated before any handler runs', async t => {
  let ran = 0;
  const h = await start(t, {}, '', bench => { bench.operation('POST', '/probe', (_req, res) => { ran++; res.sendStatus(204); }); });
  const call = (path: string, init: RequestInit) => fetch(`${h.url}${path}`, init);
  const cases: [string, string, RequestInit, number, string][] = [
    ['missing Prefer', '/bench/_preview/probe', { method: 'POST' }, 400, 'A Test Bench preview requires Prefer: tx=rollback.'],
    ['rollback outside the preview URL', '/probe', { method: 'POST', headers: { Prefer: 'tx=rollback' } }, 400, 'Use the Test Bench preview URL.'],
    ['cross-origin', '/bench/_preview/probe', { method: 'POST', headers: { ...rollback, Origin: 'http://evil.example' } }, 403, 'Preview is restricted to the application origin.'],
    ['cross-site fetch metadata', '/bench/_preview/probe', { method: 'POST', headers: { ...rollback, 'Sec-Fetch-Site': 'cross-site' } }, 403, 'Preview is restricted to the application origin.'],
    ['HEAD', '/bench/_preview/probe', { method: 'HEAD', headers: rollback }, 405, ''],
    ['self target', '/bench/_preview/bench/_api/capabilities', { method: 'POST', headers: rollback }, 400, 'The Test Bench preview target is invalid.'],
    ['empty target', '/bench/_preview', { method: 'POST', headers: rollback }, 400, 'The Test Bench preview target is invalid.'],
    ['non-GET discovery', '/bench/_api/capabilities', { method: 'POST' }, 405, 'Use GET for workbench discovery and assets.'],
  ];
  for (const [label, path, init, status, title] of cases) {
    const response = await call(path, init);
    assert.equal(response.status, status, label);
    if (title) assert.equal(((await response.json()) as Problem).title, title, label);
  }
  // fetch() normalises dot segments, so send this one with a raw request line.
  const dotted = await rawPost(h.url, '/bench/_preview/a/%2e%2e/probe');
  assert.equal(dotted, 400, 'encoded dot segments');
  assert.equal(ran, 0, 'no rejected request reached the handler');
  const ok = await call('/bench/_preview/probe', { method: 'POST', headers: rollback });
  assert.equal(ok.status, 200);
  assert.equal(ran, 1);
});

test('operation() rejects unsafe or duplicate registrations', async t => {
  const h = await start(t);
  const handler: RequestHandler = (_req, res) => { res.end(); };
  for (const template of ['items', '/items/*', '/items/:id', '/items/{id}/{', '/a/../b', '/bench', '/Bench/x', '/items//x', '/items?x', '/items/(.*)']) {
    assert.throws(() => h.bench.operation('POST', template, handler), TypeError, template);
  }
  assert.throws(() => h.bench.operation('TRACE', '/x', handler), TypeError);
  assert.throws(() => h.bench.operation('POST', '/x'), TypeError, 'a handler is required');
  assert.throws(() => h.bench.operation('post', '/items', handler), /already registered/, 'method case is normalised');
  assert.equal(h.bench.operation('delete', '/ok/{id}', handler), h.bench, 'registration is chainable');
});

test('a response that grows past maxResponseBytes ends the stream, returns 413 and stops the handler', async t => {
  let closed = false;
  let writes = 0;
  const h = await start(t, { maxResponseBytes: 64 }, '', bench => {
    bench.operation('GET', '/stream', (_req, res) => {
      res.on('close', () => { closed = true; });
      const timer = setInterval(() => {
        writes++;
        if (!res.write(Buffer.alloc(32)) || closed) clearInterval(timer);
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
  });
  const { response, body } = await preview(h, '/stream', { method: 'GET' });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('preference-applied'), null);
  assert.equal((body as Problem).title, 'The preview response exceeds the configured size limit.');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, true, 'the handler observes a closed response');
  assert(writes <= 4, `the adapter stopped buffering after the cap (${writes} writes)`);
});

test('a small streamed response is assembled whole, with a single oversized write also rejected', async t => {
  const h = await start(t, { maxResponseBytes: 64 }, '', bench => {
    bench.operation('GET', '/chunks', (_req, res) => {
      res.type('text/plain');
      res.write('hello ');
      res.write(Buffer.from('streamed '));
      res.end('world');
    });
    bench.operation('GET', '/huge', (_req, res) => { res.type('text/plain').send('x'.repeat(65)); });
  });
  const chunked = await preview(h, '/chunks', { method: 'GET' });
  assert.equal((chunked.body as PreviewResult).body, 'hello streamed world');
  assert.equal((await preview(h, '/huge', { method: 'GET' })).response.status, 413);
});

test('handler and provider failures return a safe 500 problem, roll back and report through onError', async t => {
  const h = await start(t);
  const { response, body } = await preview(h, '/items/boom/fail', { user: 'admin' });
  assert.equal(response.status, 500);
  assert.equal((body as Problem).title, 'The preview could not be completed safely.');
  assert.doesNotMatch(JSON.stringify(body), /exploded/, 'the error message does not leak');
  assert.match(String((h.errors[0] as Error).message), /handler exploded/, 'the host is told through onError');
  assert.equal(await exists(h.db, 'boom'), false);
  const sent = await fetch(`${h.url}/items/boom/fail`, { method: 'POST' });
  assert.equal(sent.status, 500, 'ordinary Send surfaces the failure through the application error handler');

  const thrown = await start(t, { previewProvider: { async preview() { throw new Error('provider down'); } } });
  const failed = await preview(thrown, '/items', { user: 'admin', body: { id: 'p', name: 'P' } });
  assert.equal(failed.response.status, 500);
  assert.equal((failed.body as Problem).title, 'The preview could not be completed safely.');
  assert.equal(thrown.errors.length, 1);
  assert.match(String((thrown.errors[0] as Error).message), /provider down/);
});

test('preview responses drop connection-scoped headers and cookies', async t => {
  const h = await start(t, {}, '', bench => {
    bench.operation('POST', '/headers', (_req, res) => {
      res.set({ 'Set-Cookie': 'sid=secret', Location: '/elsewhere', 'X-Visible': 'yes', Connection: 'X-Hop', 'X-Hop': 'dropped' });
      res.status(201).json({ ok: true });
    });
  });
  const { body } = await preview(h, '/headers');
  const { headers, status } = body as PreviewResult;
  assert.equal(status, 201);
  assert.equal(headers['x-visible'], 'yes');
  for (const name of ['set-cookie', 'location', 'connection', 'x-hop']) assert.equal(headers[name], undefined, name);
});

test('Send with Prefer: trace records an owner-bound trace that other subjects cannot read', async t => {
  const h = await start(t);
  const sent = await fetch(`${h.url}/items`, {
    method: 'POST', headers: { ...json, 'x-user': 'admin', Prefer: 'trace' }, body: JSON.stringify({ id: 'traced', name: 'T' }),
  });
  assert.equal(sent.status, 201);
  const id = sent.headers.get('x-testbench-trace');
  assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(await exists(h.db, 'traced'), true, 'observed Send is a normal, committed request');

  const trace = await fetch(`${h.url}/bench/_api/traces/${id}`, { headers: { 'x-user': 'admin' } });
  assert.equal(trace.status, 200);
  const recorded = await trace.json() as PreviewResult & { timing: unknown };
  assert.deepEqual(recorded.changes?.map(c => c.operation), ['insert']);
  assert.deepEqual(recorded.effects, [{ kind: 'email', description: 'Created item', delivered: true }]);
  assert.equal(typeof recorded.timing, 'object');

  assert.equal((await fetch(`${h.url}/bench/_api/traces/${id}`, { headers: { 'x-user': 'viewer' } })).status, 404);
  assert.equal((await fetch(`${h.url}/bench/_api/traces/${id}`)).status, 404, 'anonymous callers cannot read it');

  const untraced = await fetch(`${h.url}/items`, { method: 'POST', headers: { ...json, 'x-user': 'admin' }, body: JSON.stringify({ id: 'plain', name: 'P' }) });
  assert.equal(untraced.headers.get('x-testbench-trace'), null);
  const rejected = await fetch(`${h.url}/items`, { method: 'POST', headers: { ...json, 'x-user': 'viewer', Prefer: 'trace' }, body: JSON.stringify({ id: 'v', name: 'V' }) });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('x-testbench-trace'), null, 'failed authorization is never traced');
});

test('workbench assets are served with validators and the workbench is unavailable outside its environments', async t => {
  const h = await start(t);
  const index = await fetch(`${h.url}/bench/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  const cached = await fetch(`${h.url}/bench/`, { headers: { 'If-None-Match': index.headers.get('etag') ?? '' } });
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${h.url}/bench/%2e%2e/package.json`)).status, 404);

  const production = await start(t, { environment: 'production' });
  assert.equal((await fetch(`${production.url}/bench/_api/capabilities`)).status, 404);
  assert.equal((await fetch(`${production.url}/openapi.json`)).status, 200, 'application routes are unaffected');
  const sent = await fetch(`${production.url}/items`, { method: 'POST', headers: { ...json, 'x-user': 'admin', Prefer: 'trace' }, body: JSON.stringify({ id: 'p', name: 'P' }) });
  assert.equal(sent.headers.get('x-testbench-trace'), null, 'no tracing when disabled');
});


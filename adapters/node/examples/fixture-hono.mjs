import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { sendproof } from '@sendproof/hono';
import { authProviders, createFixture } from './fixture-service.mjs';

const scenario = process.env.BENCH_SCENARIO ?? 'standard';
const base = process.env.BENCH_PATH_BASE ?? '';
const port = Number(process.env.PORT ?? 5351);
const spec = JSON.parse(await readFile(new URL('./fixture-openapi.json', import.meta.url)));
const { session, previewProvider, operations, ordinary } = createFixture(':memory:', scenario);

export const app = new Hono();
const router = new Hono();
const bench = sendproof({
  basePath: base,
  apiName: 'Sendproof Conformance',
  environment: scenario === 'disabled' ? 'production' : 'development',
  database: 'SQLite', authProviders, previewProvider, traceTtlMs: 5000,
  resolveIdentity: ({ headers }) => session(headers.cookie),
});

function wrap(handler) {
  return async c => {
    let body;
    if (c.req.header('content-type')?.includes('application/json')) body = await c.req.json();
    const response = await handler({
      base, params: c.req.param(), body, query: new URL(c.req.url).searchParams,
      identity: session(c.req.header('cookie')),
    });
    const headers = new Headers(response.headers);
    if (response.body === null) return new Response(null, { status: response.status, headers });
    if (typeof response.body === 'string') return new Response(response.body, { status: response.status, headers });
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(response.body), { status: response.status, headers });
  };
}

for (const { method, path, handler } of operations) bench.operation(method, path, wrap(handler));
router.route('/', bench);
for (const { method, path, handler } of ordinary) {
  router[method.toLowerCase()](path.replace(/\{(.*?)\}/g, ':$1'), wrap(handler));
}
router.get('/ready', c => c.text('ready'));
router.get('/openapi.json', c => c.json(spec));
app.route(base || '/', router);
app.onError(() => new Response(JSON.stringify({ message: 'Fixture request failed' }), {
  status: 500, headers: { 'Content-Type': 'application/json' },
}));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
}

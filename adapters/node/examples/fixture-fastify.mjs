import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { sendproof } from '@sendproof/fastify';
import { authProviders, createFixture } from './fixture-service.mjs';

const scenario = process.env.BENCH_SCENARIO ?? 'standard';
const base = process.env.BENCH_PATH_BASE ?? '';
const port = Number(process.env.PORT ?? 5353);
const spec = JSON.parse(await readFile(new URL('./fixture-openapi.json', import.meta.url)));
const { session, previewProvider, operations, ordinary } = createFixture(':memory:', scenario);
const app = Fastify();

await app.register(async scope => {
  await scope.register(sendproof, {
    apiName: 'Sendproof Conformance',
    environment: scenario === 'disabled' ? 'production' : 'development',
    database: 'SQLite', authProviders, previewProvider, traceTtlMs: 5000,
    resolveIdentity: ({ headers }) => session(headers.cookie),
  });
  for (const { method, path, handler } of operations) scope.sendproof.operation(method, path, wrap(handler));
  for (const { method, path, handler } of ordinary) {
    scope.route({ method, url: path.replace(/\{(.*?)\}/g, ':$1'), handler: wrap(handler) });
  }
  scope.get('/ready', async () => 'ready');
  scope.get('/openapi.json', async () => spec);
}, { prefix: base });

function wrap(handler) {
  return async (request, reply) => {
    const response = await handler({
      base, params: request.params, body: request.body,
      query: new URLSearchParams(request.raw.url.split('?')[1] ?? ''),
      identity: session(request.headers.cookie),
    });
    reply.code(response.status).headers(response.headers);
    return response.body === null ? reply.send() : reply.send(response.body);
  };
}

await app.listen({ port, host: '127.0.0.1' });

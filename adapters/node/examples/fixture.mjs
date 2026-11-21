import { readFile } from 'node:fs/promises';
import express from 'express';
import { sendproof } from '@sendproof/express';
import { authProviders, createFixture } from './fixture-service.mjs';

const scenario = process.env.BENCH_SCENARIO ?? 'standard';
const base = process.env.BENCH_PATH_BASE ?? '';
const port = Number(process.env.PORT ?? 5351);
const database = {
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
}[process.env.BENCH_DATABASE ?? 'sqlite'];
if (!database) throw new Error('Unknown fixture database');
const spec = JSON.parse(await readFile(new URL('./fixture-openapi.json', import.meta.url)));

const stores = {
  express: () => undefined,
  drizzle: async () => (await import('./fixture-drizzle.mjs')).createDrizzleStore(),
  knex: async () => (await import('./fixture-knex.mjs')).createKnexStore(),
  typeorm: async () => (await import('./fixture-typeorm.mjs')).createTypeOrmStore(),
  prisma: async () => (await import('./fixture-prisma.mjs')).createPrismaStore(),
};
const profile = process.argv[2] ?? 'express';
if (!Object.hasOwn(stores, profile)) throw new Error('Unknown fixture store');
const store = await stores[profile]();
const { session, previewProvider, operations, ordinary } = createFixture(':memory:', scenario, store);
const options = {
  apiName: 'Sendproof Conformance',
  environment: scenario === 'disabled' ? 'production' : 'development',
  database,
  authProviders,
  previewProvider,
  traceTtlMs: 5000,
};

function registerExpress() {
  const app = express();
  const router = express.Router();
  router.use(express.json());
  const bench = sendproof({ ...options, resolveIdentity: ({ headers }) => session(headers.cookie) });
  router.use(bench);
  for (const { method, path, handler } of operations) bench.operation(method, path, wrap(handler));
  for (const { method, path, handler } of ordinary) {
    router[method.toLowerCase()](path.replace(/\{(.*?)\}/g, ':$1'), wrap(handler));
  }
  router.get('/ready', (_req, res) => res.sendStatus(200));
  router.get('/openapi.json', (_req, res) => res.json(spec));
  app.use(base || '/', router);
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 500).json({ message: 'Fixture request failed' });
  });
  app.listen(port, '127.0.0.1');
}

function wrap(handler) {
  return async (req, res) => {
    const response = await handler({
      base, params: req.params, body: req.body,
      query: new URLSearchParams(req.url.split('?')[1] ?? ''),
      identity: session(req.headers.cookie),
    });
    res.status(response.status).set(response.headers);
    if (response.body === null) return res.end();
    if (typeof response.body === 'string') return res.send(response.body);
    return res.json(response.body);
  };
}

registerExpress();

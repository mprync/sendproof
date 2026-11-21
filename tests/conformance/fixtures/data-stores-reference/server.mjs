/**
 * Data-store reference fixture: a tiny, dependency-free HTTP app that implements the data-store
 * routes and shared security rules of spec/conformance/fixture.md, so the shared checks in
 * tests/conformance/data-stores.mjs can be proven against real MongoDB, Redis and DynamoDB.
 *
 * It is not a binding. It implements only the slice of the protocol those checks use: cookie
 * sign-in, discovery, Preview, observed Send and trace reads. SQL uses node:sqlite.
 * `BENCH_REFERENCE_GUARD=off` disables the write guard, for the negative self-test.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  captureScope, guardSql, looksSecret, record, redacted, redactDeep, storeNames, withScope,
} from './guard.mjs';
import { hookedDynamo, hookedMongo, hookedRedis, token } from './hooks.mjs';

const base = process.env.BENCH_PATH_BASE ?? '';
const port = Number(process.env.PORT);

// ---- SQL: one SQLite connection; Preview wraps each request in BEGIN … ROLLBACK. ----

const sql = new DatabaseSync(join(process.env.BENCH_TMP_DIR, 'reference.db'));
sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
sql.exec('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)');

/** Runs one statement through the provider: transaction-control guard, then a redacted "Sql" log entry. */
function execute(text, parameters = {}) {
  guardSql(text);
  const statement = sql.prepare(text);
  const result = /^\s*select/i.test(text) ? statement.all(parameters) : statement.run(parameters);
  const hide = looksSecret(text);
  record({
    level: 'Sql', message: 'Executed SQL',
    sql: {
      text,
      parameters: Object.entries(parameters).map(([name, value]) =>
        ({ name, value: hide || looksSecret(name) ? redacted : value === null ? null : String(value), dbType: 'TEXT' })),
      ...(Array.isArray(result) ? {} : { rowsAffected: Number(result.changes) }),
    },
  });
  return result;
}

/** Inserts a row and records an insert change with secret columns redacted. */
function insertRow(table, row) {
  const columns = Object.keys(row);
  execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(name => ':' + name).join(', ')})`, row);
  captureScope()?.changes.push({ operation: 'insert', table, key: { id: row.id }, before: null, after: redactDeep({ ...row }) });
}

// ---- Data stores, hooked once at startup. Each is optional: unset variables mean "not configured". ----

const stores = {};
if (process.env.BENCH_MONGODB_URL) stores.mongodb = await hookedMongo(process.env.BENCH_MONGODB_URL);
if (process.env.BENCH_REDIS_URL) stores.redis = await hookedRedis(process.env.BENCH_REDIS_URL);
if (process.env.BENCH_DYNAMODB_URL) {
  stores.dynamodb = hookedDynamo({
    endpoint: process.env.BENCH_DYNAMODB_URL, region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
}
const prefix = process.env.BENCH_REDIS_PREFIX ?? '';
const ordersTable = process.env.BENCH_DYNAMODB_TABLE;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (status, body) => ({ status, body });
const need = store => { if (!stores[store]) throw new HttpError(503, `${store} is not configured`); return stores[store]; };
const text = value => (typeof value === 'string' && value.length ? value : (() => { throw new HttpError(400, 'Invalid input'); })());

// ---- Routes. `preview: true` enables Preview; `preview: false` is the hand-set mark with a reason. ----

const counterKey = key => `${prefix}counter:${key}`;
const documentOf = document => ({ id: document._id, name: document.name, city: document.profile?.city ?? null });
const orderOf = item => ({ id: item.id.S, status: item.status?.S ?? null, hits: Number(item.hits?.N ?? 0) });
const touch = id => need('dynamodb').call('UpdateItem', {
  TableName: ordersTable, Key: { id: { S: id } },
  UpdateExpression: 'ADD hits :one SET #s = if_not_exists(#s, :new)',
  ExpressionAttributeNames: { '#s': 'status' },
  ExpressionAttributeValues: { ':one': { N: '1' }, ':new': { S: 'new' } },
  ReturnValues: 'ALL_NEW',
});

const routes = [
  // Shared security rules.
  { method: 'POST', path: '/accounts', preview: true, run({ body }) {
    insertRow('accounts', { id: text(body.id), email: text(body.email), password_hash: 'hashed:' + text(body.password) });
    return json(201, { id: body.id, email: body.email });
  } },
  { method: 'GET', path: '/accounts/{id}', run({ params }) {
    const [row] = execute('SELECT id, email FROM accounts WHERE id = :id', { id: params.id });
    return row ? json(200, { ...row }) : json(404, { error: 'Not found' });
  } },
  { method: 'GET', path: '/items/{id}', run({ params }) {
    const [row] = execute('SELECT id, name FROM items WHERE id = :id', { id: params.id });
    return row ? json(200, { ...row }) : json(404, { error: 'Not found' });
  } },
  { method: 'POST', path: '/items/{id}/commit', preview: true, run({ params, body }) {
    insertRow('items', { id: params.id, name: text(body.name) });
    execute('COMMIT');
    return json(201, { id: params.id, name: body.name });
  } },

  // Mixed SQL and a guarded store.
  { method: 'POST', path: '/items/{id}/remember', preview: true, async run({ params, body, query }) {
    insertRow('items', { id: params.id, name: text(body.name) });
    const store = query.get('store');
    if (store === 'redis') await need('redis').send('INCR', counterKey('item-' + params.id));
    else if (store === 'dynamodb') await touch('item-' + params.id);
    else throw new HttpError(400, 'Unknown store');
    return json(201, { id: params.id, name: body.name });
  } },

  // MongoDB.
  { method: 'GET', path: '/documents/{id}', preview: true, async run({ params }) {
    const reply = await need('mongodb').command({ find: 'documents', filter: { _id: params.id }, limit: 1 });
    const [document] = reply.cursor.firstBatch;
    return document ? json(200, documentOf(document)) : json(404, { error: 'Not found' });
  } },
  { method: 'POST', path: '/documents', preview: true, async run({ body, log }) {
    const document = { _id: text(body.id), name: text(body.name), profile: { city: text(body.city) }, password_hash: 'hashed:' + text(body.password) };
    await need('mongodb').command({ insert: 'documents', documents: [document] });
    log('created-document:' + body.id);
    return json(201, documentOf(document));
  } },
  { method: 'PATCH', path: '/documents/{id}', preview: true, async run({ params, body }) {
    const set = {};
    if (body.name !== undefined) set.name = text(body.name);
    if (body.city !== undefined) set['profile.city'] = text(body.city);
    const mongo = need('mongodb');
    const result = await mongo.command({ update: 'documents', updates: [{ q: { _id: params.id }, u: { $set: set } }] });
    if (!result.n) return json(404, { error: 'Not found' });
    const [document] = (await mongo.command({ find: 'documents', filter: { _id: params.id }, limit: 1 })).cursor.firstBatch;
    return json(200, documentOf(document));
  } },
  { method: 'POST', path: '/documents/archive', preview: true, async run() {
    await need('mongodb').command({ aggregate: 'documents', pipeline: [{ $match: {} }, { $out: 'documents_archive' }], cursor: {} });
    return { status: 204 };
  } },
  { method: 'DELETE', path: '/documents/{id}', preview: false, stores: ['mongodb'], async run({ params }) {
    await need('mongodb').command({ delete: 'documents', deletes: [{ q: { _id: params.id }, limit: 1 }] });
    return { status: 204 };
  } },

  // Redis.
  { method: 'GET', path: '/counters/{key}', preview: true, async run({ params }) {
    const value = await need('redis').send('GET', counterKey(params.key));
    return value === null ? json(404, { error: 'Not found' }) : json(200, { key: params.key, value: Number(value) });
  } },
  { method: 'POST', path: '/counters/{key}', preview: true, async run({ params }) {
    return json(200, { key: params.key, value: await need('redis').send('INCR', counterKey(params.key)) });
  } },
  { method: 'POST', path: '/counters/{key}/take', preview: true, async run({ params }) {
    // This handler swallows store errors on purpose: the blocked mark, not the response, decides a Preview.
    let value = null;
    try { value = await need('redis').send('GETDEL', counterKey(params.key)); } catch { /* reported as not found */ }
    return value === null ? json(404, { error: 'Not found' }) : json(200, { key: params.key, value: Number(value) });
  } },
  { method: 'DELETE', path: '/counters/{key}', preview: false, stores: ['redis'], async run({ params }) {
    await need('redis').send('DEL', counterKey(params.key));
    return { status: 204 };
  } },

  // DynamoDB.
  { method: 'GET', path: '/orders/{id}', preview: true, async run({ params }) {
    const reply = await need('dynamodb').call('GetItem', { TableName: ordersTable, Key: { id: { S: params.id } }, ConsistentRead: true });
    return reply.Item ? json(200, orderOf(reply.Item)) : json(404, { error: 'Not found' });
  } },
  { method: 'POST', path: '/orders/{id}/touch', preview: true, async run({ params }) {
    return json(200, orderOf((await touch(params.id)).Attributes));
  } },
  { method: 'POST', path: '/orders/{id}/cancel', preview: true, async run({ params }) {
    await need('dynamodb').call('ExecuteStatement', {
      Statement: `UPDATE "${ordersTable}" SET status = 'cancelled' WHERE id = ?`, Parameters: [{ S: params.id }],
    });
    return json(200, { id: params.id, status: 'cancelled' });
  } },
  { method: 'DELETE', path: '/orders/{id}', preview: false, stores: ['dynamodb'], async run({ params }) {
    await need('dynamodb').call('DeleteItem', { TableName: ordersTable, Key: { id: { S: params.id } } });
    return { status: 204 };
  } },
].map(route => ({
  ...route,
  pattern: new RegExp('^' + route.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$'),
  reason: route.preview === false ? `Preview unavailable: this operation writes to ${storeNames[route.stores[0]]}` : undefined,
}));

/** Finds the route for a method and path. Routes with fixed segments win over parameters. */
function match(method, path) {
  const candidates = routes.filter(route => route.method === method && route.pattern.test(path));
  const route = candidates.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0))[0];
  if (!route) return undefined;
  const params = Object.fromEntries(Object.entries(route.pattern.exec(path).groups ?? {}).map(([name, value]) => [name, decodeURIComponent(value)]));
  return { route, params };
}

// ---- Authentication: one admin, cookie sessions. ----

const sessions = new Map();
const admin = { sub: 'fixture-admin', name: 'Fixture Admin', role: 'admin' };
function identity(request) {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)tb_reference=([^;]+)/)?.[1];
  return cookie ? sessions.get(cookie) : undefined;
}

// ---- Protocol: discovery, Preview, observed Send and traces. ----

const traces = new Map();
const traceTtlMs = 5000;

function capabilities(user) {
  return {
    protocolVersion: 1,
    apiName: 'Sendproof Conformance',
    environment: 'Development',
    openApiUrl: base + '/openapi.json',
    documents: [{ name: 'Sendproof Conformance', url: base + '/openapi.json' }],
    database: 'reference',
    identity: user ? { name: user.name, role: user.role } : null,
    authProviders: [{ label: 'Fixture sign-in', kind: 'cookie', url: base + '/auth/sign-in' }],
    observedSend: true,
    dataStores: Object.entries(stores).map(([system, store]) => ({
      system, mode: store.mode ?? 'guard',
      ...(system === 'mongodb' && store.mode === 'guard' ? { reason: "Preview unavailable: this MongoDB server doesn't support transactions" } : {}),
    })),
    previewOperations: routes.filter(route => route.preview === true).map(({ method, path }) => ({ method, path })),
    previewUnavailable: routes.filter(route => route.preview === false && route.stores.every(store => stores[store]))
      .map(({ method, path, reason, stores: names }) => ({ method, path, reason, stores: names })),
  };
}

/** Runs a route handler and shapes its result. Thrown HttpErrors become their status; anything else propagates. */
async function invoke(route, context) {
  try {
    return await route.run(context);
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }
}

/**
 * The Preview pipeline: begin, run the handler, capture, roll back, then decide. Order matters:
 * a failed rollback outranks everything, then a transaction-control fault, then a blocked write.
 */
async function preview(route, context) {
  return withScope({ preview: true }, async scope => {
    sql.exec('BEGIN');
    let result;
    let failure;
    try { result = await invoke(route, context); } catch (error) { failure = error; }
    let rolledBack = true;
    try { await stores.mongodb?.finishPreview(scope); } catch { rolledBack = false; }
    try { sql.exec('ROLLBACK'); } catch { rolledBack = false; }
    if (!rolledBack || scope.fault) return json(500, { error: 'Preview could not be confirmed' });
    if (scope.blocked) {
      return {
        status: 409, type: 'application/problem+json',
        body: {
          type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable',
          detail: scope.blocked.detail, store: scope.blocked.store, operation: scope.blocked.operation, rolledBack: false,
        },
      };
    }
    if (failure) return json(500, { error: 'Preview could not be confirmed' });
    return {
      status: 200, headers: { 'Preference-Applied': 'tx=rollback' },
      body: {
        status: result.status,
        headers: result.body === undefined ? {} : { 'content-type': 'application/json' },
        body: result.body ?? null,
        changes: scope.changes, effects: [], logs: scope.logs,
        ...(scope.changesTruncated ? { changesTruncated: true } : {}),
        rolledBack: true,
      },
    };
  });
}

/** Observed Send: the ordinary request plus a capture, stored as an owner-only trace. */
async function observed(route, context, user) {
  return withScope({ preview: false }, async scope => {
    const result = await invoke(route, context);
    const id = token();
    const elapsed = performance.now() - scope.start;
    traces.set(id, {
      owner: user.sub, expires: Date.now() + traceTtlMs,
      trace: {
        changes: scope.changes, effects: [], logs: scope.logs,
        timing: { auth: 0, handler: elapsed, db: 0, queryCount: scope.logs.length, serialize: 0 },
      },
    });
    return { ...result, headers: { ...result.headers, 'X-Sendproof-Trace': id } };
  });
}

async function handle(request, url, body) {
  if (!url.pathname.startsWith(base + '/')) return json(404, { error: 'Not found' });
  const path = url.pathname.slice(base.length);
  const user = identity(request);
  if (path === '/ready') return json(200, { ready: true });
  if (path === '/openapi.json') return json(200, { openapi: '3.1.0', info: { title: 'Sendproof Conformance', version: '1' }, paths: {} });
  if (path === '/sendproof/_api/capabilities') return { ...json(200, capabilities(user)), headers: { 'Cache-Control': 'no-store' } };
  if (path === '/auth/sign-in' && request.method === 'POST') {
    if (body?.email !== 'admin@example.test' || body?.password !== 'bench-fixture') return json(401, { error: 'Invalid credentials' });
    const session = token();
    sessions.set(session, admin);
    return { status: 204, headers: { 'Set-Cookie': `tb_reference=${session}; Path=/; HttpOnly; SameSite=Lax` } };
  }
  const trace = path.match(/^\/sendproof\/_api\/traces\/([^/]+)$/);
  if (trace) {
    const entry = traces.get(decodeURIComponent(trace[1]));
    if (!user || !entry || entry.owner !== user.sub || entry.expires < Date.now()) return json(404, { error: 'Not found' });
    return { ...json(200, entry.trace), headers: { 'Cache-Control': 'no-store' } };
  }

  const isPreview = path.startsWith('/sendproof/_preview/');
  const target = isPreview ? path.slice('/sendproof/_preview'.length) : path;
  const found = match(request.method, target);
  if (isPreview && !/(^|[,;]\s*)tx=rollback\s*($|,)/.test(request.headers.prefer ?? '')) return json(400, { error: 'Prefer: tx=rollback is required' });
  if (!found || (isPreview && found.route.preview !== true)) return json(404, { error: 'Not found' });
  if (!user) return json(401, { error: 'Sign in first' });
  const logs = message => captureScope()?.logs.push({ level: 'Information', message });
  const context = { params: found.params, query: url.searchParams, body: body ?? {}, log: logs };
  if (isPreview) return preview(found.route, context);
  if (found.route.preview === true && /\btrace\b/.test(request.headers.prefer ?? '')) return observed(found.route, context, user);
  return invoke(found.route, context);
}

// One request at a time: the fixture shares a single SQLite connection, and a Preview's BEGIN must
// never wrap another request's statements.
let queue = Promise.resolve();
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    queue = queue.then(async () => {
      let result;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        result = await handle(request, new URL(request.url, 'http://fixture.invalid'), body);
      } catch (error) {
        console.error(error);
        result = json(500, { error: 'Internal error' });
      }
      const headers = { ...result.headers };
      if (result.body !== undefined) headers['Content-Type'] = result.type ?? 'application/json';
      if (result.status === 409 && result.type) headers['Cache-Control'] = 'no-store';
      if (headers['Preference-Applied']) headers['Cache-Control'] = 'no-store';
      response.writeHead(result.status, headers);
      response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    });
  });
});

server.listen(port, '127.0.0.1');
const stop = async () => {
  server.close();
  await Promise.allSettled(Object.values(stores).map(store => store.close?.()));
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

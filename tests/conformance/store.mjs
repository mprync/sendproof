import assert from 'node:assert/strict';
import { withSession } from './sessions.mjs';

/**
 * Conformance profile for the Acme Store example (`examples/StoreApi`).
 *
 * The standard fixture contract does not apply to the store: it has its own routes, seeded users and many
 * preview-enabled operations (this profile exercises `POST /api/v2/orders`). It checks the same protocol
 * guarantees on those routes: discovery, authorization, rollback with independent database reads, observed Send
 * and trace ownership. It runs against a fixture launched at the root path, in the Development environment, with
 * a new database. The database is seeded with a realistic data set, so order counts are compared with the count
 * found at the start rather than with zero.
 *
 * @param {import('node:test').TestContext} t Test context that owns the subtests.
 * @param {(path: string, options?: {method?: string, body?: object, cookie?: string, headers?: Record<string, string>}) => Promise<Response>} request
 *   Sends a request to the running fixture. `cookie` is the first `Set-Cookie` segment from a sign-in.
 * @param {{assert(kind: 'capabilities' | 'preview' | 'trace', payload: unknown): void}} schemas Protocol schema validator.
 */
export async function runStore(t, request, schemas, storeDatabase) {
  const ordersPath = '/api/v2/orders';
  const previewPath = '/sendproof/_preview' + ordersPath;
  const rollback = { Prefer: 'tx=rollback' };
  const miaId = 'c0a10000-0000-4000-8000-000000000001';
  const jacketSku = 'NPK-JKT-BLK-M';
  const startingStock = 40;
  let admin;
  let previewSessions = false;
  /** The number of seeded orders, read before any test writes. */
  let baseline;

  const status = async (response, expected) => {
    const allowed = [expected].flat();
    if (!allowed.includes(response.status)) {
      assert.fail(`Expected HTTP ${allowed.join(' or ')}, got ${response.status} from ${response.url}\n${(await response.text()).slice(0, 1000)}`);
    }
    return response;
  };
  const cookieOf = response => {
    const value = response.headers.get('set-cookie')?.split(';')[0];
    assert(value, 'Expected a session cookie');
    return value;
  };
  const order = overrides => ({
    customerId: miaId,
    items: [{ sku: jacketSku, quantity: 1 }],
    currency: 'EUR',
    shippingAddress: { recipient: 'Mia Customer', line1: '14 Harcourt Street', city: 'Dublin', region: 'Co. Dublin', postalCode: 'D02 X285', country: 'IE' },
    shippingSpeed: 'Express',
    payment: { type: 'Card', token: 'tok_visa_4242', brand: 'Visa', holderName: 'Mia Customer' },
    ...overrides,
  });
  const preview = (body, cookie) => request(previewPath, { method: 'POST', cookie, body, headers: rollback });

  /** Reads the confirmed envelope, checking the outer transport and the schema. */
  async function confirmed(response) {
    await status(response, 200);
    assert.equal(response.headers.get('preference-applied'), 'tx=rollback');
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    assert.equal(response.headers.get('set-cookie'), null);
    const result = await response.json();
    schemas.assert('preview', result);
    assert.equal(result.rolledBack, true);
    return result;
  }

  /** Reads durable state through ordinary API requests, independent of the preview transaction. */
  async function database(cookie) {
    const orders = await (await status(await request(ordersPath + '?pageSize=1', { cookie }), 200)).json();
    const stock = await (await status(await request('/api/v2/stock/' + jacketSku, { cookie }), 200)).json();
    return { orders: orders.totalItems, available: stock.available };
  }
  /** Checks that `added` orders exist beyond the seeded ones and that the jacket has the given units available. */
  const assertDatabase = async (cookie, added, available) => {
    const state = await database(cookie);
    assert.equal(state.orders, baseline + added, 'Persisted orders');
    assert.equal(state.available, available, 'Jacket units available');
  };

  await t.test('Discovery, OpenAPI extensions and embedded UI are public', async () => {
    const response = await status(await request('/sendproof/_api/capabilities'), 200);
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    const capabilities = await response.json();
    schemas.assert('capabilities', capabilities);
    previewSessions = capabilities.previewSessions === true;
    assert.equal(capabilities.identity, null);
    assert.equal(capabilities.observedSend, true);
    assert(capabilities.authProviders.some(provider => provider.kind === 'cookie' && provider.url === '/auth/login'));
    assert(capabilities.authProviders.some(provider => provider.kind === 'personas' && provider.url === '/auth/personas'));
    assert(capabilities.previewOperations.some(operation => operation.method === 'POST' && operation.path === ordersPath));

    const spec = await (await status(await request(capabilities.openApiUrl), 200)).json();
    assert.match(spec.openapi, /^3\./);
    const schema = spec.components.schemas.PlaceOrderRequest;
    assert(schema.required.includes('customerId') && schema.required.includes('payment'));
    assert(!schema.required.includes('couponCode'));
    assert.equal(schema.properties.customerId.title, 'Customer');
    assert.equal(schema.properties.shippingSpeed['x-sendproof-visible'], true);
    assert(schema.examples?.length > 0, 'Operation example');
    assert(JSON.stringify(spec).includes('x-lookup') && JSON.stringify(spec).includes('x-currency-field'));

    const index = await status(await request('/sendproof/'), 200);
    assert.match(await index.text(), /app\.js/);
    await status(await request('/sendproof/styles.css'), 200);
    await status(await request('/sendproof/package.json'), 404);
  });

  await t.test('Public reads work anonymously; Preview and Send require a signed-in, authorized user', async () => {
    await status(await request('/api/v2/products'), 200);
    await status(await request(ordersPath), 401);
    await status(await preview(order()), 401);
    await status(await request('/auth/login', { method: 'POST', body: { email: 'ada.admin@acme.dev', password: 'wrong' } }), 401);
    const login = await status(await request('/auth/login', { method: 'POST', body: { email: 'ada.admin@acme.dev', password: 'Demo123!' } }), 200);
    admin = cookieOf(login);
    const capabilities = await (await status(await request('/sendproof/_api/capabilities', { cookie: admin }), 200)).json();
    assert.equal(capabilities.identity.name, 'Ada Admin');
    assert.equal(capabilities.identity.role, 'admin');
    baseline = (await database(admin)).orders;
    assert(baseline >= 140, 'The database is seeded with a realistic number of orders');
    await assertDatabase(admin, 0, startingStock);
  });

  await t.test('Preview rolls back the order, its lines, the payment and the stock decrement', async () => {
    assert(admin);
    const spec = await (await status(await request('/openapi/v1.json'), 200)).json();
    const example = await confirmed(await preview(spec.components.schemas.PlaceOrderRequest.examples[0], admin));
    assert.equal(example.status, 201);
    await assertDatabase(admin, 0, startingStock);

    const body = order();
    const response = await preview(body, admin);
    assert.match(response.headers.get('server-timing') ?? '', /db;dur=/);
    const result = await confirmed(response);
    assert.equal(result.status, 201);
    assert.equal(result.body.status, 'Paid');
    assert.equal(result.body.lines[0].quantity, 1);
    const tables = result.changes.map(change => `${change.operation}:${change.table}`);
    for (const expected of ['insert:Orders', 'insert:OrderLines', 'insert:Payments', 'insert:StockMovements', 'insert:AuditEvents']) {
      assert(tables.includes(expected), `${expected} is captured`);
    }
    const stockChange = result.changes.find(change => change.operation === 'update' && change.table === 'Stock');
    assert.equal(stockChange?.before.OnHand, startingStock);
    assert.equal(stockChange?.after.OnHand, startingStock - 1);
    // Four side effects are held: the confirmation email, the fulfilment webhook, the pick-list job and a published message.
    assert.deepEqual(result.effects.map(effect => effect.kind).sort(), ['email', 'http', 'job', 'message']);
    const email = result.effects.find(effect => effect.kind === 'email');
    assert(result.effects.every(effect => effect.delivered !== true), 'Preview suppresses delivery');
    assert.equal(email.data.to[0], 'mia.customer@acme.dev');
    assert(result.logs.some(log => log.level === 'Sql'), 'SQL is captured');
    assert(!JSON.stringify(result.logs).includes('Demo123!'), 'Credentials are never captured');
    await assertDatabase(admin, 0, startingStock);
  });

  await t.test('Validation failures stay inside the application response', async () => {
    assert(admin);
    await status(await request(ordersPath, { method: 'POST', cookie: admin, body: order({ items: [{ sku: jacketSku, quantity: 0 }] }) }), 400);
    const invalid = await confirmed(await preview(order({ items: [{ sku: jacketSku, quantity: 0 }] }), admin));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.changes, []);
    await assertDatabase(admin, 0, startingStock);
  });

  await t.test('Store session shares, rewinds and rolls back order changes', { skip: !previewSessions }, async () => {
    assert(admin);
    assert.equal(typeof storeDatabase?.query, 'function', 'An independent SQLite reader is required');
    const warehouse = cookieOf(await status(await request('/auth/personas/wes.warehouse%40acme.dev', { method: 'POST', cookie: admin }), 200));
    // Count every table touched by place and cancel, and retain the exact stock row. This reader is separate
    // from the API and is used only outside the held transaction, avoiding SQLite lock-dependent reads.
    const snapshot = async () => ({
      counts: await storeDatabase.query(`SELECT (SELECT COUNT(*) FROM Orders) AS orders,
        (SELECT COUNT(*) FROM OrderLines) AS lines, (SELECT COUNT(*) FROM Payments) AS payments,
        (SELECT COUNT(*) FROM Refunds) AS refunds, (SELECT COUNT(*) FROM Reservations) AS reservations,
        (SELECT COUNT(*) FROM StockMovements) AS movements, (SELECT COUNT(*) FROM AuditEvents) AS audits`),
      stock: await storeDatabase.query(`SELECT s.OnHand, s.Reserved FROM Stock s JOIN Variants v ON v.Id = s.VariantId WHERE v.Sku = 'NPK-JKT-BLK-M'`),
    });
    const before = await snapshot();
    assert.equal(before.stock.length, 1);
    let placedId;
    await withSession(request, schemas, { cookie: admin }, async ({ id, step, rewind, end, resource }) => {
      const foreign = await status(await request(resource, { method: 'DELETE', cookie: warehouse }), 404);
      assert.equal((await foreign.json()).code, 'session_not_found');
      const busy = await status(await request('/sendproof/_api/sessions', { method: 'POST', cookie: admin }), 409);
      assert.equal((await busy.json()).code, 'store_busy');

      const placed = await step(ordersPath, { method: 'POST', body: order() }, 1);
      assert.equal(placed.status, 201);
      assert.equal(placed.body.status, 'Paid');
      placedId = placed.body.id;
      assert(placedId);
      assert(placed.changes.some(change => change.table === 'Orders' && change.operation === 'insert'));
      assert(placed.effects.every(effect => effect.delivered !== true));
      const read = await step(`${ordersPath}/${placedId}`, { method: 'GET' }, 2);
      assert.equal(read.status, 200);
      assert.equal(read.body.id, placedId);
      assert.equal(read.body.status, 'Paid');
      assert.deepEqual(read.changes, []);
      const cancelled = await step(`${ordersPath}/${placedId}/cancel`, { method: 'POST', body: { reason: 'Session conformance' } }, 3);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'Cancelled');
      assert(cancelled.changes.some(change => change.table === 'Orders' && change.operation === 'update'));
      const cancelledRead = await step(`${ordersPath}/${placedId}`, { method: 'GET' }, 4);
      assert.equal(cancelledRead.body.status, 'Cancelled');
      await rewind(3);
      const restored = await step(`${ordersPath}/${placedId}`, { method: 'GET' }, 3);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.status, 'Paid');
      await rewind(1);
      const absent = await step(`${ordersPath}/${placedId}`, { method: 'GET' }, 1);
      assert.equal(absent.status, 404);
      const retained = await step(ordersPath, { method: 'POST', body: order() }, 2);
      assert.equal(retained.status, 201);
      placedId = retained.body.id;
      await end();
      const ended = await status(await request(resource, { method: 'DELETE', cookie: admin }), 404);
      assert.equal((await ended.json()).code, 'session_not_found');
      assert.equal(id.length > 0, true);
    });
    assert.deepEqual(await snapshot(), before, 'Ending the session restores every affected SQL table and stock');
    await status(await request(`${ordersPath}/${placedId}`, { cookie: admin }), 404);
    await assertDatabase(admin, 0, startingStock);
  });

  let traceId;
  await t.test('Observed Send commits once, traces its work and replays idempotently', async () => {
    assert(admin);
    const body = order();
    const send = headers => request(ordersPath, { method: 'POST', cookie: admin, body, headers });
    const sent = await status(await send({ 'Idempotency-Key': 'conformance-order-1', Prefer: 'trace' }), 201);
    assert.match(sent.headers.get('server-timing') ?? '', /db;dur=/);
    assert(sent.headers.get('location'), 'The application Location is preserved on Send');
    traceId = sent.headers.get('x-sendproof-trace');
    assert(traceId, 'Observed Send returns a trace ID');
    const trace = await (await status(await request('/sendproof/_api/traces/' + encodeURIComponent(traceId), { cookie: admin }), 200)).json();
    schemas.assert('trace', trace);
    assert(trace.changes.some(change => change.operation === 'insert' && change.table === 'Orders'));
    assert.equal(trace.effects.length, 4);
    assert(trace.effects.every(effect => effect.delivered === true));
    const sql = trace.logs.filter(log => log.level === 'Sql').length;
    assert(sql > 0);
    assert.equal(trace.timing.queryCount, sql);
    await assertDatabase(admin, 1, startingStock - 1);

    await status(await send({ 'Idempotency-Key': 'conformance-order-1' }), 200);
    await assertDatabase(admin, 1, startingStock - 1);
    const different = order({ items: [{ sku: jacketSku, quantity: 2 }] });
    await status(await request(ordersPath, {
      method: 'POST', cookie: admin, body: different, headers: { 'Idempotency-Key': 'conformance-order-1' },
    }), 409);
    await assertDatabase(admin, 1, startingStock - 1);
  });

  await t.test('A warehouse persona cannot preview, send or read another user\'s trace', async () => {
    assert(admin && traceId);
    const warehouse = cookieOf(await status(await request('/auth/personas/wes.warehouse%40acme.dev', { method: 'POST', cookie: admin }), 200));
    const capabilities = await (await status(await request('/sendproof/_api/capabilities', { cookie: warehouse }), 200)).json();
    assert.equal(capabilities.identity.name, 'Wes Warehouse');
    await status(await request('/sendproof/_api/traces/' + encodeURIComponent(traceId), { cookie: warehouse }), 404);
    await status(await preview(order(), warehouse), 403);
    await status(await request(ordersPath, { method: 'POST', cookie: warehouse, body: order() }), 403);
    await assertDatabase(warehouse, 1, startingStock - 1);
  });
}

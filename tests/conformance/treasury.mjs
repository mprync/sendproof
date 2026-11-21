import assert from 'node:assert/strict';

/**
 * Conformance profile for the Treasury example (`examples/TreasuryApi`).
 *
 * The standard fixture contract does not apply to Treasury: it has its own routes, seeded users and many
 * preview-enabled operations (this profile exercises `POST /api/v2/payments`). It checks the same protocol
 * guarantees on those routes: discovery, authorization, rollback with independent database reads, observed Send
 * and trace ownership. It runs against a fixture launched at the root path, in the Development environment, with
 * a new database. The database is seeded with a realistic data set, so payment counts are compared with the count
 * found at the start rather than with zero.
 *
 * @param {import('node:test').TestContext} t Test context that owns the subtests.
 * @param {(path: string, options?: {method?: string, body?: object, cookie?: string, headers?: Record<string, string>}) => Promise<Response>} request
 *   Sends a request to the running fixture. `cookie` is the first `Set-Cookie` segment from a sign-in.
 * @param {{assert(kind: 'capabilities' | 'preview' | 'trace', payload: unknown): void}} schemas Protocol schema validator.
 */
export async function runTreasury(t, request, schemas) {
  const paymentsPath = '/api/v2/payments';
  const previewPath = '/bench/_preview' + paymentsPath;
  const rollback = { Prefer: 'tx=rollback' };
  const operatingEurId = '3f9c0000-0000-4000-8000-00000000a21e';
  const northwindId = '5b7c0000-0000-4000-8000-00000000b123';
  const startingBalance = 250000;
  let admin;
  /** The number of seeded payments, read before any test writes. */
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
  const valueDate = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const payment = overrides => ({
    debitAccountId: operatingEurId, counterpartyId: northwindId, amount: 50000, currency: 'EUR',
    valueDate: valueDate(), priority: 'Normal', reference: 'INV-2026-1184', ...overrides,
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
    const payments = await (await status(await request(paymentsPath + '?pageSize=1', { cookie }), 200)).json();
    const accounts = await (await status(await request('/api/v2/accounts?pageSize=100', { cookie }), 200)).json();
    const operating = accounts.items.find(account => account.name === 'Operating EUR');
    assert(operating, 'Seeded Operating EUR account');
    return { payments: payments.totalItems, balance: operating.availableBalance };
  }
  /** Checks that `added` payments exist beyond the seeded ones and that Operating EUR has the given balance. */
  const assertDatabase = async (cookie, added, balance) => {
    const state = await database(cookie);
    assert.equal(state.payments, baseline + added, 'Persisted payments');
    assert.equal(state.balance, balance, 'Operating EUR balance');
  };

  await t.test('Discovery, OpenAPI extensions and embedded UI are public', async () => {
    const response = await status(await request('/bench/_api/capabilities'), 200);
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    const capabilities = await response.json();
    schemas.assert('capabilities', capabilities);
    assert.equal(capabilities.identity, null);
    assert.equal(capabilities.observedSend, true);
    assert(capabilities.authProviders.some(provider => provider.kind === 'cookie' && provider.url === '/auth/login'));
    assert(capabilities.authProviders.some(provider => provider.kind === 'personas' && provider.url === '/auth/personas'));
    assert(capabilities.previewOperations.some(operation => operation.method === 'POST' && operation.path === paymentsPath));

    const spec = await (await status(await request(capabilities.openApiUrl), 200)).json();
    assert.match(spec.openapi, /^3\./);
    const schema = spec.components.schemas.CreatePaymentRequest;
    assert(schema.required.includes('amount') && schema.required.includes('valueDate'));
    assert(!schema.required.includes('priority'));
    assert.equal(schema.properties.debitAccountId.title, 'Debit account');
    assert.equal(schema.properties.amount['x-testbench-row'], 'payment-details');
    assert.equal(schema.properties.priority['x-testbench-visible'], true);
    assert(schema.examples?.length > 0, 'Operation example');
    assert(JSON.stringify(spec).includes('x-lookup') && JSON.stringify(spec).includes('x-currency-field'));

    const index = await status(await request('/bench/'), 200);
    assert.match(await index.text(), /app\.js/);
    await status(await request('/bench/styles.css'), 200);
    await status(await request('/bench/package.json'), 404);
  });

  await t.test('Preview and Send require a signed-in, authorized user', async () => {
    await status(await preview(payment()), 401);
    await status(await request('/auth/login', { method: 'POST', body: { email: 'ada.admin@acme.dev', password: 'wrong' } }), 401);
    const login = await status(await request('/auth/login', { method: 'POST', body: { email: 'ada.admin@acme.dev', password: 'Demo123!' } }), 200);
    admin = cookieOf(login);
    const capabilities = await (await status(await request('/bench/_api/capabilities', { cookie: admin }), 200)).json();
    assert.equal(capabilities.identity.name, 'Ada Admin');
    assert.equal(capabilities.identity.role, 'admin');
    baseline = (await database(admin)).payments;
    assert(baseline >= 150, 'The database is seeded with a realistic number of payments');
    await assertDatabase(admin, 0, startingBalance);
  });

  await t.test('Preview rolls back the payment, audit event and balance reservation', async () => {
    assert(admin);
    const spec = await (await status(await request('/openapi/v1.json'), 200)).json();
    const example = await confirmed(await preview(spec.components.schemas.CreatePaymentRequest.examples[0], admin));
    assert.equal(example.status, 201);
    await assertDatabase(admin, 0, startingBalance);

    const body = payment();
    const response = await preview(body, admin);
    assert.match(response.headers.get('server-timing') ?? '', /db;dur=/);
    const result = await confirmed(response);
    assert.equal(result.status, 201);
    assert.equal(result.body.amount, body.amount);
    assert.equal(result.body.status, 'Draft');
    const tables = result.changes.map(change => `${change.operation}:${change.table}`);
    assert(tables.includes('insert:Payments'), 'Payment insert is captured');
    assert(tables.includes('insert:AuditEvents'), 'Audit insert is captured');
    const accountChange = result.changes.find(change => change.operation === 'update' && change.table === 'Accounts');
    assert.equal(accountChange?.before.AvailableBalance, startingBalance);
    assert.equal(accountChange?.after.AvailableBalance, startingBalance - body.amount);
    const [effect] = result.effects;
    assert.equal(result.effects.length, 1);
    assert.equal(effect.kind, 'email');
    assert.notEqual(effect.delivered, true, 'Preview suppresses delivery');
    assert.equal(effect.data.to[0], 'treasury-ops@acme.dev');
    assert(result.logs.some(log => log.level === 'Sql'), 'SQL is captured');
    assert(!JSON.stringify(result.logs).includes('Demo123!'), 'Credentials are never captured');
    await assertDatabase(admin, 0, startingBalance);
  });

  await t.test('Validation failures stay inside the application response', async () => {
    assert(admin);
    await status(await request(paymentsPath, { method: 'POST', cookie: admin, body: payment({ amount: 0 }) }), 400);
    const invalid = await confirmed(await preview(payment({ amount: 0 }), admin));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.changes, []);
    await assertDatabase(admin, 0, startingBalance);
  });

  let traceId;
  await t.test('Observed Send commits once, traces its work and replays idempotently', async () => {
    assert(admin);
    const body = payment();
    const send = headers => request(paymentsPath, { method: 'POST', cookie: admin, body, headers });
    const sent = await status(await send({ 'Idempotency-Key': 'conformance-payment-1', Prefer: 'trace' }), 201);
    assert.match(sent.headers.get('server-timing') ?? '', /db;dur=/);
    assert(sent.headers.get('location'), 'The application Location is preserved on Send');
    traceId = sent.headers.get('x-testbench-trace');
    assert(traceId, 'Observed Send returns a trace ID');
    const trace = await (await status(await request('/bench/_api/traces/' + encodeURIComponent(traceId), { cookie: admin }), 200)).json();
    schemas.assert('trace', trace);
    assert(trace.changes.some(change => change.operation === 'insert' && change.table === 'Payments'));
    assert.equal(trace.effects.length, 1);
    assert.equal(trace.effects[0].delivered, true);
    const sql = trace.logs.filter(log => log.level === 'Sql').length;
    assert(sql > 0);
    assert.equal(trace.timing.queryCount, sql);
    await assertDatabase(admin, 1, startingBalance - body.amount);

    await status(await send({ 'Idempotency-Key': 'conformance-payment-1' }), 200);
    await assertDatabase(admin, 1, startingBalance - body.amount);
    const different = payment({ amount: 1 });
    await status(await request(paymentsPath, {
      method: 'POST', cookie: admin, body: different, headers: { 'Idempotency-Key': 'conformance-payment-1' },
    }), 409);
    await assertDatabase(admin, 1, startingBalance - body.amount);
  });

  await t.test('A read-only persona cannot preview, send or read another user\'s trace', async () => {
    assert(admin && traceId);
    const viewer = cookieOf(await status(await request('/auth/personas/cara.viewer%40acme.dev', { method: 'POST', cookie: admin }), 200));
    const capabilities = await (await status(await request('/bench/_api/capabilities', { cookie: viewer }), 200)).json();
    assert.equal(capabilities.identity.name, 'Cara Viewer');
    await status(await request('/bench/_api/traces/' + encodeURIComponent(traceId), { cookie: viewer }), 404);
    await status(await preview(payment(), viewer), 403);
    await status(await request(paymentsPath, { method: 'POST', cookie: viewer, body: payment() }), 403);
    await assertDatabase(viewer, 1, startingBalance - 50000);
  });
}

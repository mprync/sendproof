import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withFixture } from './host.mjs';

const base = '/tenant';
const bench = base + '/bench';
const discovery = bench + '/_api/capabilities';
const rollback = { Prefer: 'tx=rollback' };
const credentials = { email: 'admin@example.test', password: 'bench-fixture' };
const viewerEmail = 'viewer@example.test';
const fixtureTitle = 'Test Bench Conformance';
const readItem = (request, id, cookie) => request(base + '/items/' + id, { cookie });

async function status(response, expected) {
  const allowed = [expected].flat();
  if (!allowed.includes(response.status)) {
    assert.fail(`Expected HTTP ${allowed.join(' or ')}, got ${response.status} from ${response.url}\n${(await response.text()).slice(0, 1000)}`);
  }
  return response;
}

const cookieOf = response => {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  assert(value, 'Expected a session cookie');
  return value;
};

function localPath(value, prefix = base + '/') {
  assert.equal(typeof value, 'string');
  assert(value.startsWith(prefix), `Expected an application-local URL under ${prefix}, got ${value}`);
  assert(!value.includes('\\'), `Invalid path: ${value}`);
  return value;
}

async function noConfirmation(response, expected) {
  await status(response, expected);
  assert.equal(response.headers.get('preference-applied'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('location'), null);
  const content = await response.text();
  if (content && response.headers.get('content-type')?.includes('json')) {
    assert.notEqual(JSON.parse(content).rolledBack, true);
  }
  return content;
}

async function confirmed(response, schemas) {
  await status(response, 200);
  assert.equal(response.headers.get('preference-applied'), 'tx=rollback');
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.equal(response.headers.get('set-cookie'), null);
  const result = await response.json();
  schemas.assert('preview', result);
  for (const header of ['connection', 'location', 'set-cookie', 'transfer-encoding', 'upgrade']) {
    assert(!Object.keys(result.headers).some(name => name.toLowerCase() === header), `Leaked ${header}`);
  }
  return result;
}

const go = (request, path, options = {}) =>
  request(bench + '/_preview' + path, { method: 'POST', ...options, headers: { ...rollback, ...options.headers } });

async function assertMissing(request, id, cookie) {
  const response = await readItem(request, id, cookie);
  await status(response, 404);
  await response.body?.cancel();
}

async function assertItem(request, id, name, cookie) {
  const response = await status(await readItem(request, id, cookie), 200);
  assert.deepEqual(await response.json(), { id, name });
}

export async function standard(t, request, schemas, binding) {
  const response = await status(await request(discovery), 200);
  const capabilities = await response.json();
  schemas.assert('capabilities', capabilities);
  const authURL = kind => {
    const provider = capabilities.authProviders.find(entry => entry.kind === kind);
    assert(provider, `Missing ${kind} provider`);
    return localPath(provider.url);
  };
  const login = authURL('cookie');
  const personas = authURL('personas');
  let admin;
  let viewer;

  await t.test('Discovery, OpenAPI and shared assets respect the path base', async () => {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    assert.equal(capabilities.identity, null);
    assert.equal(capabilities.observedSend, true);
    const spec = await status(await request(localPath(capabilities.openApiUrl)), 200);
    const document = await spec.json();
    assert.match(document.openapi, /^3\./);
    assert.equal(document.info.title, fixtureTitle);
    for (const [method, path] of [
      ['POST', '/items'], ['PATCH', '/items/{id}'], ['DELETE', '/items/{id}'],
      ...['fail', 'large', 'redirect', 'capture'].map(action => ['POST', '/items/{id}/' + action]),
    ]) {
      assert(document.paths[path]?.[method.toLowerCase()], `OpenAPI lacks ${method} ${path}`);
      assert(capabilities.previewOperations.some(operation => operation.method === method && operation.path === path),
        `Discovery lacks ${method} ${path}`);
    }
    assert(!capabilities.previewOperations.some(operation => operation.path.endsWith('/ordinary')));
    for (const doc of capabilities.documents ?? []) localPath(doc.url);

    const redirect = await status(await request(bench + '?from=conformance'), [301, 302, 307, 308]);
    assert.equal(redirect.headers.get('location'), bench + '/?from=conformance');
    const index = await status(await request(bench + '/'), 200);
    assert.match(index.headers.get('cache-control') ?? '', /\bno-cache\b|\bno-store\b/);
    const html = await index.text();
    assert.match(html, /<title>.*Test Bench/i);
    const assets = Array.from(html.matchAll(/(?:href|src)="([^"]+\.(?:css|m?js))"/g), match => match[1]);
    assert(assets.length > 1, 'Expected JavaScript and stylesheet references in the UI');
    for (const asset of assets) {
      const pathname = new URL(asset, 'http://example.test' + bench + '/').pathname;
      const resource = await status(await request(localPath(pathname, bench + '/')), 200);
      assert.match(resource.headers.get('content-type') ?? '', asset.endsWith('.css') ? /text\/css/ : /javascript/);
      assert.match(resource.headers.get('cache-control') ?? '', /\bno-cache\b|\bno-store\b|\bmax-age=\d+/);
      assert.equal(resource.headers.get('x-content-type-options'), 'nosniff');
      assert((await resource.arrayBuffer()).byteLength > 0, `Empty asset ${asset}`);
    }
    await status(await request(bench + '/does-not-exist.js'), 404);
    await status(await request(bench + '/api.test.mjs'), 404);
    await status(await request('/bench/_api/capabilities'), [404, 405]);
  });

  await t.test('Password sign-in, personas and operation authorization', async () => {
    const signIn = (body = credentials) => request(login, { method: 'POST', body });
    await status(await signIn({ ...credentials, password: 'wrong' }), 401);
    await status(await request(personas), [401, 403]);
    await noConfirmation(await go(request, '/items', { body: { id: 'anonymous', name: 'Denied' } }), [401, 403]);
    admin = cookieOf(await status(await signIn(), [200, 204]));
    const adminDiscovery = await status(await request(discovery, { cookie: admin }), 200);
    assert.deepEqual((await adminDiscovery.json()).identity, { name: 'Fixture Admin', role: 'admin' });
    const list = await status(await request(personas, { cookie: admin }), 200);
    assert((await list.json()).some(persona => persona.email === viewerEmail &&
      persona.role === 'viewer' && persona.name === 'Fixture Viewer'));
    viewer = cookieOf(await status(await request(personas + '/' + encodeURIComponent(viewerEmail),
      { method: 'POST', cookie: admin }), [200, 204]));
    const viewerDiscovery = await status(await request(discovery, { cookie: viewer }), 200);
    assert.deepEqual((await viewerDiscovery.json()).identity, { name: 'Fixture Viewer', role: 'viewer' });
    const body = { id: 'denied', name: 'Denied' };
    await noConfirmation(await go(request, '/items', { cookie: viewer, body }), 403);
    await status(await request(base + '/items', { method: 'POST', cookie: viewer, body }), 403);
    await assertMissing(request, body.id, admin);
  });

  await t.test('Preview keeps real CRUD semantics and rolls back SQL', async () => {
    assert(admin);
    const created = { id: 'preview-create', name: 'Created' };
    const result = await confirmed(await go(request, '/items', { cookie: admin, body: created }), schemas);
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, created);
    assert(result.changes.some(change => change.operation === 'insert' && change.before === null &&
      JSON.stringify(change.after).includes(created.name) && JSON.stringify(change.key).includes(created.id)));
    assert(result.effects.some(effect => effect.kind === 'email' && effect.description === 'Created item' &&
      effect.delivered !== true));
    assert(result.logs.some(log => log.message.includes('created:' + created.id)));
    const params = result.logs.flatMap(log => log.sql?.parameters ?? []);
    assert(params.some(param => param.name.includes('fixture_secret') && param.value === '[REDACTED]'));
    assert(!JSON.stringify(result).includes('fixture-secret-value'));
    await assertMissing(request, created.id, viewer);

    const existing = { id: 'existing', name: 'Initial' };
    const sent = await status(await request(base + '/items', { method: 'POST', cookie: admin, body: existing }), 201);
    assert.equal(sent.headers.get('x-testbench-trace'), null);
    const updated = await confirmed(await go(request, '/items/existing?tag=two%20words',
      { method: 'PATCH', cookie: admin, body: { name: 'Temporary' } }), schemas);
    assert.equal(updated.status, 200);
    assert.equal(updated.headers['x-fixture-tag'], 'two words');
    assert.deepEqual(updated.body, { ...existing, name: 'Temporary' });
    assert(updated.changes.some(change => change.operation === 'update' &&
      JSON.stringify(change.before).includes('Initial') && JSON.stringify(change.after).includes('Temporary')));
    assert(!updated.logs.some(log => log.message.includes('created:' + created.id) || log.message.includes('created:existing')));
    await assertItem(request, existing.id, existing.name, viewer);

    const removed = await confirmed(await go(request, '/items/existing', { method: 'DELETE', cookie: admin }), schemas);
    assert.equal(removed.status, 204);
    assert(removed.changes.some(change => change.operation === 'delete' && change.before && change.after === null));
    await assertItem(request, existing.id, existing.name, viewer);
    await status(await request(base + '/items/existing', { method: 'DELETE', cookie: admin }), 204);
    await assertMissing(request, existing.id, viewer);
  });

  await t.test('Invalid transport and unmarked targets do not execute', async () => {
    assert(admin);
    const id = 'guarded';
    const body = { id, name: 'Guarded' };
    const method = 'POST';
    await noConfirmation(await request(base + '/items', { method, cookie: admin, headers: rollback, body }), 400);
    for (const prefer of [undefined, 'tx="rollback"', 'trace, tx=rollback']) {
      const headers = prefer ? { Prefer: prefer } : {};
      await noConfirmation(await request(bench + '/_preview/items', { method, cookie: admin, body, headers }), 400);
    }
    await noConfirmation(await go(request, '/items', {
      cookie: admin, body, headers: { Origin: 'https://elsewhere.example.test' },
    }), [400, 403]);
    await noConfirmation(await go(request, '/items', { cookie: admin, body, headers: { 'Sec-Fetch-Site': 'cross-site' } }), [400, 403]);
    await noConfirmation(await go(request, '/items', { method: 'HEAD', cookie: admin }), 405);
    await noConfirmation(await go(request, '//items', { cookie: admin, body }), [400, 404]);
    await noConfirmation(await go(request, '/bench/_api/capabilities', { cookie: admin }), [400, 404]);
    await noConfirmation(await go(request, '/missing-target', { cookie: admin }), [404, 405, 409]);
    await noConfirmation(await go(request, '/items/' + id + '/ordinary', { cookie: admin }), [404, 405, 409]);
    await assertMissing(request, id, admin);
    const ordinary = await request(base + '/items/' + id + '/ordinary',
      { method, cookie: admin, headers: { Prefer: 'trace' } });
    assert(ordinary.ok, 'The unmarked operation is still available via Send');
    assert.equal(ordinary.headers.get('x-testbench-trace'), null);
  });

  await t.test('Handled failure, oversize and redirect never persist or leak transport headers', async () => {
    assert(admin);
    const validation = await go(request, '/items', { cookie: admin, body: {} });
    if (validation.status === 200) {
      assert([400, 422].includes((await confirmed(validation, schemas)).status));
    } else {
      await noConfirmation(validation, [400, 422]);
    }

    const failure = await go(request, '/items/failed/fail', { cookie: admin });
    if (failure.status === 200) {
      assert.equal((await confirmed(failure, schemas)).status, 409);
    } else {
      await noConfirmation(failure, 500);
    }
    await assertMissing(request, 'failed', admin);
    const rejection = await noConfirmation(await go(request, '/items/oversized/large', { cookie: admin }), 413);
    assert(Buffer.byteLength(rejection) < 1024, 'The error must not include partial response bytes');
    await assertMissing(request, 'oversized', admin);
    const redirectResult = await confirmed(await go(request, '/items/redirected/redirect', { cookie: admin }), schemas);
    assert.equal(redirectResult.status, 302);
    await assertMissing(request, 'redirected', admin);
  });

  await t.test('Capture limits retain rollback and bound changes, effects and logs', async () => {
    assert(admin);
    const captured = await confirmed(await go(request, '/items/overflow/capture', { cookie: admin }), schemas);
    for (const [name, maximum] of [['changes', 200], ['effects', 100], ['logs', 500]]) {
      assert.equal(captured[name + 'Truncated'], true, name + ' truncation flag');
      assert(captured[name].length > 0 && captured[name].length <= maximum, name + ' capture limit');
    }
    for (const change of captured.changes.slice(0, 2)) {
      const id = typeof change.key === 'string' ? change.key : change.key.id ?? change.key.Id;
      assert(id, 'Captured change identifies the actual item');
      await assertMissing(request, id, admin);
    }
  });

  await t.test('Observed Send commits with an owner-only, bounded-lifetime trace', async () => {
    assert(admin && viewer);
    for (const [id, cookie, extra] of [
      ['anonymous-trace', undefined, {}],
      ['cross-origin-send', admin, { Origin: 'https://elsewhere.example.test' }],
    ]) {
      const ignored = await request(base + '/items', {
        method: 'POST', cookie, body: { id, name: 'Trace check' }, headers: { Prefer: 'trace', ...extra },
      });
      await status(ignored, cookie ? 201 : 401);
      assert.equal(ignored.headers.get('x-testbench-trace'), null);
    }
    const item = { id: 'traced', name: 'Committed' };
    const sent = await status(await request(base + '/items', {
      method: 'POST', cookie: admin, body: item, headers: { Prefer: 'trace' },
    }), 201);
    assert.deepEqual(await sent.json(), item);
    const traceId = sent.headers.get('x-testbench-trace');
    assert(traceId, 'Expected a trace ID on observed Send');
    const path = bench + '/_api/traces/' + encodeURIComponent(traceId);
    const owned = await status(await request(path, { cookie: admin }), 200);
    assert.match(owned.headers.get('cache-control') ?? '', /\bno-store\b/);
    const trace = await owned.json();
    schemas.assert('trace', trace);
    assert(trace.changes.some(change => change.operation === 'insert' && JSON.stringify(change.key).includes(item.id)));
    assert(trace.effects.some(effect => effect.delivered === true));
    assert(trace.logs.some(log => log.message.includes('created:' + item.id)));
    assert(!trace.logs.some(log => log.message.includes('created:cross-origin-send')));
    assert(!JSON.stringify(trace).includes('fixture-secret-value'));
    await status(await request(path, { cookie: viewer }), 404);
    await status(await request(path), [401, 403, 404]);
    await assertItem(request, item.id, item.name, viewer);
    assert(binding.traceTtlMs > 0 || binding.advanceClock, 'Specify the fixture trace TTL or clock advance');
    if (binding.advanceClock) {
      await status(await request(base + binding.advanceClock, { method: 'POST', cookie: admin }), [200, 204]);
    } else {
      await delay(binding.traceTtlMs + 100);
    }
    await status(await request(path, { cookie: admin }), 404);
  });
}

export async function alternates(t, binding, schemas) {
  for (const scenario of ['disabled', 'no-provider', 'rollback-failure']) {
    await t.test(scenario, () => withFixture(binding, scenario, '', async request => {
      const signedIn = await status(await request('/auth/sign-in', { method: 'POST', body: credentials }), [200, 204]);
      const cookie = cookieOf(signedIn);
      const capabilities = await request('/bench/_api/capabilities');
      if (scenario === 'disabled') {
        await status(capabilities, 404);
        await status(await request('/bench/'), 404);
      } else {
        const result = await (await status(capabilities, 200)).json();
        schemas.assert('capabilities', result);
        if (scenario === 'no-provider') assert.deepEqual(result.previewOperations, []);
      }
      const body = { id: scenario, name: 'Not persisted' };
      const preview = await request('/bench/_preview/items', { method: 'POST', cookie, headers: rollback, body });
      await noConfirmation(preview, { disabled: 404, 'no-provider': [409, 503], 'rollback-failure': 500 }[scenario]);
      await status(await request('/items/' + body.id, { cookie }), 404);
      await status(await request('/items', { method: 'POST', cookie, body }), 201);
      const read = await status(await request('/items/' + body.id, { cookie }), 200);
      assert.deepEqual(await read.json(), body);
    }));
  }
}

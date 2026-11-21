import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { Capture, createBench, currentCapture, deliverEffect, endsTransaction, looksSecret, mayWrite } from '@test-bench/core';

const origin = 'http://localhost:8000';
const identity = { name: 'Robin', role: 'editor', subject: '42', scheme: 'cookie' };
const provider = { preview: dispatch => dispatch() };
const request = (pathname, options = {}) =>
  ({ pathname, method: 'GET', raw: null, origin, headers: {}, ...options });
const protocol = (options = {}) =>
  createBench({ environment: 'Development', previewProvider: provider, ...options });
const lookup = '/bench/_api/capabilities';
const preview = request('/bench/_preview/items', { method: 'POST', headers: { prefer: 'tx=rollback' } });
const parse = response => JSON.parse(response.body);
const transport = (body = '', headers = {}, status = 201) => ({ status, headers, body: Buffer.from(body) });

test('options reject unsafe same-origin URLs and out-of-range limits', () => {
  for (const value of [
    'https://elsewhere.test/api', '//elsewhere.test/api', '/%2fexample.test', '/abc/%2e%2e/api',
    '/abc#api', '/abc?u=bad value', '/abc/%5capi', '/abc/%xx',
  ]) {
    assert.throws(() => protocol({ openApiUrl: value }), TypeError, value);
  }
  for (const value of [0, -1, 0.5, Infinity, NaN]) {
    assert.throws(() => protocol({ maxResponseBytes: value }), TypeError);
    assert.throws(() => protocol({ traceTtlMs: value }), TypeError);
    assert.throws(() => protocol({ captureLimits: { changes: value } }), TypeError);
  }
  assert.throws(() => protocol({ environment: '' }), TypeError);
});

test('discovery scopes documents, field modules and auth providers to the path base', async () => {
  const bench = protocol({
    apiName: 'Dispatch',
    openApiUrl: '/specs/main.json?v=1',
    documents: [{ name: 'Old', url: '/specs/old.json' }],
    fieldModules: ['/form.js'],
    authProviders: [{ label: 'Login', kind: 'cookie', url: '/login' }],
    discoverAuth: async () => [{ label: 'SSO', kind: 'oidc', url: '/oidc' }, { label: 'Bearer', kind: 'bearer', url: null }],
    resolveIdentity: async () => identity,
  });
  const response = await bench.lookup(request(lookup, { basePath: '/customers/tenant' }));
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const data = parse(response);
  assert.deepEqual(data.identity, { name: 'Robin', role: 'editor' });
  assert.equal(data.openApiUrl, '/customers/tenant/specs/main.json?v=1');
  assert.equal(data.documents[0].url, '/customers/tenant/specs/old.json');
  assert.deepEqual(data.fieldModules, ['/customers/tenant/form.js']);
  assert.deepEqual(data.authProviders.map(entry => entry.url), ['/customers/tenant/login', '/customers/tenant/oidc', null]);
});

test('access policies distinguish anonymous and authenticated callers', async () => {
  const bench = protocol({ authorize: async () => false, resolveIdentity: ({ raw }) => raw });
  assert.equal((await bench.lookup(request(lookup))).status, 401);
  assert.equal((await bench.lookup(request(lookup, { raw: identity }))).status, 403);
  assert.equal((await bench.lookup({ ...preview, raw: identity })).status, 403);
  assert.equal(await bench.observation(request('/items', { raw: identity, headers: { prefer: 'trace' } })), null);
});

test('asset routing canonicalizes the mount and revalidates via ETag', async () => {
  const bench = protocol();
  const redirect = await bench.lookup(request('/bench', { basePath: '/tenant', query: '?from=docs' }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.Location, '/tenant/bench/?from=docs');
  const asset = await bench.lookup(request('/bench/index.html'));
  assert.equal(asset.status, 200);
  assert.match(asset.body.toString(), /<title>.*Test Bench/i);
  assert.equal(asset.headers['X-Content-Type-Options'], 'nosniff');
  const cached = await bench.lookup(request('/bench/index.html', { headers: { 'if-none-match': asset.headers.ETag } }));
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal((await bench.lookup(request('/bench/constructor'))).status, 404);
  assert.equal(await bench.lookup(request('/bench-other')), null);
});

test('preview requires an exact preference, a local target and same-origin provenance', async () => {
  const bench = protocol();
  assert.deepEqual(await bench.lookup({ ...preview, query: '?page=1' }), { target: '/items?page=1' });
  for (const prefer of ['', 'tx="rollback"', 'trace, tx=rollback', ['tx=rollback']]) {
    assert.equal((await bench.lookup({ ...preview, headers: { prefer } })).status, 400);
  }
  for (const headers of [
    { origin: 'https://localhost:8000' }, { origin: 'http://localhost:8000/api' },
    { origin: 'http://user@localhost:8000' }, { origin: [origin] }, { 'sec-fetch-site': 'same-site, cross-site' },
  ]) {
    assert.equal((await bench.lookup({ ...preview, headers: { ...preview.headers, ...headers } })).status, 403);
  }
  for (const suffix of ['//items', '/%2fitems', '/%62ench', '/%2e%2e/items']) {
    assert.equal((await bench.lookup({ ...preview, pathname: '/bench/_preview' + suffix })).status, 400);
  }
  assert.equal((await bench.lookup({ ...preview, method: 'HEAD' })).status, 405);
  assert.equal((await bench.lookup({ ...preview, pathname: '/items', headers: { prefer: ['trace', 'tx=rollback'] } })).status, 400);
});

test('disabled and provider-free workbenches reject direct preview dispatch', async () => {
  const unsafe = () => assert.fail('The handler must never be called.');
  const disabled = protocol({ environment: 'Production' });
  assert.equal((await disabled.lookup(request(lookup))).status, 404);
  assert.equal((await disabled.preview(preview, unsafe)).status, 404);
  const withoutProvider = protocol({ previewProvider: undefined });
  assert.equal((await withoutProvider.lookup(preview)).status, 503);
  assert.equal((await withoutProvider.preview(preview, unsafe)).status, 503);
  assert.deepEqual(parse(await withoutProvider.lookup(request(lookup))).previewOperations, []);
});

test('confirmed preview waits for its provider and filters unsafe response headers', async () => {
  let rolledBack = false;
  const bench = protocol({ previewProvider: {
    async preview(dispatch) {
      const response = await dispatch();
      await nextTurn();
      rolledBack = true;
      return response;
    },
  } });
  const response = await bench.preview(preview, async () => {
    assert.equal(rolledBack, false);
    currentCapture().log({ level: 'Info', message: 'held' });
    return transport('{"id":7}', {
      'Content-Type': 'application/json', Location: '/items/7', 'Set-Cookie': ['login=no'],
      Connection: 'private-header', 'Private-Header': 'do not disclose', 'Test-Header': 'public',
    });
  });
  assert.equal(rolledBack, true);
  assert.equal(response.headers['Preference-Applied'], 'tx=rollback');
  const envelope = parse(response);
  assert.equal(envelope.rolledBack, true);
  assert.deepEqual(envelope.body, { id: 7 });
  assert.deepEqual(envelope.headers, { 'content-type': 'application/json', 'test-header': 'public' });
  assert.equal(envelope.logs[0].message, 'held');
});

test('rollback failures and rejected dispatch never yield a confirmed envelope', async () => {
  const failures = [];
  const bench = protocol({ onError: error => failures.push(error) });
  for (const [value, status] of [
    [{ unmatched: true }, 409],
    [transport('', {}, 401), 401],
    [transport('', {}, 403), 403],
    [transport('', {}, 503), 500],
    [{ ...transport(), exceeded: true }, 413],
  ]) {
    const response = await bench.preview(preview, async () => value);
    assert.equal(response.status, status);
    assert.equal(response.headers['Preference-Applied'], undefined);
    assert.equal(parse(response).rolledBack, undefined);
  }
  const simulated = new Error('rollback failure');
  const broken = protocol({
    onError: error => failures.push(error),
    previewProvider: { async preview(dispatch) { await dispatch(); throw simulated; } },
  });
  assert.equal((await broken.preview(preview, async () => transport())).status, 500);
  assert.deepEqual(failures, [simulated]);
});

test('preview response body retains text, permits invalid JSON as text and encodes binary', async () => {
  const bench = protocol({ maxResponseBytes: 20 });
  for (const [content, type, expected] of [
    ['hello', 'text/plain', 'hello'],
    ['{', 'application/problem+json', '{'],
    ['raw', 'application/octet-stream', { encoding: 'base64', data: 'cmF3' }],
    ['', 'application/json', null],
  ]) {
    const response = await bench.preview(preview, async () => transport(content, { 'content-type': type }));
    assert.deepEqual(parse(response).body, expected);
  }
  const excess = await bench.preview(preview, async () => transport('x'.repeat(21)));
  assert.equal(excess.status, 413);
});

test('capture limits, redaction and delivery produce bounded request-scoped records', async () => {
  const capture = new Capture('preview', { logs: 1, effects: 1, changes: 1 }, true);
  let delivered = 0;
  await capture.run(async () => {
    const recorder = currentCapture();
    recorder.sql({ text: 'select 1', parameters: [
      { name: 'fixture_secret', value: 'secret-fixture', dbType: 'text' },
      { name: 'status', value: 'active', dbType: 'text' },
    ], elapsedMs: 5 });
    recorder.log({ level: 'Debug', message: 'over limit' });
    for (const id of [1, 2]) {
      recorder.change({ operation: 'insert', table: 'items', key: { id }, before: null, after: { id } });
      await deliverEffect({ kind: 'email', description: 'Hold', delivered: true }, () => delivered++);
    }
  });
  const { capture: result, timing } = capture.finish();
  assert.equal(timing.queryCount, 1);
  assert.equal(timing.db, 5);
  assert.deepEqual(result.logs[0].sql.parameters.map(parameter => parameter.value), ['[REDACTED]', 'active']);
  assert.equal(result.effects[0].delivered, undefined);
  assert.equal(result.logsTruncated, true);
  assert.equal(result.effectsTruncated, true);
  assert.equal(result.changesTruncated, true);
  assert.equal(delivered, 0);
  assert.equal(currentCapture(), undefined);
});

test('observations isolate workspaces, authentication schemes and trace expiry', async () => {
  let now = 0;
  const bench = protocol({ traceClock: () => now, traceTtlMs: 100, resolveIdentity: ({ raw }) => raw });
  const observe = request('/items', { raw: identity, basePath: '/tenant', method: 'POST', headers: { prefer: 'trace' } });
  const observed = await bench.observation(observe);
  observed.run(() => currentCapture().log({ level: 'Info', message: 'one request' }));
  const id = observed.complete(201);
  const path = '/bench/_api/traces/' + id;
  const target = request(path, { raw: identity, basePath: '/tenant' });
  assert.equal((await bench.lookup(target)).status, 200);
  assert.equal((await bench.lookup({ ...target, basePath: '/other' })).status, 404);
  assert.equal((await bench.lookup({ ...target, raw: { ...identity, scheme: 'bearer' } })).status, 404);
  assert.equal((await bench.lookup({ ...target, raw: { ...identity, subject: '43' } })).status, 404);
  now = 99;
  assert.equal(parse(await bench.lookup(target)).logs[0].message, 'one request');
  now = 100;
  assert.equal((await bench.lookup(target)).status, 404);
  assert.equal(observed.complete(201), undefined);
});

test('the trace store evicts entries per owner before enforcing the global cap', async () => {
  const bench = protocol({ resolveIdentity: ({ raw }) => raw });
  const trace = async raw => (await bench.observation(request('/items',
    { method: 'POST', headers: { prefer: 'trace' }, raw }))).complete(201);
  const owned = await Promise.all(Array.from({ length: 9 }, () => trace(identity)));
  const read = (id, raw = identity) => bench.lookup(request('/bench/_api/traces/' + id, { raw }));
  assert.equal((await read(owned[0])).status, 404);
  assert.equal((await read(owned[1])).status, 200);
  for (let index = 0; index < 32; index++) await trace({ ...identity, subject: String(index) + 'new' });
  assert.equal((await read(owned[8])).status, 404);
});

test('interleaved sends isolate effects and only attach logs from their async scope', async () => {
  const captures = [new Capture('send'), new Capture('send')];
  let deliveries = 0;
  await Promise.all(captures.map((capture, index) => capture.run(async () => {
    await nextTurn();
    currentCapture().log({ level: 'Info', message: String(index) });
    await deliverEffect({ kind: 'job', description: String(index) }, () => ++deliveries);
  })));
  assert.equal(deliveries, 2);
  for (const [index, capture] of captures.entries()) {
    const { capture: result } = capture.finish();
    assert.deepEqual(result.logs.map(log => log.message), [String(index)]);
    assert.deepEqual(result.effects.map(effect => [effect.description, effect.delivered]), [[String(index), true]]);
  }
});

test('secret names are judged by whole words, as in the reference adapter', () => {
  for (const name of ['password', 'PasswordHash', 'password_hash', 'passwd', 'pwd', 'client_secret', 'refreshToken',
    'salt', 'credentials', 'apikey', 'api_key', 'x-api-key', 'privateKey', 'signing_key', 'AccessKey', 'encryption-key']) {
    assert.equal(looksSecret(name), true, name);
  }
  for (const name of ['idempotency_key', 'monkey', 'primary_key', 'key', 'passage', 'tokenizer_id', 'status', 'hashtag']) {
    assert.equal(looksSecret(name), false, name);
  }
});

test('SQL values are hidden for secret names and for any statement that names a secret', async () => {
  const capture = new Capture('send', {}, true);
  capture.run(() => {
    const recorder = currentCapture();
    const parameters = [{ name: '$1', value: 'fixture-hash', dbType: 'text' }, { name: '$2', value: '7', dbType: 'text' }];
    recorder.sql({ text: 'UPDATE users SET password_hash = $1 WHERE id = $2', parameters });
    recorder.sql({ text: 'UPDATE users SET name = $1 WHERE id = $2', parameters });
    recorder.sql({ text: 'select 1', parameters: [{ name: 'pwd', value: 'fixture-pwd', dbType: 'text' }] });
  });
  const [secretStatement, plain, named] = capture.finish().capture.logs.map(log => log.sql.parameters.map(p => p.value));
  assert.deepEqual(secretStatement, ['[REDACTED]', '[REDACTED]']);
  assert.deepEqual(plain, ['fixture-hash', '7']);
  assert.deepEqual(named, ['[REDACTED]']);
});

test('change snapshots never carry secret-named column values', () => {
  const capture = new Capture('preview');
  capture.run(() => {
    currentCapture().change({ operation: 'update', table: 'users', key: { id: 1 },
      before: { id: 1, email: 'a@example.test', password_hash: 'fixture-old-hash' },
      after: { id: 1, email: 'a@example.test', passwordHash: 'fixture-new-hash', apiKey: 'fixture-key' } });
    currentCapture().change({ operation: 'delete', table: 'sessions', key: { session_token: 'fixture-token' },
      before: { session_token: 'fixture-token', password_digest: 'fixture-digest', user_id: 1 }, after: null });
  });
  const [change, session] = capture.finish().capture.changes;
  assert.deepEqual(session.key, { session_token: '[REDACTED]' });
  assert.deepEqual(session.before, { session_token: '[REDACTED]', password_digest: '[REDACTED]', user_id: 1 });
  assert.doesNotMatch(JSON.stringify(session), /fixture-/);
  assert.deepEqual(change.before, { id: 1, email: 'a@example.test', password_hash: '[REDACTED]' });
  assert.deepEqual(change.after, { id: 1, email: 'a@example.test', passwordHash: '[REDACTED]', apiKey: '[REDACTED]' });
  assert.doesNotMatch(JSON.stringify(change), /fixture-/);
});

test('log entries keep at most 32 properties and clip names and text', () => {
  const capture = new Capture('send');
  const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => ['p' + index, 'v']));
  properties['{OriginalFormat}'] = 'template';
  capture.run(() => {
    currentCapture().log({ level: 'Information', message: 'x'.repeat(5000), category: 'c'.repeat(300), properties, unexpected: 'dropped' });
    currentCapture().log({ level: 'Information', message: 'long property', properties: { ['n'.repeat(300)]: 'y'.repeat(5000) } });
  });
  const [log, long] = capture.finish().capture.logs;
  assert.equal(Object.keys(log.properties).length, 32);
  assert.equal(Object.hasOwn(log.properties, '{OriginalFormat}'), false);
  assert.equal(log.message.length, 4096);
  assert.equal(log.category.length, 256);
  assert.equal(log.unexpected, undefined);
  assert.equal(Object.keys(long.properties)[0].length, 256);
  assert.equal(Object.values(long.properties)[0].length, 4096);
});

test('trace ids carry 128 random bits and owners include the token issuer', async () => {
  const bench = protocol({ resolveIdentity: ({ raw }) => raw });
  const issued = { ...identity, issuer: 'https://issuer-a.test' };
  const id = (await bench.observation(request('/items', { method: 'POST', headers: { prefer: 'trace' }, raw: issued }))).complete(201);
  assert.match(id, /^[0-9a-f]{32}$/);
  const read = raw => bench.lookup(request('/bench/_api/traces/' + id, { raw }));
  assert.equal((await read(issued)).status, 200);
  assert.equal((await read({ ...issued, issuer: 'https://issuer-b.test' })).status, 404);
  assert.equal((await read(identity)).status, 404);
});

test('the database label must be a display name, never connection details', async () => {
  for (const value of ['postgres://user:pass@db.internal:5432/app', 'Server=db;Password=x', '/var/data/app.sqlite',
    ':memory:', 'C:\\data\\app.db', 'db.internal:5432', '', 'x'.repeat(129), 42]) {
    assert.throws(() => protocol({ database: value }), TypeError, String(value));
  }
  const response = await protocol({ database: 'SQL Server (inventory)' }).lookup(request(lookup));
  assert.equal(parse(response).database, 'SQL Server (inventory)');
});

test('the shared statement classifier sees MySQL executable comments and implicit commits', () => {
  assert.equal(endsTransaction('/*!COMMIT*/', 'mysql'), true);
  assert.equal(endsTransaction('SELECT 1; /*!50000 COMMIT */', 'mysql'), true);
  assert.equal(endsTransaction('/*M!100100 ROLLBACK */', 'mysql'), true);
  assert.equal(endsTransaction('/* COMMIT */ SELECT 1', 'mysql'), false);
  assert.equal(endsTransaction('LOAD XML INFILE "x" INTO TABLE t', 'mysql'), true);
  assert.equal(endsTransaction("SELECT 'commit; rollback'", 'postgres'), false);
  assert.equal(mayWrite('/*!INSERT INTO t VALUES (1)*/'), true);
});

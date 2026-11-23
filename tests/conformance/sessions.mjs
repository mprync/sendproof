import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { confirmed, status } from './protocol.mjs';

const base = '/tenant';
const collection = '/sendproof/_api/sessions';
const preview = '/sendproof/_preview';
const headersFor = id => ({ Prefer: 'tx=rollback', 'Sendproof-Session': id });

async function problem(response, expected, code) {
  await status(response, expected);
  assert.match(response.headers.get('content-type') ?? '', /^application\/problem\+json\b/);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  assert.equal(response.headers.get('preference-applied'), null);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(body.status, expected);
  return body;
}

/** Close the held transaction even when a fixture assertion fails. Each step must report its own index. */
export async function withSession(request, schemas, { base = '', cookie }, run) {
  const response = await status(await request(base + collection, { method: 'POST', cookie }), 201);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  const { id, idleTimeoutSeconds, maxLifetimeSeconds } = await response.json();
  assert.match(id, /^[0-9a-f]{32,}$/);
  const resource = base + collection + '/' + id;
  let ended = false;
  const end = async () => {
    if (ended) return;
    await status(await request(resource, { method: 'DELETE', cookie }), 204);
    ended = true;
  };
  const raw = (path, options = {}) => request(base + preview + path, { ...options, headers: headersFor(id), cookie });
  try {
    for (const seconds of [idleTimeoutSeconds, maxLifetimeSeconds]) {
      assert(Number.isSafeInteger(seconds) && seconds > 0, 'Expected a positive timeout in seconds');
    }
    await run({ id, resource, raw, end, idleTimeoutSeconds,
      async step(path, options, expectedStep) {
        const envelope = await confirmed(await raw(path, options), schemas);
        assert.equal(envelope.session?.id, id);
        assert.equal(envelope.session.step, expectedStep);
        return envelope;
      },
      async rewind(step, expected = 204) {
        await status(await request(resource + '/rewind', { method: 'POST', cookie, body: { step } }), expected);
      },
    });
  } finally { await end(); }
}

/** The shared fixture supplies item CRUD, a one-second GET ?hold=true, and the SQL reader (spec/conformance/fixture.md). */
export async function sessions(t, request, schemas, binding, database, { capabilities, admin, viewer }) {
  await t.test('Preview sessions hold SQL steps, isolate callers, rewind and roll back', {
    skip: !capabilities.previewSessions && 'previewSessions is not advertised',
  }, async () => {
    const row = { id: 'session-item', name: 'Initial' };
    const path = '/items/' + row.id;
    await withSession(request, schemas, { base, cookie: admin }, async session => {
      const { id, resource, step, raw, rewind } = session;
      const missing = randomBytes(16).toString('hex');
      for (const [sessionId, cookie] of [[id, viewer], [missing, admin]]) {
        await problem(await request(base + preview + path, { headers: headersFor(sessionId), cookie }), 404, 'session_not_found');
        await problem(await request(base + collection + '/' + sessionId, { method: 'DELETE', cookie }), 404, 'session_not_found');
      }

      const created = await step('/items', { method: 'POST', body: row }, 1);
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, row);
      assert.deepEqual(created.changes.map(change => change.operation), ['insert']);
      assert(created.effects.some(effect => effect.kind === 'email' && effect.delivered !== true));
      if (binding.database === 'sqlite') {
        const started = performance.now();
        const busy = await problem(await request(base + collection, { method: 'POST', cookie: admin }), 409, 'store_busy');
        assert(performance.now() - started < 5000, 'SQLite contention must be reported within five seconds');
        assert.equal(busy.idleTimeoutSeconds, session.idleTimeoutSeconds);
        assert(busy.title && busy.detail);
      }
      const updated = await step(path, { method: 'PATCH', body: { name: 'Changed' } }, 2);
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.body, { ...row, name: 'Changed' });
      assert.deepEqual(updated.changes.map(change => change.operation), ['update']);
      assert.deepEqual(updated.effects, []);
      assert(!updated.logs.some(log => log.message.includes('created:' + row.id)));
      const read = await step(path, {}, 3);
      assert.deepEqual(read.body, updated.body);
      assert.deepEqual(read.changes, []);
      await rewind(0, 400);
      await rewind(5, 400);
      await rewind(4); // The next step is in range and discards nothing.
      await rewind(2);

      const overlapping = await Promise.all([raw(path + '?hold=true'), raw(path + '?hold=true')]);
      assert.deepEqual(overlapping.map(r => r.status).sort(), [200, 409]);
      await problem(overlapping.find(r => r.status === 409), 409, 'session_busy');
      const kept = await confirmed(overlapping.find(r => r.status === 200), schemas);
      assert.equal(kept.session?.id, id);
      assert.equal(kept.session.step, 2);
      assert.deepEqual(kept.body, row, 'Rewind retains the original insert and discards the update');
      assert.deepEqual(kept.changes, []);
      await session.end();
      await problem(await request(resource, { method: 'DELETE', cookie: admin }), 404, 'session_not_found');
    });
    await status(await request(base + path, { cookie: admin }), 404);
    if (database.query) assert.deepEqual(await database.query("SELECT id FROM items WHERE id = 'session-item'"), []);
  });
}

/** Check the transaction from both sides of the real store connection. A guard refusal must undo the SQL insert too. */
export async function sessionStores(t, request, schemas, capabilities, cookie, readers, guardedStore) {
  if (!readers.mongodb && !guardedStore) return;
  await t.test('Preview session holds MongoDB writes and recovers from guarded writes when configured', {
    skip: !capabilities.previewSessions && 'previewSessions is not advertised',
  }, async () => {
    const draft = { id: 'session-doc', name: 'Draft', city: 'York' };
    const find = () => readers.mongodb.find('documents', { _id: draft.id });
    await withSession(request, schemas, { base, cookie }, async ({ raw, step }) => {
      let next = 1;
      if (readers.mongodb) {
        const insert = await step('/documents', { method: 'POST', body: { ...draft, password: 'draft-secret' } }, next++);
        assert.equal(insert.status, 201);
        assert(insert.changes.some(change => change.store === 'mongodb' && change.operation === 'insert'));
        assert.deepEqual(await find(), []);
      }
      if (guardedStore) {
        const id = 'session-blocked';
        const blocked = await raw('/items/' + id + '/remember?store=' + guardedStore, { method: 'POST', body: { name: 'Blocked' } });
        assert.equal((await problem(blocked, 409, 'preview_unavailable')).store, guardedStore);
        assert.equal((await step('/items/' + id, {}, next++)).status, 404);
      }
      if (readers.mongodb) {
        const read = await step('/documents/' + draft.id, {}, next);
        assert.deepEqual(read.body, draft);
        assert.deepEqual(read.changes, []);
      }
    });
    if (readers.mongodb) assert.deepEqual(await find(), []);
  });
}

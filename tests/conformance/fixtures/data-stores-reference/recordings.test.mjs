/**
 * Replays the recorded Cosmos DB and Firestore requests (spec/data-stores/recordings/) through the
 * reference hooks over a fake transport, as each binding's unit tests do for its own hooks. In a
 * Preview a write never reaches the transport and marks the Preview blocked; reads and session calls
 * pass through and reads are logged without values. Outside a Preview everything passes through.
 *
 *   node --test tests/conformance/fixtures/data-stores-reference/recordings.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PreviewWriteBlockedError, withScope } from './guard.mjs';
import { hookedCosmos, hookedFirestore } from './hooks.mjs';

const recordings = name => JSON.parse(readFileSync(new URL(`../../../../spec/data-stores/recordings/${name}.json`, import.meta.url), 'utf8'));
const cosmos = recordings('cosmosdb');
const firestore = recordings('firestore');

/** Names, not values: a Cosmos query's text and parameter names, and Firestore collection, field and alias names. */
const names = new Set(['query', 'name', 'collectionId', 'fieldPath', 'alias']);

/** String values in a request body (parameter values, field values, document paths): none may appear in a Db entry. */
function leaves(value, key) {
  if (Array.isArray(value)) return value.flatMap(item => leaves(item, key));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([name, inner]) => leaves(inner, name));
  return typeof value === 'string' && !names.has(key) && value.length > 1 ? [value] : [];
}

/**
 * Replays every request of every recording through `send` inside a Preview scope. `call(send, request)`
 * sends one request; `body(request)` is its body; `expected(request)` is its `{ kind, operation }`.
 */
async function replay(store, file, { hook, call, body, expected }) {
  let checked = 0;
  for (const recording of file.recordings) {
    const reached = [];
    const send = hook((...args) => { reached.push(args); return { status: 200 }; });
    await withScope({ preview: true }, async scope => {
      for (const request of recording.requests) {
        const { kind, operation } = expected(request);
        const label = `${recording.name}: ${operation}`;
        const before = reached.length;
        const logs = scope.logs.length;
        if (kind === 'write') {
          await assert.rejects(call(send, request), error => error instanceof PreviewWriteBlockedError && error.store === store && error.operation === operation, label);
          assert.equal(reached.length, before, `${label} must not reach the store`);
          assert.equal(scope.blocked?.store, store, `${label} must mark the Preview blocked`);
        } else {
          await call(send, request);
          assert.equal(reached.length, before + 1, `${label} must reach the store`);
          if (kind === 'read') {
            const entry = scope.logs.slice(logs).find(item => item.level === 'Db' && item.db.operation === operation);
            assert(entry, `${label} must be logged`);
            for (const value of leaves(body(request))) assert(!JSON.stringify(entry).includes(value), `${label} must not log ${value}`);
          } else {
            assert.equal(scope.logs.length, logs, `${label} is session state and isn't logged`);
          }
        }
        checked++;
      }
    });
    // Outside a Preview nothing is refused, writes included.
    const unguarded = [];
    const plain = hook((...args) => { unguarded.push(args); return { status: 200 }; });
    for (const request of recording.requests) await call(plain, request);
    assert.equal(unguarded.length, recording.requests.length, `${recording.name} must run outside a Preview`);
  }
  return checked;
}

for (const level of ['http', 'sdk']) {
  test(`Cosmos DB recordings through a ${level}-level hook`, async () => {
    const checked = await replay('cosmosdb', cosmos, {
      hook: transport => hookedCosmos(transport, { level }),
      call: (send, request) => send(request),
      body: request => request.http.body,
      expected: request => request.expect[level],
    });
    assert(checked >= 20);
  });
}

test('Firestore recordings through a gRPC interceptor', async () => {
  const checked = await replay('firestore', firestore, {
    hook: hookedFirestore,
    call: (send, request) => send(request.rpc, request.rest.body),
    body: request => request.rest.body,
    expected: request => request.expect,
  });
  assert(checked >= 15);
});

test('The recordings cover reads, writes and the cases the tables single out', () => {
  const cosmosNames = cosmos.recordings.map(item => item.name);
  for (const name of ['execute a stored procedure', 'create a document with a pre-trigger', 'run a transactional batch', 'run bulk operations', 'patch a document', 'query documents']) {
    assert(cosmosNames.includes(name), `Cosmos DB recordings need "${name}"`);
  }
  const kinds = firestore.recordings.flatMap(item => item.requests.map(request => request.expect.kind));
  assert(['read', 'write', 'session'].every(kind => kinds.includes(kind)), 'Firestore recordings need read, write and session requests');
});

test('A hook that is not installed lets recorded writes through (the negative case)', async () => {
  const reached = [];
  const transport = entry => { reached.push(entry); return { status: 200 }; };
  await withScope({ preview: true }, async scope => {
    for (const recording of cosmos.recordings) for (const request of recording.requests) await transport(request);
    assert.equal(scope.blocked, null, 'Without the hook nothing marks the Preview');
  });
  const writes = cosmos.recordings.flatMap(item => item.requests).filter(request => request.expect.http.kind === 'write');
  assert(writes.every(request => reached.includes(request)), 'Without the hook every recorded write reaches the store, so the replay checks above would fail');
});

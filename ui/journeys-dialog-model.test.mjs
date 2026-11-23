import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, formatList, t } from './i18n.js';
import { changeFacts, changeRef, heldBy, moreIn, personaRoles, readsOnly, refForId, sendTargets, shortId, stepAccess } from './journeys-dialog-model.js';
import { endRunBody, factText, heldText, leftParts, moreText, sessionStores, spanText, stepList, undoSub } from './journeys-dialogs.js';

configure({ language: 'en-IE' });

const capabilities = { database: { name: 'store-demo.db', system: 'sqlite' } };
const journey = {
  steps: [
    { stepId: 'place', expected: { writes: [{ table: 'Orders', op: 'insert' }, { table: 'Orders', op: 'update' }, { table: 'Payments', op: 'insert' }, { store: 'mongodb', collection: 'order_events', op: 'insert' }], effects: [{ kind: 'email', to: '$inputs.customerEmail' }] } },
    { stepId: 'find', expected: { writes: [] } },
    { stepId: 'ship', expected: { writes: [{ table: 'Shipments', op: 'insert' }, { store: 'redis', key: 'order:1', op: 'set' }], effects: [{ kind: 'email', to: 'ops@example.com' }, { kind: 'webhook' }] } },
    { stepId: 'check' },
  ],
};

test('a Send run lists a row per store the expectations write to, with real counts and the places they land', () => {
  const targets = sendTargets(journey, capabilities, { inputs: { customerEmail: 'priya.raman@example.com' } });
  assert.deepEqual(targets.map(target => target.system), ['sqlite', 'mongodb', 'redis', 'email', 'effect']);
  const [sqlite, mongo, redis, email, effect] = targets;
  assert.deepEqual({ records: sqlite.records, places: sqlite.places, database: sqlite.database }, { records: 4, places: ['Orders', 'Payments', 'Shipments'], database: 'store-demo.db' });
  assert.deepEqual({ records: mongo.records, places: mongo.places, database: mongo.database }, { records: 1, places: ['order_events'], database: undefined });
  assert.deepEqual({ records: redis.records, places: redis.places, kind: redis.kind }, { records: 1, places: [], kind: 'key' }, 'a key is counted but is not a place');
  assert.deepEqual({ emails: email.emails, recipients: email.recipients }, { emails: 2, recipients: ['priya.raman@example.com', 'ops@example.com'] });
  assert.deepEqual({ effect: effect.effect, count: effect.count }, { effect: 'webhook', count: 1 });
});

test('a recipient the run can’t resolve yet is left out, and a journey with no expectations lists nothing', () => {
  const [, , , email] = sendTargets(journey, capabilities, { inputs: {} });
  assert.deepEqual(email.recipients, ['ops@example.com']);
  assert.deepEqual(sendTargets({ steps: [{ stepId: 'a' }] }, capabilities), []);
  assert.deepEqual(sendTargets(undefined, capabilities), []);
});

test('what a step held is counted from its own envelope, by store', () => {
  const held = heldBy({ changes: [{ table: 'Orders' }, { table: 'Payments' }, { store: 'mongodb', collection: 'order_events' }], effects: [{ kind: 'email' }, { kind: 'webhook' }] }, 'sqlite');
  assert.deepEqual(held, { stores: [{ system: 'sqlite', count: 2 }, { system: 'mongodb', count: 1 }], emails: 1, effects: 1, kinds: [{ kind: 'webhook', count: 1 }] });
  assert.equal(readsOnly(heldBy({ changes: [], effects: [] })), true);
  assert.equal(readsOnly(heldBy(undefined)), true);
  assert.equal(readsOnly(held), false);
});

test('personas name their roles as a list or one role', () => {
  assert.deepEqual(personaRoles({ roles: ['admin', 'support'] }), ['admin', 'support']);
  assert.deepEqual(personaRoles({ role: 'support' }), ['support']);
  assert.deepEqual(personaRoles({ name: 'Sam' }), []);
  assert.deepEqual(personaRoles(null), []);
});

const secured = (...alternatives) => ({ operation: { security: alternatives.map(roles => ({ cookie: roles })) } });
const document = { components: { securitySchemes: { cookie: { type: 'apiKey', in: 'cookie', name: 'sid' } } } };
const flow = { steps: [
  { stepId: 'place', op: secured(['admin'], ['support']) },
  { stepId: 'list', op: secured(['admin'], ['support']) },
  { stepId: 'capture', op: secured(['admin']) },
  { stepId: 'ship', op: secured(['admin']) },
  { stepId: 'get', op: { operation: {} } },
] };

test('the access bar knows which steps a role is refused only because the specification says so', () => {
  assert.deepEqual(stepAccess(flow, ['admin'], document), { allowed: [true, true, true, true, true], refused: [] });
  assert.deepEqual(stepAccess(flow, ['support'], document), { allowed: [true, true, false, false, true], refused: [2, 3] });
  assert.deepEqual(stepAccess(flow, ['SUPPORT'], document).refused, [2, 3], 'roles compare without case');
});

test('with no known role or no role named by the document, nothing is guessed', () => {
  assert.equal(stepAccess(flow, [], document), null, 'the persona has no known role');
  assert.equal(stepAccess({ steps: [{ stepId: 'a', op: { operation: {} } }, { stepId: 'b', op: secured([]) }] }, ['admin'], document), null, 'no step names a role');
  assert.equal(stepAccess({ steps: [{ stepId: 'a', op: { operation: { security: [{ cookie: [] }] } } }] }, ['admin'], document), null, 'signing in is enough');
  assert.equal(stepAccess({ steps: [] }, ['admin'], document), null);
});

test('step numbers read as people say them, and three in a row are a range', () => {
  assert.equal(stepList([0, 1]), '1 and 2');
  assert.equal(stepList([2, 3, 4]), '3 to 5');
  assert.equal(stepList([0, 1, 2, 4]), '1 to 3 and 5');
  assert.equal(stepList([4]), '5');
  assert.equal(stepList([3, 1]), '2 and 4');
  assert.equal(spanText(30_000), '30 seconds');
  assert.equal(spanText(120_000), '2 minutes');
  assert.equal(spanText(300_000), '5 minutes');
  assert.equal(t('dlg.endrun.held', { time: spanText(12_000) }), 'Held for 12 seconds');
});

test('the session notice names each store it rolled back with its kind', () => {
  assert.deepEqual(sessionStores({ database: { name: 'store.db', system: 'sqlite' } }), ['SQLite <bdi dir="ltr">store.db</bdi>']);
  const both = sessionStores({ database: { name: 'store.db', system: 'sqlite' }, dataStores: [{ system: 'mongodb', name: 'store', mode: 'preview' }, { system: 'redis', name: 'cache', mode: 'guard' }] });
  assert.deepEqual(both, ['SQLite <bdi dir="ltr">store.db</bdi>', 'MongoDB <bdi dir="ltr">store</bdi>']);
  assert.equal(formatList(both.map(item => item.replace(/<[^>]+>/g, ''))), 'SQLite store.db and MongoDB store');
});

test('the End run body says the step, both steps or all N steps', () => {
  assert.equal(endRunBody(1), 'Ending the held session rolls back the step. Nothing was written.');
  assert.equal(endRunBody(2), 'Ending the held session rolls back both steps. Nothing was written.');
  assert.equal(endRunBody(3), 'Ending the held session rolls back all 3 steps. Nothing was written.');
});

test('a step line lists what it wrote with commas, and names other effects only when nothing else was written', () => {
  const change = (store, table) => ({ store, table, operation: 'insert' });
  const wrote = { changes: [...Array.from({ length: 7 }, () => change('sqlite', 'Orders')), ...Array.from({ length: 3 }, () => change('mongodb', 'events'))], effects: [{ kind: 'email' }] };
  assert.equal(heldText(wrote, 'sqlite'), '7 rows, 3 documents, 1 email');
  assert.equal(heldText({ changes: [], effects: [{ kind: 'webhook' }, { kind: 'webhook' }, { kind: 'sms' }] }, 'sqlite'), '2 webhook, 1 sms');
  assert.equal(heldText({ changes: [change('sqlite', 'Orders')], effects: [{ kind: 'webhook' }] }, 'sqlite'), '1 row');
  assert.equal(heldText({ changes: [], effects: [] }, 'sqlite'), 'reads only');
  assert.deepEqual(heldBy({ changes: [], effects: [{ kind: 'webhook' }, { kind: 'email' }] }).kinds, [{ kind: 'webhook', count: 1 }]);
});

test('a change is named by its table and a business key, else a short ID, never a GUID or a status', () => {
  const guid = '4ef4416e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.deepEqual(changeRef({ after: { Id: guid, Number: 'AS-2026-004641', Status: 'Pending' } }), { ref: 'AS-2026-004641', field: 'number' });
  assert.deepEqual(changeRef({ after: { Id: guid, Sku: 'NPK-JKT-BLK-M', Quantity: 2 } }), { ref: 'NPK-JKT-BLK-M', field: 'sku' });
  assert.deepEqual(changeRef({ after: { Id: guid, Status: 'Pending' }, key: { Id: guid } }), { ref: '4ef4416e…', field: null });
  assert.deepEqual(changeRef({ after: { Number: guid }, key: { Id: 7 } }), { ref: '7', field: null });
  assert.deepEqual(changeRef({ after: { email: 'ada@acme.dev' } }), { ref: 'ada@acme.dev', field: 'email' });
  assert.deepEqual(changeRef({}), { ref: '', field: null });
  assert.equal(shortId(guid), '4ef4416e…');
  assert.equal(shortId('AS-1'), 'AS-1');
});

test('a change carries one or two telling facts, not the field it was named by', () => {
  assert.deepEqual(changeFacts({ after: { Number: 'AS-1', Status: 'pending', Total: 10 } }, 'number'), [{ kind: 'text', value: 'Pending' }]);
  assert.deepEqual(changeFacts({ after: { Sku: 'NPK', Quantity: 2, Status: 'Reserved' } }, null), [{ kind: 'text', value: 'Reserved' }, { kind: 'text', value: 'NPK' }]);
  assert.deepEqual(changeFacts({ after: { Sku: 'NPK', Quantity: 2 } }, 'sku'), [{ kind: 'units', n: 2 }]);
  assert.equal(factText({ kind: 'units', n: 2 }), '2 units');
  assert.equal(factText({ kind: 'units', n: 1 }), '1 unit');
});

test('the rest of a stop list is one line naming where it went', () => {
  const rest = [
    ...['Stock', 'Payments', 'AuditEvents', 'Stock', 'Stock', 'Payments', 'AuditEvents', 'AuditEvents'].map(target => ({ store: 'sqlite', target })),
    { store: 'mongodb', target: 'order_events' }, { store: 'mongodb', target: 'order_audit' },
  ];
  assert.deepEqual(moreIn(rest), { tables: ['Stock', 'Payments', 'AuditEvents'], stores: [{ system: 'mongodb', count: 2 }], emails: 0, effects: 0 });
  assert.equal(moreText(rest), '10 more in Stock, Payments, AuditEvents and 2 MongoDB collections');
  assert.equal(moreText([{ store: 'effect', target: 'email' }, { store: 'effect', target: 'email' }]), '2 more in 2 emails');
  assert.equal(moreText(['A', 'B', 'C', 'D', 'E'].map(target => ({ store: 'sqlite', target }))), '5 more in A, B, C and 2 more tables');
});

test('a stop row reads "Inserted by step 1" with its facts, and the undo row says which record', () => {
  const row = leftParts({ step: 1, store: 'sqlite', target: 'Orders', op: 'insert', ref: 'AS-2026-004641', facts: [{ kind: 'text', value: 'Pending' }] });
  assert.deepEqual([row.name, row.code, row.sub], ['Orders', 'AS-2026-004641', 'Inserted by step 1 · Pending']);
  assert.equal(undoSub({ step: 1, value: 'AS-2026-004641' }), 'Undoes step 1 for AS-2026-004641');
  assert.equal(undoSub({ step: 1, value: '4ef4416e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' }), 'Undoes step 1 for 4ef4416e…');
  assert.equal(undoSub({ step: 2 }), 'Undoes step 2');
  const guid = '6dfd316d-5a14-4828-91d0-f3bfe6181996';
  const changes = [{ table: 'OrderLines', key: { Id: 'x1' }, after: { Id: 'x1', OrderId: guid, Sku: 'NPK-JKT-BLK-M' } }, { table: 'Orders', key: { Id: guid }, after: { Id: guid, Number: 'AS-2026-004641' } }];
  assert.equal(refForId(changes, guid), 'AS-2026-004641', 'the change keyed by the ID names it, not one that only points at it');
  assert.equal(refForId([], guid), '6dfd316d…');
  assert.equal(undoSub({ step: 1, value: guid, ref: refForId(changes, guid) }), 'Undoes step 1 for AS-2026-004641');
});

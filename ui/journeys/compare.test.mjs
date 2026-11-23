// Built from docs/plans/journeys.md's "Order to shipment" example (the step 4 shipOrder write
// expectations, and the exact failure shown in the mocks: mocks/v7-journeys.js's shipCard,
// missCard and AD-0011).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareStep } from './compare.js';

const ORDER_ID = '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1';
const SHIPMENT_ID = '0d6f2b18-94c7-4a3e-b25d-7e81c4f09e3a';
const TRACKING = 'JD014600006282';

const context = {
  inputs: { shippingMethod: 'Express', variantId: 'variant-1', customerEmail: 'person@example.test' },
  steps: { placeOrder: { outputs: { orderId: ORDER_ID } } },
};

const expected = {
  writes: [
    { store: 'sqlite', table: 'Orders', op: 'update', key: { Id: '$steps.placeOrder.outputs.orderId' },
      values: { Status: { from: 'Paid', to: 'Shipped' }, ShippedAt: { type: 'date-time' }, ShippedBy: 'ada.admin@acme.dev' } },
    { store: 'sqlite', table: 'Shipments', op: 'insert',
      values: { OrderId: '$steps.placeOrder.outputs.orderId', Carrier: 'DHL', ServiceLevel: '$inputs.shippingMethod', TrackingNumber: { pattern: '^JD\\d{12}$' } } },
    { store: 'sqlite', table: 'InventoryMovements', op: 'insert',
      values: { VariantId: '$inputs.variantId', Reason: 'Shipped', Quantity: -2 } },
    { store: 'sqlite', table: 'StockReservations', op: 'delete', key: { OrderId: '$steps.placeOrder.outputs.orderId' } },
    { store: 'mongodb', collection: 'orders', op: 'update', key: { orderId: '$steps.placeOrder.outputs.orderId' },
      values: { status: { from: 'Paid', to: 'Shipped' } } },
    { store: 'mongodb', collection: 'order_events', op: 'insert', values: { type: 'order.shipped', orderId: '$steps.placeOrder.outputs.orderId' } },
  ],
  effects: [{ kind: 'email', to: '$inputs.customerEmail', subject: { pattern: 'shipped' } }],
  unlisted: 'fail',
};

const changes = [
  { operation: 'update', table: 'Orders', key: { Id: ORDER_ID }, before: { Status: 'Paid' }, after: { Status: 'Shipped', ShippedAt: '2026-11-21T14:02:11Z', ShippedBy: 'ada.admin@acme.dev' } },
  { operation: 'insert', table: 'Shipments', key: { Id: SHIPMENT_ID }, after: { OrderId: ORDER_ID, Carrier: 'DHL Express', ServiceLevel: 'Standard', TrackingNumber: TRACKING } },
  { operation: 'insert', table: 'InventoryMovements', key: { Id: 'move-1' }, after: { VariantId: 'variant-1', Reason: 'Shipped', Quantity: -2 } },
  // StockReservations is never deleted: this is the "missing" finding.
  { operation: 'update', store: 'mongodb', table: 'orders', key: { orderId: ORDER_ID }, before: { status: 'Paid' }, after: { status: 'Shipped' } },
  { operation: 'insert', store: 'mongodb', table: 'order_events', key: { _id: 'evt-1' }, after: { type: 'order.shipped', orderId: ORDER_ID } },
];
const effects = [{ kind: 'email', data: { to: 'person@example.test', subject: 'Your order has shipped' } }];
const approved = [{
  id: 'AD-0011', journey: 'orderToShipment', step: 'shipOrder',
  target: { store: 'sqlite', table: 'Shipments', field: 'Carrier' }, kind: 'value', expected: 'DHL', actual: 'DHL Express',
  reason: 'The carrier catalog renamed DHL to DHL Express in 2.1.', approvedBy: 'sam.support@acme.dev', approvedOn: '2026-11-12', expires: '2026-12-31',
}];

test('the step 4 example: ServiceLevel differs, StockReservations is missing, Carrier is covered by AD-0011, and five writes match', () => {
  const { verdict, findings } = compareStep({ expected, changes, effects, context, approved, ignore: [{ store: 'sqlite', table: '__EFMigrationsHistory' }], store: 'sqlite' });
  assert.equal(verdict, 'failed');
  assert.equal(findings.length, 7);

  const shipments = findings.find(f => f.target === 'Shipments');
  assert.equal(shipments.kind, 'differs');
  const serviceLevel = shipments.fields.find(f => f.name === 'ServiceLevel');
  assert.equal(serviceLevel.state, 'differs');
  assert.equal(serviceLevel.expected, 'Express');
  assert.equal(serviceLevel.actual, 'Standard');
  const carrier = shipments.fields.find(f => f.name === 'Carrier');
  assert.equal(carrier.state, 'approved');
  assert.equal(carrier.record, 'AD-0011');
  const orderId = shipments.fields.find(f => f.name === 'OrderId');
  assert.equal(orderId.state, 'match');
  const trackingNumber = shipments.fields.find(f => f.name === 'TrackingNumber');
  assert.equal(trackingNumber.state, 'match');

  const stockReservations = findings.find(f => f.target === 'StockReservations');
  assert.equal(stockReservations.kind, 'missing');

  const matches = findings.filter(f => f.kind === 'match');
  assert.equal(matches.length, 5, 'Orders, InventoryMovements, mongodb orders, mongodb order_events and the email effect');
  assert.ok(matches.some(f => f.target === 'Orders'));
  assert.ok(matches.some(f => f.target === 'InventoryMovements'));
  assert.ok(matches.some(f => f.store === 'mongodb' && f.target === 'orders'));
  assert.ok(matches.some(f => f.store === 'mongodb' && f.target === 'order_events'));
  assert.ok(matches.some(f => f.store === 'effect' && f.target === 'email'));

  // Every finding carries a stable id.
  assert.equal(new Set(findings.map(f => f.id)).size, findings.length);
});

test('an expired approved difference covers nothing: the field reports as plain differs', () => {
  const expired = [{ ...approved[0], expires: '2026-01-01' }];
  const clock = () => new Date('2026-11-22T00:00:00Z');
  const { findings } = compareStep({ expected: { writes: [expected.writes[1]] }, changes: [changes[1]], context, approved: expired, store: 'sqlite', clock });
  const carrier = findings[0].fields.find(f => f.name === 'Carrier');
  assert.equal(carrier.state, 'differs');
  assert.equal(carrier.record, undefined);
});

test('rows inserted with no key in the expectation match the captured changes in order', () => {
  const writes = [
    { store: 'sqlite', table: 'Lines', op: 'insert', values: { sku: 'A' } },
    { store: 'sqlite', table: 'Lines', op: 'insert', values: { sku: 'B' } },
  ];
  const rows = [
    { operation: 'insert', table: 'Lines', after: { sku: 'A' } },
    { operation: 'insert', table: 'Lines', after: { sku: 'B' } },
  ];
  const { verdict, findings } = compareStep({ expected: { writes }, changes: rows, context: {}, store: 'sqlite' });
  assert.equal(verdict, 'passed');
  assert.deepEqual(findings.map(f => f.fields[0].actual), ['A', 'B']);
});

test('an unlisted change is "extra" by default, excused by ignore, and either can be approved', () => {
  const migration = { operation: 'insert', table: '__EFMigrationsHistory', after: { MigrationId: '20261101' } };
  const stray = { operation: 'insert', table: 'AuditLog', after: { event: 'ship' } };
  const base = { expected: { writes: [] }, changes: [migration, stray], context: {}, store: 'sqlite' };

  const unexcused = compareStep(base);
  assert.equal(unexcused.verdict, 'failed');
  assert.equal(unexcused.findings.length, 2);
  assert.ok(unexcused.findings.every(f => f.kind === 'extra'));

  const ignored = compareStep({ ...base, ignore: [{ store: 'sqlite', table: '__EFMigrationsHistory' }] });
  assert.equal(ignored.findings.length, 1);
  assert.equal(ignored.findings[0].target, 'AuditLog');

  const approvedExtra = compareStep({
    ...base, ignore: [{ store: 'sqlite', table: '__EFMigrationsHistory' }],
    approved: [{ id: 'AD-9', kind: 'extra', target: { store: 'sqlite', table: 'AuditLog' } }],
  });
  assert.equal(approvedExtra.verdict, 'passed-approved');
  assert.equal(approvedExtra.findings[0].kind, 'approved');
  assert.equal(approvedExtra.findings[0].record, 'AD-9');

  const permissive = compareStep({ ...base, unlisted: 'ignore' });
  assert.deepEqual(permissive.findings, []);
  assert.equal(permissive.verdict, 'passed');
});

test('an approved "missing" record covers a write nothing matched', () => {
  const writes = [{ store: 'sqlite', table: 'StockReservations', op: 'delete', key: { OrderId: ORDER_ID } }];
  const { verdict, findings } = compareStep({
    expected: { writes }, changes: [], context,
    approved: [{ id: 'AD-20', kind: 'missing', target: { store: 'sqlite', table: 'StockReservations' } }], store: 'sqlite',
  });
  assert.equal(verdict, 'passed-approved');
  assert.equal(findings[0].kind, 'approved');
  assert.equal(findings[0].record, 'AD-20');
});

test('type matchers (uuid, integer, boolean, any) and a Redis-style key-as-target write', () => {
  const writes = [
    { store: 'sqlite', table: 'Tokens', op: 'insert', values: { id: { type: 'uuid' }, attempts: { type: 'integer' }, active: { type: 'boolean' }, meta: { type: 'any' } } },
    { store: 'redis', key: 'coupon:ABC:uses', op: 'INCR' },
  ];
  const changesList = [
    { operation: 'insert', table: 'Tokens', after: { id: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1', attempts: 3, active: true, meta: { any: 'thing' } } },
    { operation: 'INCR', store: 'redis', table: 'coupon:ABC:uses', after: { value: 2 } },
  ];
  const { verdict, findings } = compareStep({ expected: { writes }, changes: changesList, context: {}, store: 'sqlite' });
  assert.equal(verdict, 'passed');
  assert.ok(findings.every(f => f.kind === 'match'));
  assert.equal(findings[1].target, 'coupon:ABC:uses');
});

test('a "changed" matcher with the wrong before value differs, not matches', () => {
  const writes = [{ store: 'sqlite', table: 'Orders', op: 'update', values: { Status: { from: 'Paid', to: 'Shipped' } } }];
  const changesList = [{ operation: 'update', table: 'Orders', before: { Status: 'Draft' }, after: { Status: 'Shipped' } }];
  const { verdict, findings } = compareStep({ expected: { writes }, changes: changesList, context: {}, store: 'sqlite' });
  assert.equal(verdict, 'failed');
  assert.equal(findings[0].fields[0].state, 'differs');
});

test('expected effects that never arrive report as missing', () => {
  const { verdict, findings } = compareStep({
    expected: { effects: [{ kind: 'email', to: 'person@example.test' }] }, changes: [], effects: [], context: {}, store: 'sqlite',
  });
  assert.equal(verdict, 'failed');
  assert.equal(findings[0].kind, 'missing');
  assert.equal(findings[0].store, 'effect');
});

test('an email whose recipients are a list matches a single expected recipient', () => {
  const effects = [{ kind: 'email', data: { to: ['mia.customer@acme.dev'], cc: [], subject: 'Your order is on its way' } }];
  const { verdict, findings } = compareStep({
    expected: { effects: [{ kind: 'email', to: '$inputs.email', subject: { pattern: 'on its way' } }] },
    effects, context: { inputs: { email: 'mia.customer@acme.dev' } }, store: 'sqlite',
  });
  assert.equal(verdict, 'passed');
  assert.equal(findings[0].kind, 'match');
  assert.deepEqual(findings[0].fields.map(field => field.state), ['match', 'match']);
});

test('a Redis key written as a template with an embedded expression matches the command at that key', () => {
  const { verdict, findings } = compareStep({
    expected: { writes: [{ store: 'redis', key: 'quote:{$steps.priceCart.outputs.quoteId}', op: 'SET' }] },
    changes: [{ operation: 'SET', store: 'redis', table: 'quote:q-42', key: null, after: null }],
    context: { steps: { priceCart: { outputs: { quoteId: 'q-42' } } } }, store: 'sqlite',
  });
  assert.equal(verdict, 'passed');
  assert.equal(findings[0].target, 'quote:q-42');
  assert.equal(findings[0].kind, 'match');
});

test('MongoDB Extended JSON values compare as the plain values they stand for', () => {
  const { verdict, findings } = compareStep({
    expected: { writes: [{ store: 'mongodb', collection: 'order_events', op: 'insert',
      values: { at: { type: 'date-time' }, attempt: 2, eventId: 'evt-1' } }] },
    changes: [{ operation: 'insert', store: 'mongodb', table: 'order_events', key: { _id: { $oid: '65f0c1' } },
      after: { at: { $date: '2026-11-21T14:02:11.120Z' }, attempt: { $numberInt: '2' }, eventId: 'evt-1' } }],
    store: 'sqlite',
  });
  assert.equal(verdict, 'passed');
  assert.deepEqual(findings[0].fields.map(field => [field.name, field.state]), [['at', 'match'], ['attempt', 'match'], ['eventId', 'match']]);
  const numericDate = compareStep({
    expected: { writes: [{ store: 'mongodb', collection: 'c', op: 'insert', values: { at: { type: 'date-time' } } }] },
    changes: [{ operation: 'insert', store: 'mongodb', table: 'c', after: { at: { $date: { $numberLong: '1763733731120' } } } }],
    store: 'sqlite',
  });
  assert.equal(numericDate.verdict, 'passed');
});

test('an approved difference names a MongoDB target by collection and a Redis target by key', () => {
  const mongo = compareStep({
    expected: { writes: [{ store: 'mongodb', collection: 'order_events', op: 'insert', values: { type: 'order.shipped' } }] },
    changes: [{ operation: 'insert', store: 'mongodb', table: 'order_events', after: { type: 'order.dispatched' } }],
    approved: [{ id: 'AD-30', kind: 'value', target: { store: 'mongodb', collection: 'order_events', field: 'type' } }],
    store: 'sqlite',
  });
  assert.equal(mongo.verdict, 'passed-approved');
  assert.equal(mongo.findings[0].fields[0].record, 'AD-30');
  const redis = compareStep({
    expected: { writes: [{ store: 'redis', key: 'coupon:ACME10:uses', op: 'INCRBY' }] },
    approved: [{ id: 'AD-31', kind: 'missing', target: { store: 'redis', key: 'coupon:ACME10:uses' } }],
    store: 'sqlite',
  });
  assert.equal(redis.verdict, 'passed-approved');
});

test('a Redis write no change matches is matched against the step’s Db log entries, and missing when absent', () => {
  const expected = { writes: [
    { store: 'redis', key: 'quote:{$steps.priceCart.outputs.quoteId}', op: 'SET', values: { expiry: { type: 'any' } } },
    { store: 'redis', key: 'coupon:ACME10:uses', op: 'INCRBY' },
  ] };
  const context = { steps: { priceCart: { outputs: { quoteId: 'q-42' } } } };
  const logs = [
    { level: 'Information', message: 'Priced' },
    { level: 'Db', message: 'GET coupon:ACME10', db: { system: 'redis', operation: 'GET', target: 'coupon:ACME10' } },
    { level: 'Db', message: 'SET quote:q-42', db: { system: 'redis', operation: 'set', target: 'quote:q-42' } },
    { level: 'Db', message: 'INCRBY coupon:ACME10:uses', db: { system: 'redis', operation: 'INCRBY', target: 'coupon:ACME10:uses' } },
  ];
  const found = compareStep({ expected, logs, context, store: 'sqlite' });
  assert.equal(found.verdict, 'passed');
  assert.deepEqual(found.findings.map(f => [f.kind, f.target, f.via]), [['match', 'quote:q-42', 'log'], ['match', 'coupon:ACME10:uses', 'log']]);

  const absent = compareStep({ expected, logs: logs.slice(0, 3), context, store: 'sqlite' });
  assert.equal(absent.verdict, 'failed');
  assert.deepEqual(absent.findings.map(f => [f.kind, f.target]), [['match', 'quote:q-42'], ['missing', 'coupon:ACME10:uses']]);
});

test('a Db log entry matches on store, operation and target, claims once, and never when a change already matched', () => {
  const write = { store: 'redis', key: 'k', op: 'SET' };
  const entry = (system, operation, target) => ({ level: 'Db', message: 'x', db: { system, operation, target } });
  for (const logs of [[entry('dynamodb', 'SET', 'k')], [entry('redis', 'DEL', 'k')], [entry('redis', 'SET', 'other')], [{ level: 'Sql', message: 'SET', db: { system: 'redis', operation: 'SET', target: 'k' } }]]) {
    assert.equal(compareStep({ expected: { writes: [write] }, logs, store: 'sqlite' }).findings[0].kind, 'missing');
  }
  const twice = compareStep({ expected: { writes: [write, write] }, logs: [entry('redis', 'SET', 'k')], store: 'sqlite' });
  assert.deepEqual(twice.findings.map(f => f.kind), ['match', 'missing']);

  const withChange = compareStep({ expected: { writes: [write] }, changes: [{ operation: 'SET', store: 'redis', table: 'k', after: null }], logs: [entry('redis', 'SET', 'k')], store: 'sqlite' });
  assert.equal(withChange.findings[0].via, undefined);
});

test('a missing write approved by a record is still approved when no Db log entry matches', () => {
  const approved = [{ id: 'AD-9', journey: 'j', step: 's', target: { store: 'redis', table: 'k' }, kind: 'missing', reason: 'r', approvedBy: 'a', approvedOn: '2026-01-01' }];
  const { verdict, findings } = compareStep({ expected: { writes: [{ store: 'redis', key: 'k', op: 'SET' }] }, logs: [], approved, store: 'sqlite' });
  assert.equal(findings[0].kind, 'approved');
  assert.equal(verdict, 'passed-approved');
});

test('a Db log entry without a target never matches: matching is by store, op and key', () => {
  const entry = { level: 'Db', message: 'INCRBY', db: { system: 'redis', operation: 'INCRBY' } };
  const { findings } = compareStep({ expected: { writes: [{ store: 'redis', key: 'coupon:redemptions:ACME10', op: 'INCRBY' }] }, logs: [entry], store: 'sqlite' });
  assert.equal(findings[0].kind, 'missing');
});

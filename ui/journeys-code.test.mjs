import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csharpValue, draftApprovedDifference, expectWritesCode, refsFor } from './journeys-code.js';
import { compareStep } from './journeys/index.js';

const codeJourney = { id: 'orderToShipment', source: 'code', definedIn: { type: 'OrderToShipmentJourney' } };
const fileJourney = { id: 'orderToShipment', source: 'file' };
const differs = { id: 'write:1', kind: 'differs', store: 'sqlite', target: 'AuditEvents', op: 'insert', fields: [{ name: 'Action', state: 'differs', expected: 'Order.Shipped: DHL', actual: 'Order.Shipped: Ups' }] };
const today = new Date('2026-11-22T12:00:00Z');

test('C# values carry the column’s type', () => {
  assert.deepEqual(csharpValue('Dhl'), { type: 'string', literal: '"Dhl"' });
  assert.deepEqual(csharpValue('say "hi"\n'), { type: 'string', literal: '"say \\"hi\\"\\n"' });
  assert.deepEqual(csharpValue(3), { type: 'int', literal: '3' });
  assert.deepEqual(csharpValue(142.2), { type: 'decimal', literal: '142.2m' });
  assert.deepEqual(csharpValue(true), { type: 'bool', literal: 'true' });
  assert.equal(csharpValue('5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1').type, 'Guid');
  assert.equal(csharpValue('2026-11-22T14:02:07Z').type, 'DateTimeOffset');
  assert.equal(csharpValue(null).literal, 'null');
});

test('a journey defined in code gets the ApprovedDifference<T> object to paste', () => {
  const { language, text } = draftApprovedDifference({ journey: codeJourney, stepId: 'shipOrder', finding: differs, field: differs.fields[0], approvedBy: 'sam.support@acme.dev', today });
  assert.equal(language, 'csharp');
  assert.match(text, /public static readonly ApprovedDifference<string> AuditEventsActionChanged = new\(\)/);
  assert.match(text, /Actual = "Order\.Shipped: Ups",/);
  assert.match(text, /ApprovedBy = "sam\.support@acme\.dev",/);
  assert.match(text, /ApprovedOn = new DateOnly\(2026, 11, 22\),/);
  assert.match(text, /Expires = new DateOnly\(2027, 2, 20\),/);
  assert.match(text, /OrderToShipmentApprovedDifferences\.AuditEventsActionChanged/);
});

test('a file journey, or a missing write, gets the JSON record, which covers the finding it was drafted from', () => {
  const { language, text } = draftApprovedDifference({ journey: fileJourney, stepId: 'shipOrder', finding: differs, field: differs.fields[0], today });
  assert.equal(language, 'json');
  const record = JSON.parse(text);
  assert.deepEqual(record.target, { store: 'sqlite', table: 'AuditEvents', field: 'Action' });
  assert.equal(record.kind, 'value');
  assert.equal(record.expires, '2027-02-20');
  // The drafted record, committed, turns the same difference into an approved one.
  const expected = { writes: [{ store: 'sqlite', table: 'AuditEvents', op: 'insert', values: { Action: 'Order.Shipped: DHL' } }] };
  const changes = [{ operation: 'insert', table: 'AuditEvents', after: { Action: 'Order.Shipped: Ups' } }];
  const { verdict } = compareStep({ expected, changes, approved: [record], store: 'sqlite', clock: () => today });
  assert.equal(verdict, 'passed-approved');
  const missing = draftApprovedDifference({ journey: codeJourney, stepId: 'shipOrder', finding: { id: 'missing:3', kind: 'missing', store: 'mongodb', target: 'order_events', fields: [] }, today });
  assert.equal(missing.language, 'json', 'ApprovedDifference<T> relaxes values only');
  assert.deepEqual(JSON.parse(missing.text).target, { store: 'mongodb', table: 'order_events' });
});

test('Copy as C# writes a Preview’s changes as an ExpectWrites block, with refs for known values', () => {
  const run = { inputs: { customerEmail: 'mia@acme.dev', carrier: 'Ups' }, steps: [{ stepId: 'placeOrder', outputs: { orderId: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1' } }] };
  const refs = refsFor(codeJourney, run, 0);
  const code = expectWritesCode({
    stepVariable: 'shipOrder', refs,
    changes: [
      { operation: 'update', table: 'Orders', key: { Id: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1' }, before: { Status: 'Paid', UpdatedAt: '2026-11-22T14:00:00Z' }, after: { Status: 'Shipped', UpdatedAt: '2026-11-22T14:02:09Z' } },
      { operation: 'insert', table: 'Shipments', key: { Id: '0d6f2b18-94c7-4a3e-b25d-7e81c4f09e3a' }, after: { Id: '0d6f2b18-94c7-4a3e-b25d-7e81c4f09e3a', OrderId: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1', Carrier: 'Ups', Note: null } },
      { operation: 'insert', store: 'mongodb', table: 'order_events', key: { _id: 'x' }, after: { type: 'Shipment.Created' } },
    ],
    effects: [{ kind: 'email', data: { to: ['mia@acme.dev'], subject: 'On its way' } }],
  });
  assert.match(code, /^shipOrder\.ExpectWrites\(writes =>\n\{/);
  assert.match(code, /sql\.Update\(db => db\.Orders\)\n {8}\.Where\(o => o\.Id, orderId\)\n {8}\.Set\(o => o\.Status, Match\.Changed\("Paid", "Shipped"\)\)\n {8}\.Set\(o => o\.UpdatedAt, Match\.Any<DateTimeOffset>\(\)\);/);
  assert.match(code, /\.Set\(s => s\.OrderId, orderId\) \/\/ \$steps\.placeOrder\.outputs\.orderId/);
  assert.match(code, /\.Set\(s => s\.Carrier, journey\.Input\(i => i\.Carrier\)\);/);
  assert.doesNotMatch(code, /s\.Id,/, 'the new row’s own generated key is left out');
  assert.doesNotMatch(code, /Note/, 'null values are left out');
  assert.match(code, /mongo\.Insert<OrderEventDocument>\(\) \/\/ collection order_events/);
  assert.match(code, /writes\.Email\(\)\n {8}\.To\(journey\.Input\(i => i\.CustomerEmail\)\)\n {8}\.Subject\("On its way"\);/);
  assert.match(code, /\}\);$/);
  assert.match(expectWritesCode({}), /writes\.Nothing\(\);/);
});

test('MongoDB values: Extended JSON dates match any date, nested values are left out, _id is Id', () => {
  const code = expectWritesCode({ changes: [{ operation: 'update', store: 'mongodb', table: 'order_timelines', key: { _id: 'abc' },
    before: { events: [1], updatedAt: { $date: '2026-11-22T21:00:59Z' }, version: { $numberLong: '3' } },
    after: { events: [1, 2], updatedAt: { $date: '2026-11-22T21:01:00Z' }, version: { $numberLong: '4' } } }] });
  assert.match(code, /\.Where\(d => d\.Id, "abc"\)/);
  assert.match(code, /\.Set\(d => d\.UpdatedAt, Match\.Any<DateTime>\(\)\)/);
  assert.match(code, /\.Set\(d => d\.Version, Match\.Changed\(3, 4\)\);/);
  assert.doesNotMatch(code, /Events/);
});

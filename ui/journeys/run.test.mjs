import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRun, recordStep, skipRun, exportRun, toJUnit } from './run.js';

const journey = {
  workflowId: 'orderToShipment', summary: 'Order to shipment',
  steps: [
    { stepId: 'placeOrder', operationId: 'placeOrder', successCriteria: [{ condition: '$statusCode == 201' }], outputs: { orderId: '$response.body#/id' } },
    { stepId: 'shipOrder', operationId: 'shipOrder', successCriteria: [{ condition: '$statusCode == 201' }] },
  ],
};
const expectations = {
  journeys: { orderToShipment: { steps: { shipOrder: {
    writes: [{ store: 'sqlite', table: 'Shipments', op: 'insert', values: { Carrier: 'DHL' } }],
  } } } },
  approvedDifferences: [{
    id: 'AD-0011', journey: 'orderToShipment', step: 'shipOrder',
    target: { store: 'sqlite', table: 'Shipments', field: 'Carrier' }, kind: 'value', expected: 'DHL', actual: 'DHL Express', expires: '2099-01-01',
  }],
};

test('a run moves through its steps, binds outputs for later ones, and passes when everything matches or is approved', () => {
  const clock = () => new Date('2026-11-22T10:00:00Z');
  const run = createRun({ journey, expectations, inputs: {}, store: 'sqlite', clock });
  assert.equal(run.status, 'running');
  assert.equal(run.steps.length, 2);

  recordStep(run, 'placeOrder', { response: { statusCode: 201, body: { id: 'order-1' } }, envelope: {}, durationMs: 12 });
  assert.equal(run.steps[0].status, 'passed');
  assert.equal(run.status, 'running');

  recordStep(run, 'shipOrder', {
    response: { statusCode: 201 },
    envelope: { changes: [{ operation: 'insert', table: 'Shipments', after: { Carrier: 'DHL Express' } }] },
    durationMs: 20,
  });
  assert.equal(run.steps[1].status, 'passed', 'an approved difference still lets the step pass');
  assert.equal(run.status, 'passed');
  assert.equal(run.finishedAt, clock().toISOString());
  assert.deepEqual(run.approvedUsed, ['AD-0011']);
  assert.deepEqual(run.approvedUnused, []);
});

test('a refused step stops the run and skips what follows; a write mismatch alone does not stop it', () => {
  const run = createRun({ journey, expectations, store: 'sqlite' });
  recordStep(run, 'placeOrder', { response: { statusCode: 409 }, envelope: {} });
  assert.equal(run.steps[0].status, 'refused');
  assert.equal(run.steps[1].status, 'skipped');
  assert.equal(run.status, 'stopped');

  const run2 = createRun({ journey, expectations, store: 'sqlite' });
  recordStep(run2, 'placeOrder', { response: { statusCode: 201, body: { id: 'order-1' } }, envelope: {} });
  recordStep(run2, 'shipOrder', { response: { statusCode: 201 }, envelope: { changes: [{ operation: 'insert', table: 'Shipments', after: { Carrier: 'DHL Express 2' } }] } });
  assert.equal(run2.steps[1].status, 'failed', 'an unapproved write difference fails the step');
  assert.equal(run2.status, 'failed', 'but the run still runs every step');
});

test('a blocked Preview stops the run at that step', () => {
  const run = createRun({ journey, expectations, store: 'sqlite' });
  recordStep(run, 'placeOrder', { response: { statusCode: 201, body: { id: 'order-1' } }, envelope: {} });
  recordStep(run, 'shipOrder', { response: { statusCode: 409 }, envelope: { blocked: true } });
  assert.equal(run.steps[1].status, 'blocked');
  assert.equal(run.status, 'stopped');
});

test('an expired approved difference is reported as expired, not used', () => {
  const expired = { ...expectations, approvedDifferences: [{ ...expectations.approvedDifferences[0], expires: '2020-01-01' }] };
  const run = createRun({ journey, expectations: expired, store: 'sqlite' });
  recordStep(run, 'placeOrder', { response: { statusCode: 201, body: { id: 'order-1' } }, envelope: {} });
  recordStep(run, 'shipOrder', { response: { statusCode: 201 }, envelope: { changes: [{ operation: 'insert', table: 'Shipments', after: { Carrier: 'DHL Express' } }] } });
  assert.deepEqual(run.approvedExpired, ['AD-0011']);
  assert.deepEqual(run.approvedUsed, []);
});

test('exportRun gives a clean JSON snapshot, and toJUnit one testsuite with one testcase per step', () => {
  const run = createRun({ journey, expectations, store: 'sqlite' });
  recordStep(run, 'placeOrder', { response: { statusCode: 201, body: { id: 'order-1' } }, envelope: {}, durationMs: 5 });
  recordStep(run, 'shipOrder', { response: { statusCode: 500 }, envelope: {} });

  const exported = exportRun(run);
  assert.equal(JSON.stringify(exported).includes('Symbol'), false);
  assert.equal(exported.runId, run.runId);
  assert.equal(Object.getOwnPropertySymbols(exported).length, 0);

  const xml = toJUnit(run);
  assert.match(xml, /<testsuite name="Order to shipment" tests="2" failures="1" skipped="0"/);
  assert.match(xml, /<testcase name="placeOrder" classname="orderToShipment" time="0.005"\/>/);
  assert.match(xml, /<testcase name="shipOrder"[^]*<failure message="Criterion failed/);
});

test('skipRun marks a never-started run skipped, and toJUnit writes it as a testsuite of skipped cases', () => {
  const run = skipRun(createRun({ journey, expectations, mode: 'preview' }), 'Send only');
  assert.equal(run.status, 'skipped');
  assert.equal(run.skipReason, 'Send only');
  assert.ok(run.steps.every(step => step.status === 'skipped'));
  assert.equal(exportRun(run).status, 'skipped');
  const xml = toJUnit(run);
  assert.match(xml, /<testsuite name="Order to shipment" tests="2" failures="0" skipped="2"/);
  assert.equal(xml.match(/<skipped\/>/g).length, 2);
});

test('recordStep compares an expected Redis write with the envelope’s Db log entries', () => {
  const redisJourney = { workflowId: 'j', steps: [{ stepId: 'quote', operationId: 'q', successCriteria: [{ condition: '$statusCode == 200' }] }] };
  const redisExpectations = { journeys: { j: { steps: { quote: { writes: [{ store: 'redis', key: 'quote:q1', op: 'SET' }] } } } } };
  const logs = [{ level: 'Db', message: 'SET quote:q1', db: { system: 'redis', operation: 'SET', target: 'quote:q1' } }];
  const ok = createRun({ journey: redisJourney, expectations: redisExpectations });
  assert.equal(recordStep(ok, 'quote', { response: { statusCode: 200 }, envelope: { logs } }).status, 'passed');
  const missing = createRun({ journey: redisJourney, expectations: redisExpectations });
  assert.equal(recordStep(missing, 'quote', { response: { statusCode: 200 }, envelope: { logs: [] } }).status, 'failed');
});

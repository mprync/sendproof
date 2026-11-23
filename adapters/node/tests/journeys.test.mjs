import assert from 'node:assert/strict';
import test from 'node:test';
import { createBench, defineJourney, match } from '@sendproof/core';
import { fixtureJourneys, spec } from '../examples/fixture-service.mjs';
import arazzoGolden from '../examples/fixture.arazzo.json' with { type: 'json' };
import expectationsGolden from '../examples/fixture.expect.json' with { type: 'json' };

async function document(bench, path, basePath = '') {
  const response = await bench.lookup({
    method: 'GET', pathname: path.slice(basePath.length), basePath, headers: {}, origin: 'http://localhost:8000',
  });
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
}

const capabilities = '/sendproof/_api/capabilities';

test('code fixture publishes the golden Arazzo and expectations documents', async () => {
  const bench = createBench({ environment: 'Development', ...fixtureJourneys });
  const [entry] = (await document(bench, capabilities)).journeys;
  assert.deepEqual(entry, {
    name: 'Conformance journeys', source: 'code',
    arazzoUrl: '/sendproof/journeys/fixture.arazzo.json',
    expectationsUrl: '/sendproof/journeys/fixture.expect.json',
  });
  assert.deepEqual(await document(bench, entry.arazzoUrl), arazzoGolden);
  assert.deepEqual(await document(bench, entry.expectationsUrl), expectationsGolden);

  const base = '/tenant';
  const mounted = await document(bench, base + capabilities, base);
  assert.equal(mounted.journeys[0].arazzoUrl, base + entry.arazzoUrl);
  assert.equal(mounted.journeys[0].expectationsUrl, base + entry.expectationsUrl);
  const arazzo = await document(bench, mounted.journeys[0].arazzoUrl, base);
  assert.equal(arazzo.sourceDescriptions[0].url, mounted.openApiUrl);
});

test('step bindings, outputs, store expectations and approvals keep their document shape', async () => {
  const lookup = defineJourney({
    id: 'orders', name: 'Orders', summary: 'Find an order', group: 'Fulfilment', runAs: 'admin@example.test',
    inputs: { type: 'object', properties: { sku: { type: 'string' } } },
  }, ({ input, step, output, approveDifference }) => {
    const sku = input('sku');
    const first = step('create', 'createOrder')
      .body({ items: [{ sku }] })
      .succeedsWith(201);
    const id = first.output('id', '$response.body#/id');
    first.expectWrites({
      writes: [
        { store: 'sqlite', table: 'Orders', op: 'insert', values: { id, date: match.any('date-time') } },
        { store: 'mongodb', collection: 'orders', op: 'update', key: { id }, values: { status: match.changed('draft', 'new') } },
      ],
      effects: [{ kind: 'email', to: 'ops@example.test', subject: match.pattern('^Order') }],
    });
    step('lookup', 'getOrder')
      .set('path', 'id', id)
      .runAs('viewer@example.test')
      .succeedsWhen('$statusCode == 200 && $response.body#/status == "new"')
      .expectWrites({ writes: [{ store: 'redis', key: 'order:{$steps.create.outputs.id}', op: 'INCR' }] });
    output('orderId', id);
    approveDifference({
      id: 'AD-1', step: 'create', target: { store: 'mongodb', collection: 'orders', field: 'status' },
      kind: 'value', expected: 'new', actual: 'open', reason: 'Status was renamed',
      approvedBy: 'admin@example.test', approvedOn: '2026-11-20',
    });
  });
  const bench = createBench({
    environment: 'Development', journeys: [lookup],
    openApiDocument: { paths: {
      '/orders': { post: { operationId: 'createOrder' } },
      '/orders/{id}': { $ref: '#/components/pathItems/Order' },
    }, components: { pathItems: { Order: { get: { operationId: 'getOrder' } } } } },
  });
  const [entry] = (await document(bench, capabilities)).journeys;
  const [workflow] = (await document(bench, entry.arazzoUrl)).workflows;
  const id = '$steps.create.outputs.id';
  assert.equal(workflow.summary, 'Find an order');
  assert.deepEqual(workflow.outputs, { orderId: id });
  assert.deepEqual(workflow.steps[0].requestBody, { contentType: 'application/json', payload: { items: [{ sku: '$inputs.sku' }] } });
  assert.deepEqual(workflow.steps[0].outputs, { id: '$response.body#/id' });
  assert.deepEqual(workflow.steps[1].parameters, [{ in: 'path', name: 'id', value: id }]);
  assert.deepEqual(workflow.steps[1].successCriteria, [{ condition: '$statusCode == 200 && $response.body#/status == "new"' }]);

  const expectations = await document(bench, entry.expectationsUrl);
  const order = expectations.journeys.orders;
  assert.equal(order.group, 'Fulfilment');
  assert.equal(order.runAs, 'admin@example.test');
  assert.equal(order.sendOnly, true);
  assert.match(order.sendOnlyReason, /Redis/);
  assert.deepEqual(order.steps.create, {
    writes: [
      { store: 'sqlite', table: 'Orders', op: 'insert', values: { id, date: { type: 'date-time' } } },
      { store: 'mongodb', collection: 'orders', op: 'update', key: { id }, values: { status: { from: 'draft', to: 'new' } } },
    ],
    effects: [{ kind: 'email', to: 'ops@example.test', subject: { pattern: '^Order' } }],
    unlisted: 'fail',
  });
  assert.deepEqual(order.steps.lookup, {
    persona: 'viewer@example.test', writes: [{ store: 'redis', key: 'order:{' + id + '}', op: 'INCR' }], unlisted: 'fail',
  });
  assert.deepEqual(expectations.approvedDifferences, [{
    id: 'AD-1', journey: 'orders', step: 'create', target: { store: 'mongodb', collection: 'orders', field: 'status' },
    kind: 'value', expected: 'new', actual: 'open', reason: 'Status was renamed',
    approvedBy: 'admin@example.test', approvedOn: '2026-11-20',
  }]);
});

test('startup reports invalid operations and bindings and skips invalid journeys outside Development', async t => {
  const invalid = defineJourney({ id: 'broken', name: 'Broken' }, ({ input, step }) => {
    const first = step('first', 'unknownOperation');
    const later = step('later', 'getItem').output('id', '$response.body#/id');
    first.set('path', 'id', input('missingInput'));
    first.set('query', 'fromLater', later);
    first.set('query', 'fromMissing', '$steps.missing.outputs.id');
  });
  const good = defineJourney({ id: 'valid', name: 'Valid' }, ({ step }) => {
    step('read', 'getItem').set('path', 'id', 'known').succeedsWith(200);
  });
  const file = new URL('../examples/fixture.arazzo.json', import.meta.url);
  const options = { openApiDocument: spec, journeys: [invalid, good, file] };
  assert.throws(() => createBench({ ...options, environment: 'Development' }), error => {
    assert.match(error.message, /unknown operationId "unknownOperation"/);
    assert.match(error.message, /Unknown input "missingInput"/);
    assert.match(error.message, /\$steps\.later\.outputs\.id/);
    assert.match(error.message, /\$steps\.missing\.outputs\.id/);
    return true;
  });
  assert.throws(() => createBench({ environment: 'development', journeys: [good] }), /require openApiDocument/);

  const warn = t.mock.method(console, 'warn', () => {});
  const bench = createBench({ ...options, environment: 'production', environments: ['production'] });
  const { journeys } = await document(bench, capabilities);
  assert.deepEqual(journeys.map(entry => entry.source), ['file', 'code']);
  assert.deepEqual((await document(bench, journeys[0].arazzoUrl)), arazzoGolden);
  assert.deepEqual((await document(bench, journeys[1].arazzoUrl)).workflows.map(workflow => workflow.workflowId), ['valid']);
  assert(warn.mock.calls.some(({ arguments: [message] }) => message.includes('broken: Step "first": unknown operationId')));

  const onlyInvalid = createBench({ ...options, journeys: [invalid], environment: 'production', environments: ['production'] });
  assert.equal((await document(onlyInvalid, capabilities)).journeys, undefined);
});

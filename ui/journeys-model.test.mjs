import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations } from './api.js';
import { fixedValues, inferJourneys, inputControls, inputUsage, journeyGroups, journeysEnabled, loadJourneys, readJourneys, stepBindings, stepOperation, writeSummary, expectedStatus } from './journeys-model.js';
import { checkableExpectations } from './journeys.js';

const document = {
  openapi: '3.1.0',
  paths: {
    '/orders': { post: { operationId: 'Orders.Place', summary: 'Place order', responses: { 201: { description: 'Placed', links: { GetOrder: { operationId: 'Orders.Get', parameters: { id: '$response.body#/id' } } } } } } },
    '/orders/{id}': { get: { operationId: 'Orders.Get', summary: 'Get order', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The order' } } } },
    '/orders/{id}/shipments': { post: { operationId: 'Shipments.Create', summary: 'Ship order', parameters: [{ name: 'id', in: 'path', required: true }], responses: { 201: { description: 'Shipped' } } } },
  },
};
const ops = operations(document);
const arazzo = {
  arazzo: '1.1.0',
  sourceDescriptions: [{ name: 'store', url: '/openapi/v1.json', type: 'openapi' }],
  workflows: [
    {
      workflowId: 'orderToShipment', summary: 'Order to shipment',
      inputs: { type: 'object', properties: { customerId: { type: 'string', default: 'c1' }, carrier: { type: 'string', default: 'Dhl' }, email: { type: 'string' } } },
      steps: [
        { stepId: 'place', operationId: 'Orders.Place', requestBody: { payload: { customerId: '$inputs.customerId', currency: 'EUR' } }, successCriteria: [{ condition: '$statusCode == 201' }], outputs: { orderId: '$response.body#/id' } },
        { stepId: 'ship', operationId: '$sourceDescriptions.store.Shipments.Create', parameters: [{ name: 'id', in: 'path', value: '$steps.place.outputs.orderId' }], requestBody: { payload: { carrier: '$inputs.carrier' } }, successCriteria: [{ condition: '$statusCode == 201' }] },
        { stepId: 'check', operationPath: '{$sourceDescriptions.store.url}#/paths/~1orders~1{id}/get', parameters: [{ name: 'id', in: 'path', value: '$steps.place.outputs.orderId' }], successCriteria: [{ condition: '$statusCode == 200' }, { condition: "$response.body#/status == 'Shipped'" }] },
      ],
    },
    { workflowId: 'priceWithCoupon', summary: 'Price with a coupon', steps: [{ stepId: 'quote', operationId: 'Orders.Place' }] },
  ],
};
const expectations = {
  journeys: {
    orderToShipment: {
      group: 'Checkout', runAs: 'ada.admin@acme.dev', definedIn: { type: 'OrderToShipmentJourney', file: 'Journeys/OrderToShipmentJourney.cs' },
      steps: {
        place: { writes: [{ store: 'sqlite', table: 'Orders', op: 'insert', values: { CustomerId: '$inputs.customerId' } }, { store: 'mongodb', collection: 'order_events', op: 'insert' }], effects: [{ kind: 'email', to: '$inputs.email' }] },
        ship: { writes: [{ store: 'sqlite', table: 'Shipments', op: 'insert', values: { Carrier: 'Dhl' } }] },
        check: { writes: [] },
      },
    },
    priceWithCoupon: { group: 'Carts', steps: { quote: { writes: [{ store: 'redis', key: 'quote:{$steps.quote.outputs.id}', op: 'SET' }] } } },
  },
  approvedDifferences: [{ id: 'AD-1', journey: 'orderToShipment', step: 'ship', kind: 'value' }, { id: 'AD-2', journey: 'other', step: 'x', kind: 'value' }],
};

test('Journeys mode exists only when capabilities list journeys or hold Preview sessions', () => {
  assert.equal(journeysEnabled({}), false);
  assert.equal(journeysEnabled({ journeys: [] }), false);
  assert.equal(journeysEnabled({ journeys: [{ arazzoUrl: '/a' }] }), true);
  assert.equal(journeysEnabled({ previewSessions: true }), true);
  assert.equal(journeysEnabled(null), false);
});

test('a step finds its operation by operationId, a source-qualified id or an operationPath', () => {
  const [place, ship, check] = arazzo.workflows[0].steps;
  assert.equal(stepOperation(place, ops).operation.operationId, 'Orders.Place');
  assert.equal(stepOperation(ship, ops).operation.operationId, 'Shipments.Create');
  assert.equal(stepOperation(check, ops).operation.operationId, 'Orders.Get');
  assert.equal(stepOperation({ operationId: 'Nope' }, ops), null);
});

test('journeys read their group, persona, source and approved differences from the expectations document', () => {
  const journeys = readJourneys({ source: { name: 'Store journeys', source: 'code', arazzoUrl: '/a.json' }, arazzo, expectations, ops, capabilities: {} });
  const [order, coupon] = journeys;
  assert.equal(order.name, 'Order to shipment');
  assert.equal(order.group, 'Checkout');
  assert.equal(order.runAs, 'ada.admin@acme.dev');
  assert.equal(order.source, 'code');
  assert.deepEqual(order.approved.map(record => record.id), ['AD-1'], 'only this journey’s records');
  assert.deepEqual(order.outputs, ['orderId']);
  assert.equal(order.steps.every(step => step.op), true);
  assert.equal(order.sendOnly, false);
  assert.equal(coupon.sendOnly, true, 'a Redis write makes a journey Send only');
  assert.deepEqual(journeyGroups(journeys).map(([name]) => name), ['Checkout', 'Carts']);
});

test('what a step writes is counted by kind, and the expected status is read from its criteria', () => {
  const [order] = readJourneys({ source: {}, arazzo, expectations, ops, capabilities: {} });
  assert.deepEqual(writeSummary(order.steps[0].expected), { rows: 1, documents: 1, keys: 0, emails: 1, effects: 0 });
  assert.equal(writeSummary(order.steps[2].expected).rows, 0);
  assert.equal(expectedStatus(order.steps[0]), 201);
  assert.equal(expectedStatus(order.steps[2]), 200);
});

test('bindings say where each value comes from, and inputs say which steps use them', () => {
  const [order] = readJourneys({ source: {}, arazzo, expectations, ops, capabilities: {} });
  const ship = stepBindings(order.steps[1].def);
  assert.deepEqual(ship.map(binding => [binding.target, binding.from, binding.stepId]), [['path.id', 'step', 'place'], ['body/carrier', 'input', undefined]]);
  assert.deepEqual(fixedValues(order.steps[0].def), [{ target: 'body/currency', value: 'EUR' }]);
  assert.deepEqual(inputUsage(order), { customerId: [1], email: [1], carrier: [2] });
});

test('OpenAPI links give two-step journeys whose second step takes the first one’s output', () => {
  const [inferred] = inferJourneys(document, ops);
  assert.equal(inferred.inferred, true);
  assert.equal(inferred.name, 'Place order → Get order');
  assert.deepEqual(inferred.steps.map(step => step.op.operation.operationId), ['Orders.Place', 'Orders.Get']);
  assert.deepEqual(inferred.steps[0].def.outputs, { id: '$response.body#/id' });
  assert.deepEqual(inferred.steps[1].def.parameters, [{ name: 'id', in: 'path', value: '$steps.first.outputs.id' }]);
  assert.deepEqual(journeyGroups([inferred]).map(([, , isInferred]) => isInferred), [true]);
});

test('loading keeps every readable document and reports the ones that fail', async () => {
  const fetchJson = async url => {
    if (url === '/broken.arazzo.json') throw new Error('HTTP 500');
    return url.endsWith('.arazzo.json') ? arazzo : expectations;
  };
  const capabilities = { journeys: [{ name: 'Store', arazzoUrl: '/store.arazzo.json', expectationsUrl: '/store.expect.json' }, { name: 'Broken', arazzoUrl: '/broken.arazzo.json' }] };
  const loaded = await loadJourneys({ capabilities, document, ops, fetchJson });
  assert.deepEqual(loaded.journeys.filter(journey => !journey.inferred).map(journey => journey.id), ['orderToShipment', 'priceWithCoupon']);
  assert.equal(loaded.problems.length, 1);
  assert.match(loaded.problems[0].message, /500/);
  assert.equal(loaded.journeys.filter(journey => journey.inferred).length, 1, 'links are inferred beside published journeys');
});

test('writes to stores this host doesn’t hook, and an untraced Send, become Not checked', () => {
  const hooked = checkableExpectations(expectations, 'orderToShipment', { database: { system: 'sqlite' }, dataStores: [] });
  assert.deepEqual(hooked.expectations.journeys.orderToShipment.steps.place.writes.map(write => write.table), ['Orders']);
  assert.deepEqual(hooked.unchecked.place.map(finding => [finding.kind, finding.store, finding.target]), [['unchecked', 'mongodb', 'order_events']]);
  const untraced = checkableExpectations(expectations, 'orderToShipment', { database: { system: 'sqlite' } }, { traced: false });
  assert.equal(untraced.expectations.journeys.orderToShipment.steps.place.writes.length, 0);
  assert.equal(untraced.unchecked.place.length, 3, 'two writes and the email');
  assert.equal(expectations.journeys.orderToShipment.steps.place.writes.length, 2, 'the document itself is untouched');
});

test('a hooked Redis write stays checkable in a traced Send, where its commands arrive as Db log entries', () => {
  const redisExpectations = { journeys: { priceWithCoupon: { steps: { quote: { writes: [{ store: 'redis', key: 'quote:q1', op: 'SET' }] } } } } };
  const caps = { database: { system: 'sqlite' }, dataStores: [{ system: 'redis', mode: 'guard' }] };
  const traced = checkableExpectations(redisExpectations, 'priceWithCoupon', caps, { traced: true });
  assert.equal(traced.expectations.journeys.priceWithCoupon.steps.quote.writes.length, 1);
  assert.equal(traced.unchecked.quote, undefined);
  const without = checkableExpectations(redisExpectations, 'priceWithCoupon', { database: { system: 'sqlite' }, dataStores: [] });
  assert.equal(without.unchecked.quote[0].kind, 'unchecked');
});

test('an input bound to a step field with a lookup, an enum or a format uses that field’s control', () => {
  const customers = { url: '/customers?pageSize=100', valueField: 'id', labelField: 'name' };
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/orders': { post: { operationId: 'Orders.Place', responses: { 201: { description: 'Placed' } }, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Place' } } } } } },
      '/shipments': { post: { operationId: 'Shipments.Create', responses: { 201: { description: 'Shipped' } }, parameters: [{ name: 'carrier', in: 'query', schema: { type: 'string', enum: ['Ups', 'Dhl'] } }] } },
    },
    components: { schemas: { Place: { type: 'object', properties: { customerId: { type: 'string', format: 'uuid', 'x-lookup': customers }, items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string', 'x-lookup': { url: '/skus' } } } } } } } } },
  };
  const operationsList = operations(doc);
  const journey = readJourneys({ source: { name: 'x' }, ops: operationsList, expectations: {}, arazzo: { workflows: [{ workflowId: 'j', inputs: { type: 'object', properties: { customerId: { type: 'string' }, sku: { type: 'string' }, carrier: { type: 'string' }, note: { type: 'string' } } }, steps: [
    { stepId: 'place', operationId: 'Orders.Place', requestBody: { payload: { customerId: '$inputs.customerId', items: [{ sku: '$inputs.sku' }] } } },
    { stepId: 'ship', operationId: 'Shipments.Create', parameters: [{ name: 'carrier', in: 'query', value: '$inputs.carrier' }] },
  ] }] } })[0];
  const controls = inputControls(journey, doc);
  assert.deepEqual(controls.customerId, { format: 'uuid', 'x-lookup': customers }, 'a body field’s lookup and format');
  assert.deepEqual(controls.sku, { 'x-lookup': { url: '/skus' } }, 'a field inside an array item');
  assert.deepEqual(controls.carrier, { enum: ['Ups', 'Dhl'] }, 'a parameter’s enum');
  assert.equal(controls.note, undefined, 'an input no step field feeds stays a plain field');
});

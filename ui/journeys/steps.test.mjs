import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindStep, checkCriteria, stepOutputs } from './steps.js';

const context = { inputs: { shippingMethod: 'Express', customerEmail: 'ada@example.test' }, steps: { placeOrder: { outputs: { orderId: 'order-1' } } } };

test('bindStep resolves parameters by `in`, tracks input- and step-sourced bindings, and leaves a literal fixed', () => {
  const step = {
    stepId: 'shipOrder',
    parameters: [
      { name: 'id', in: 'path', value: '$steps.placeOrder.outputs.orderId' },
      { name: 'notify', in: 'query', value: 'true' },
      { name: 'X-Idempotency-Key', in: 'header', value: '$inputs.customerEmail' },
    ],
  };
  const { path, query, headers, bound } = bindStep(step, context);
  assert.deepEqual(path, { id: 'order-1' });
  assert.deepEqual(query, { notify: 'true' });
  assert.deepEqual(headers, { 'X-Idempotency-Key': 'ada@example.test' });
  assert.deepEqual(bound, [
    { target: 'path.id', expression: '$steps.placeOrder.outputs.orderId', value: 'order-1', from: 'step', stepId: 'placeOrder' },
    { target: 'header.X-Idempotency-Key', expression: '$inputs.customerEmail', value: 'ada@example.test', from: 'input' },
  ]);
});

test('bindStep binds a requestBody payload deeply and applies replacements, tracking every bound leaf', () => {
  const step = {
    stepId: 'shipOrder',
    requestBody: {
      payload: { orderId: '$steps.placeOrder.outputs.orderId', carrier: 'DHL', notifyCustomer: true, lines: [{ variantId: '$inputs.shippingMethod' }] },
      replacements: [{ target: '/carrier', value: 'DHL Express' }],
    },
  };
  const { body, bound } = bindStep(step, context);
  assert.deepEqual(body, { orderId: 'order-1', carrier: 'DHL Express', notifyCustomer: true, lines: [{ variantId: 'Express' }] });
  assert.deepEqual(bound, [
    { target: 'body/orderId', expression: '$steps.placeOrder.outputs.orderId', value: 'order-1', from: 'step', stepId: 'placeOrder' },
    { target: 'body/lines/0/variantId', expression: '$inputs.shippingMethod', value: 'Express', from: 'input' },
  ]);
});

test('checkCriteria evaluates "simple" comparisons, && and ||, against $statusCode and $response.body', () => {
  const response = { statusCode: 201, body: { status: 'Shipped', total: 42 } };
  const results = checkCriteria([
    { condition: '$statusCode == 201' },
    { condition: "$response.body#/status == 'Shipped'" },
    { condition: '$statusCode == 201 && $response.body#/total > 10' },
    { condition: '$statusCode == 404 || $response.body#/total == 42' },
    { condition: '$statusCode != 201' },
  ], response);
  assert.deepEqual(results.map(r => r.passed), [true, true, true, true, false]);
  assert.equal(results[0].actual, 201);
});

test('checkCriteria supports the jsonpath and regex criterion types, and reports xpath as unmet', () => {
  const response = { statusCode: 200, body: { items: [{ active: true }, { active: false }] } };
  const [jsonpathResult] = checkCriteria([{ type: 'jsonpath', condition: '$.items[?@.active==true]' }], response);
  assert.equal(jsonpathResult.passed, true);
  const [regexResult] = checkCriteria([{ type: 'regex', context: '$response.body#/items/0/active', condition: '^true$' }], { statusCode: 200, body: { items: [{ active: 'true' }] } });
  assert.equal(regexResult.passed, true);
  const [xpathResult] = checkCriteria([{ type: 'xpath', condition: '//status' }], response);
  assert.equal(xpathResult.passed, false);
});

test('stepOutputs reads the step\'s own response', () => {
  const step = { outputs: { orderId: '$response.body#/id', status: '$statusCode' } };
  assert.deepEqual(stepOutputs(step, { statusCode: 201, body: { id: 'order-1' } }), { orderId: 'order-1', status: 201 });
});

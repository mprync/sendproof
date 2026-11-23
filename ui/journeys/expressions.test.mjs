import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, interpolate } from './expressions.js';

const context = {
  inputs: { shippingMethod: 'Express', customer: { email: 'ada@example.test' } },
  steps: { placeOrder: { outputs: { orderId: 'order-1', order: { id: 'nested-1' } } } },
  request: { url: 'https://api.example.test/orders/order-1/ship', method: 'POST', path: { id: 'order-1' }, query: { notify: 'true' }, headers: { 'X-Trace': 'abc' }, body: { carrier: 'DHL' } },
  response: { statusCode: 201, headers: new Headers({ 'X-Request-Id': 'req-1' }), body: { id: 'ship-1', status: 'Shipped', items: [{ sku: 'A' }] } },
};

test('evaluate resolves every documented expression form', () => {
  assert.equal(evaluate('$inputs.shippingMethod', context), 'Express');
  assert.equal(evaluate('$inputs.customer.email', context), 'ada@example.test');
  assert.equal(evaluate('$steps.placeOrder.outputs.orderId', context), 'order-1');
  assert.equal(evaluate('$steps.placeOrder.outputs.order.id', context), 'nested-1');
  assert.equal(evaluate('$statusCode', context), 201);
  assert.equal(evaluate('$url', context), context.request.url);
  assert.equal(evaluate('$method', context), 'POST');
  assert.equal(evaluate('$response.body#/id', context), 'ship-1');
  assert.equal(evaluate('$response.body#/items/0/sku', context), 'A');
  assert.deepEqual(evaluate('$response.body', context), context.response.body);
  assert.equal(evaluate('$response.header.X-Request-Id', context), 'req-1');
  assert.equal(evaluate('$request.body#/carrier', context), 'DHL');
  assert.equal(evaluate('$request.query.notify', context), 'true');
  assert.equal(evaluate('$request.path.id', context), 'order-1');
  assert.equal(evaluate('$request.header.X-Trace', context), 'abc');
});

test('evaluate passes literals through unchanged and rejects an invalid expression', () => {
  assert.equal(evaluate('Express', context), 'Express');
  assert.equal(evaluate(42, context), 42);
  assert.equal(evaluate(null, context), null);
  assert.throws(() => evaluate('$not.a.real.expression', context), RangeError);
});

test('evaluate reads a plain-object response header case-insensitively', () => {
  const plain = { ...context, response: { ...context.response, headers: { 'x-request-id': 'req-2' } } };
  assert.equal(evaluate('$response.header.X-Request-Id', plain), 'req-2');
  assert.equal(evaluate('$response.header.Missing', plain), undefined);
});

test('interpolate evaluates a whole-expression string to its raw, typed value', () => {
  assert.equal(interpolate('$inputs.shippingMethod', context), 'Express');
  assert.equal(interpolate('$statusCode', context), 201);
  assert.deepEqual(interpolate('$response.body#/items', context), [{ sku: 'A' }]);
});

test('interpolate substitutes an embedded {$expr} inside a larger string, stringified', () => {
  assert.equal(interpolate('Ship {$steps.placeOrder.outputs.orderId} now', context), 'Ship order-1 now');
  assert.equal(interpolate('Status {$statusCode}', context), 'Status 201');
});

test('interpolate walks arrays and objects and leaves plain literals alone', () => {
  assert.deepEqual(
    interpolate({ orderId: '$steps.placeOrder.outputs.orderId', note: 'fixed', tags: ['x', '$inputs.shippingMethod'] }, context),
    { orderId: 'order-1', note: 'fixed', tags: ['x', 'Express'] },
  );
  assert.equal(interpolate('just a string', context), 'just a string');
  assert.equal(interpolate(true, context), true);
});

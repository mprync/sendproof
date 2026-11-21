import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure } from './i18n.js';
import { carriedValues, deprecationNotice, deprecationTip, noteSunsetHeader, replacements, sunsetOf } from './deprecation.js';

// Deprecated operations name their replacement (x-replaced-by, as a string or a list of links),
// carry matching parameters across, and say when they stop working (x-sunset, else the Sunset header).
const lookup = { 'x-lookup': { url: '/api/v2/accounts' } };
const op = (operationId, title, parameters = [], extra = {}) => ({ method: 'GET', path: '/' + operationId, title, parameters, operation: { operationId, summary: title, parameters, ...extra } });
const get = op('BalancesController.Get', 'Get balance', [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string', format: 'uuid', ...lookup } }]);
const list = op('BalancesController.List', 'List balances');
const legacy = (replacedBy, extra = {}) => op('BalancesController.LegacyBalance', 'Get account balance', [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid', ...lookup } }],
  { deprecated: true, 'x-replaced-by': replacedBy, ...extra });

test('x-replaced-by as a list of links carries parameters through runtime expressions', () => {
  configure({ language: 'en-IE' });
  const old = legacy([{ operationId: 'BalancesController.Get', parameters: { accountId: '$request.path.id' }, description: 'The same account.' }, { operationId: 'BalancesController.List' }], { 'x-sunset': '2027-06-30' });
  const ops = [get, list, old];
  const found = replacements(old, ops, {});
  assert.deepEqual(found.map(item => item.op.title), ['Get balance', 'List balances']);
  assert.deepEqual(found[0].carry, [{ to: 'accountId', toIn: 'path', from: 'id', fromIn: 'path' }]);
  assert.deepEqual(carriedValues(found[0], { 'path:id': 'e25dbc9d' }), { 'path:accountId': 'e25dbc9d' });
  const html = deprecationNotice(old, { ops, document: {}, where: 'try' });
  assert.match(html, /Stops working on <time datetime="2027-06-30">30 June 2027<\/time>/);
  assert.match(html, /Open <span lang="en">Get balance<\/span>/);
  assert.match(html, /Carries over <code>id<\/code> as <code>accountId<\/code>/);
  assert.match(html, /The same account\./);
  assert.match(deprecationNotice(old, { ops, document: {}, where: 'docs' }), /Try <span lang="en">Get balance<\/span>/);
  assert.equal(deprecationTip(old, ops, {}), 'Deprecated · sunset 30 Jun 2027 · Use Get balance or List balances.');
});

test('a plain operationId carries parameters with the same format and lookup', () => {
  const old = legacy('BalancesController.Get');
  const [found] = replacements(old, [get, old], {});
  assert.equal(found.op, get);
  assert.deepEqual(carriedValues(found, { 'path:id': 'abc' }), { 'path:accountId': 'abc' });
});

test('the Sunset header dates an operation whose spec has no x-sunset', () => {
  const old = legacy('BalancesController.Get');
  assert.equal(sunsetOf(old), undefined);
  assert.match(deprecationNotice(old, { ops: [get, old], document: {} }), /No sunset date in the spec/);
  noteSunsetHeader(old, { Sunset: 'Wed, 30 Jun 2027 00:00:00 GMT' });
  assert.equal(sunsetOf(old).iso, '2027-06-30');
  assert.equal(sunsetOf(legacy('x', { 'x-sunset': '2020-01-01' })).past, true);
});

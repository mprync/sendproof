import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backTarget, createHistory, followModel, formatRoute, isJourneyRoute, parseRoute, sameRoute } from './router.js';

test('every route round-trips through its hash', () => {
  const routes = [
    { kind: 'overview' },
    { kind: 'op', id: 'PaymentsController.Create' },
    { kind: 'docs', id: 'GET /api/v2/payments/{id}' },
    { kind: 'model', name: 'Payment' },
    { kind: 'model', name: 'Approval', from: { kind: 'docs', id: 'PaymentsController.Create' }, via: ['Payment'] },
    { kind: 'model', name: 'Account', from: { kind: 'op', id: 'a/b' }, via: ['Payment', 'Counterparty'] },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(formatRoute(route)), route, formatRoute(route));
  assert.equal(formatRoute({ kind: 'model', name: 'Payment', from: { kind: 'docs', id: 'PaymentsController.Create' } }), '#model/Payment?from=docs/PaymentsController.Create');
  assert.equal(formatRoute({ kind: 'model', name: 'Approval', from: { kind: 'docs', id: 'X' }, via: ['Payment', 'Other'] }), '#model/Approval?from=docs/X&via=Payment,Other');
});

test('unknown or malformed hashes mean the overview', () => {
  for (const hash of ['', '#', '#nowhere', '#op/', '#model', '#op/%E0%A4%A', undefined]) assert.deepEqual(parseRoute(hash), { kind: 'overview' }, String(hash));
  assert.deepEqual(parseRoute('#model/Payment?from=nonsense'), { kind: 'model', name: 'Payment' });
  assert.ok(sameRoute(parseRoute('#overview'), { kind: 'overview' }));
});

test('Back goes to the last followed model, then to the operation in the view it came from', () => {
  const deep = parseRoute('#model/Approval?from=docs/PaymentsController.Create&via=Payment,Counterparty');
  const first = backTarget(deep);
  assert.equal(formatRoute(first.route), '#model/Counterparty?from=docs/PaymentsController.Create&via=Payment');
  assert.deepEqual(first.label, { kind: 'model', name: 'Counterparty' });
  const second = backTarget(first.route);
  assert.equal(formatRoute(second.route), '#model/Payment?from=docs/PaymentsController.Create');
  const last = backTarget(second.route);
  assert.equal(formatRoute(last.route), '#docs/PaymentsController.Create');
  assert.deepEqual(last.label, { kind: 'op', id: 'PaymentsController.Create' });
  assert.equal(backTarget(last.route), null);
  assert.equal(backTarget({ kind: 'model', name: 'Payment' }), null, 'a model picked in the Models tab has no Back');
});

test('following a $ref grows the trail one step, and only for models opened from an operation', () => {
  const docs = { kind: 'docs', id: 'Op' };
  const first = followModel(docs, 'Payment');
  assert.equal(formatRoute(first), '#model/Payment?from=docs/Op');
  assert.equal(formatRoute(followModel(first, 'Approval')), '#model/Approval?from=docs/Op&via=Payment');
  assert.equal(formatRoute(followModel({ kind: 'op', id: 'Op' }, 'Payment')), '#model/Payment?from=op/Op');
  assert.equal(formatRoute(followModel({ kind: 'model', name: 'Payment' }, 'Approval')), '#model/Approval');
});

function fakeBrowser(initial = '#overview') {
  const entries = [{ url: initial, state: null }];
  let index = 0;
  const where = { get hash() { return entries[index].url; } };
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) { entries.splice(index + 1); entries.push({ url, state }); index++; },
    replaceState(state, _title, url) { entries[index] = { url, state }; },
    back() { index = Math.max(0, index - 1); },
  };
  return { history, location: where, entries, get index() { return index; } };
}

test('history entries record their place, the page before and the scroll they were left at', () => {
  const browser = fakeBrowser();
  const nav = createHistory(browser);
  assert.equal(nav.state.idx, 0);
  nav.saveScroll({ main: 480, aside: 0 });
  assert.equal(nav.go({ kind: 'model', name: 'Payment', from: { kind: 'docs', id: 'Op' } }), true);
  assert.equal(nav.state.idx, 1);
  assert.equal(nav.state.prev, '#overview');
  assert.equal(nav.go({ kind: 'model', name: 'Payment', from: { kind: 'docs', id: 'Op' } }), false, 'the same page is not pushed twice');
  assert.deepEqual(browser.entries[0].state.scroll, { main: 480, aside: 0 });
  assert.equal(nav.previousIs('#overview'), true);
  assert.equal(nav.previousIs('#docs/Op'), false, 'a reloaded or deep-linked page has no usable previous entry');
  nav.back();
  assert.equal(nav.url, '#overview');
});

test('a deep link has no previous entry in this session', () => {
  const nav = createHistory(fakeBrowser('#model/Payment?from=docs/Op'));
  assert.equal(nav.previousIs('#docs/Op'), false);
});

test('journey routes round-trip, with ids that need encoding', () => {
  const routes = [
    { kind: 'journeys' },
    { kind: 'journey', journey: 'orderToShipment' },
    { kind: 'jstep', journey: 'orderToShipment', step: 'shipOrder' },
    { kind: 'jrun', journey: 'Start cart→Get/cart', run: '7f3c-1' },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.equal(formatRoute({ kind: 'jstep', journey: 'a/b', step: 'c d' }), '#journey/a%2Fb/step/c%20d');
  assert.deepEqual(parseRoute('#journey/x/unknown/y'), { kind: 'overview' });
  assert.ok(isJourneyRoute(parseRoute('#journey/x')));
  assert.ok(!isJourneyRoute(parseRoute('#op/x')));
});

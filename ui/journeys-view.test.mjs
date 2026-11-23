import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedCard, comparison, criterionText, expectedPlain, overviewAside, problemSentence, runTime, runVerdict, short, stepBar, stoppedView, summaryMain, usedIn } from './journeys-view.js';
import { findingCounts } from './journeys-runs.js';

const journey = {
  id: 'orderToShipment', name: 'Order to shipment', source: 'code', expectations: {}, approved: [{ id: 'AD-0011', journey: 'orderToShipment', step: 'ship', kind: 'value', target: { store: 'sqlite', table: 'Shipments', field: 'Carrier' }, reason: 'Renamed.' }],
  steps: [
    { stepId: 'place', def: { stepId: 'place', successCriteria: [{ condition: '$statusCode == 201' }] }, op: { method: 'POST', path: '/orders', title: 'Place order' }, expected: { writes: [] } },
    { stepId: 'ship', def: { stepId: 'ship', successCriteria: [{ condition: '$statusCode == 201' }] }, op: { method: 'POST', path: '/shipments', title: 'Ship order' },
      expected: { writes: [{ store: 'sqlite', table: 'Shipments', op: 'insert', values: { ServiceLevel: '$inputs.speed', Carrier: 'DHL' } }, { store: 'sqlite', table: 'StockReservations', op: 'delete', key: { OrderId: '$steps.place.outputs.orderId' } }] } },
  ],
};
const shipped = {
  stepId: 'ship', status: 'failed', httpStatus: 201, durationMs: 58,
  criteria: [{ condition: '$statusCode == 201', passed: true, actual: 201 }],
  findings: [
    { id: 'write:0', kind: 'differs', store: 'sqlite', target: 'Shipments', op: 'insert', fields: [
      { name: 'ServiceLevel', state: 'differs', expected: 'Express', actual: 'Standard', source: 'expression' },
      { name: 'Carrier', state: 'approved', expected: 'DHL', actual: 'DHL Express', record: 'AD-0011' }] },
    { id: 'write:1', kind: 'missing', store: 'sqlite', target: 'StockReservations', op: 'delete', key: { OrderId: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1' }, fields: [] },
  ],
};
const run = { runId: '7f3c0000', mode: 'preview', status: 'failed', steps: [{ stepId: 'place', status: 'passed', httpStatus: 201, durationMs: 64, criteria: [], findings: [] }, shipped] };

test('the comparison leads with the verdict, filters by kind, and shows each problem and record', () => {
  const html = comparison(journey, 1, run);
  assert.match(html, /Step 2 failed/);
  assert.match(html, /Shipments\.ServiceLevel differs and nothing changed in StockReservations\./);
  assert.match(html, /data-cmp-filter="problems"[^>]*>.*Problems.*>2</s);
  assert.match(html, /data-finding-card="write:0"/);
  assert.match(html, /input · <bdi dir="ltr"><code dir="ltr">speed<\/code>/, 'a value from an input says so');
  assert.match(html, /id="ad-AD-0011"/, 'the approved-difference record used is shown');
  assert.match(html, /5e3a91c0…c2d1/, 'IDs are shortened in the middle');
  const problemsOnly = comparison(journey, 1, run, { filter: 'match' });
  assert.doesNotMatch(problemsOnly, /data-finding-card/, 'the Match filter hides the problem cards');
});

test('a run reads as one verdict, and its time is its steps’ own time', () => {
  assert.equal(runVerdict(run).long, 'Failed at step 2 of 2');
  assert.equal(runVerdict({ ...run, status: 'stopped', steps: [{ status: 'passed' }, { status: 'refused', findings: [] }] }).short, 'Stopped at step 2');
  assert.equal(runVerdict({ status: 'passed', steps: [{ status: 'passed', findings: [] }] }).short, 'Passed');
  // A run the person ended is neutral, worded for its mode, and never a failure.
  const ended = mode => ({ mode, cancelled: true, status: 'stopped', steps: [{ status: 'passed', findings: [] }, { status: 'skipped', findings: [] }] });
  assert.equal(runVerdict(ended('preview')).short, 'Ended after step 1 · rolled back');
  assert.equal(runVerdict(ended('send')).short, 'Stopped after step 1');
  assert.equal(runVerdict(ended('send')).ended, true);
  assert.equal(runTime(run), 122);
  assert.equal(problemSentence({ findings: [], criteria: [{ condition: "$response.body#/status == 'Shipped'", passed: false, actual: 'Paid' }] }), "$response.body#/status == 'Shipped' was Paid.");
});

test('the step bar offers the next step after one passed, and Run to end until the last', () => {
  const pending = { ...run, status: 'running', steps: [{ ...run.steps[0] }, { stepId: 'ship', status: 'pending', findings: [], criteria: [] }] };
  const first = stepBar(journey, pending, 0);
  assert.match(first, /data-action="journey-run-to-end"/);
  assert.match(first, /data-action="journey-next-run"[^>]*>.*Preview step 2/s);
  const second = stepBar(journey, pending, 1);
  assert.match(second, /data-action="preview"[^>]*>.*Preview step 2/s);
  const sendRun = stepBar(journey, { ...pending, mode: 'send' }, 1);
  assert.match(sendRun, /Preview step 2.*Send step 2/s, 'a Send run previews the step first, then sends it');
});

test('small readers: criteria, expected matchers, IDs and which steps use an input', () => {
  assert.equal(criterionText("$response.body#/status == 'Shipped'"), 'expects status Shipped');
  assert.equal(criterionText('$statusCode < 300'), '$statusCode < 300');
  assert.equal(expectedPlain({ from: 'Paid', to: 'Shipped' }), 'Paid → Shipped');
  assert.equal(expectedPlain({ pattern: '^JD\\d{13}$' }), 'matches ^JD\\d{13}$');
  assert.equal(expectedPlain({ type: 'date-time' }), 'any date-time');
  assert.equal(short('5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1'), '5e3a91c0…c2d1');
  assert.equal(usedIn([1, 4]), 'Used in steps 1 and 4');
  assert.equal(usedIn([2]), 'Used in step 2');
});

/* A step whose one write differs in three fields: every count says 3. */
const threeFields = {
  stepId: 'ship', status: 'failed', httpStatus: 201, durationMs: 58, criteria: [{ condition: '$statusCode == 201', passed: true, actual: 201 }],
  findings: [
    { id: 'write:0', kind: 'differs', store: 'sqlite', target: 'Shipments', op: 'insert', fields: [
      { name: 'Carrier', state: 'differs', expected: 'Dhl', actual: 'Ups' }, { name: 'TrackingNumber', state: 'differs', expected: { pattern: '^JD' }, actual: '1Z999AA100046418401' }, { name: 'OrderId', state: 'match', expected: 'a', actual: 'a' }] },
    { id: 'write:1', kind: 'differs', store: 'sqlite', target: 'AuditEvents', op: 'insert', fields: [{ name: 'Action', state: 'differs', expected: 'Order.Shipped: DHL', actual: 'Order.Shipped: Ups' }] },
    { id: 'write:2', kind: 'match', store: 'sqlite', target: 'Orders', op: 'update', fields: [] },
  ],
};
const threeRun = { runId: 'aaaa0000', startedAt: '2026-11-22T14:02:00Z', mode: 'preview', status: 'failed', steps: [{ stepId: 'place', status: 'passed', httpStatus: 201, durationMs: 1, criteria: [], findings: [] }, threeFields] };

test('a step’s problems are counted the same everywhere: each differing field, missing write and unmet criterion', () => {
  assert.equal(findingCounts(threeFields).problems, 3);
  assert.equal(findingCounts({ ...threeFields, criteria: [{ condition: '$statusCode == 200', passed: false, actual: 409 }] }).problems, 4);
  assert.match(problemSentence(threeFields), /^Shipments\.Carrier differs, Shipments\.TrackingNumber differs and AuditEvents\.Action differs\.$/);
  const comparisonHtml = comparison(journey, 1, threeRun);
  assert.match(comparisonHtml, /data-cmp-filter="problems"[^>]*>.*Problems.*>3</s, 'the filter');
  assert.match(comparisonHtml, /data-cmp-filter="all"[^>]*>.*All.*>4</s, 'the filter’s total adds the problems and the matches');
  const summary = summaryMain(journey, threeRun);
  assert.match(summary, /class="fd7 is-bad" title="3 problems"/, 'the step’s chip');
  assert.equal((summary.match(/<li><span class="fd7 is-bad/g) ?? []).length, 3, 'the open step lists three differences');
  assert.match(overviewAside(journey, [threeRun]), /3 problems/, 'the overview’s last run');
});

test('a matched write puts its detail under its name, and an email reads as plain text', () => {
  const email = { id: 'effect:0', kind: 'match', store: 'effect', target: 'email', op: 'send', fields: [
    { name: 'to', state: 'match', expected: 'mia.customer@acme.dev', actual: ['mia.customer@acme.dev'] },
    { name: 'subject', state: 'match', expected: { pattern: '^Your order' }, actual: 'Your order AS-2026-004641 is on its way' }] };
  const mongo = { id: 'write:3', kind: 'match', store: 'mongodb', target: 'order_timelines', op: 'update', fields: [{ name: 'updatedAt', state: 'match', expected: { type: 'date-time' }, actual: { $date: '2026-11-22T21:40:36.639Z' } }] };
  const html = comparison(journey, 1, { ...threeRun, steps: [threeRun.steps[0], { ...threeFields, findings: [email, mongo] }] }, { filter: 'match' });
  assert.match(html, /class="row-sub" title="to mia\.customer@acme\.dev · subject &quot;Your order AS-2026-004641 is on its way&quot;"/, 'one line, the whole text in its title');
  assert.doesNotMatch(html, /\[&quot;mia|\["mia/, 'no raw JSON array');
  assert.match(html, /class="mt7-main"><span class="mt7-l1"><span class="mt7-t" dir="ltr">email<\/span>/, 'the name leads');
  assert.match(html, /updatedAt 2026-11-22\u00a021:40:36/, 'Extended JSON dates read as the date');
  assert.doesNotMatch(html, /\$date/);
});

test('the open step’s values sit under their names with their whole text in a title', () => {
  const html = summaryMain(journey, threeRun);
  assert.match(html, /<span class="sm8-dv row-sub" title="matches \^JD → 1Z999AA100046418401">/);
  assert.match(html, /<span class="sm8-dv row-sub" title="Order\.Shipped: DHL → Order\.Shipped: Ups">/);
});

test('rows that pair a name with detail keep the detail under the name: the database a Send left, and approved differences', () => {
  const sent = [{ step: 1, store: 'sqlite', target: 'Orders', op: 'insert', detail: 'AS-2026-004641' }, { step: 2, store: 'effect', target: 'email', op: 'email', detail: 'Order confirmation' }];
  const stopped = stoppedView(journey, 1, { ...threeRun, mode: 'send', steps: [threeRun.steps[0], { ...threeFields, status: 'refused', httpStatus: 409 }] }, { leftBehind: sent });
  assert.match(stopped, /<span class="mt7-main"><span class="mt7-l1"><span class="mt7-t" dir="ltr">Orders<\/span>.*<span class="row-sub" title="AS-2026-004641">/s);
  assert.match(stopped, /<span class="row-sub" title="Order confirmation" lang="en">Order confirmation<\/span>/);
  const card = approvedCard(journey.approved[0], journey);
  assert.match(card, /<p class="ad7-what row-sub" title="Shipments\.Carrier"/, 'the record’s target is a subtitle under its ID');
});

test('the step bar’s status line is the natural sentence, with the same words as its tooltip', () => {
  const pending = { ...run, status: 'running', steps: ['place', 'ship'].map(stepId => ({ stepId, status: 'pending', findings: [], criteria: [] })) };
  const line = html => [...html.matchAll(/<span class="status[^"]*" title="([^"]*)">.*?<span>([^<]*)<\/span>/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(line(stepBar(journey, pending, 0)), [['From the journey’s inputs', 'From the journey’s inputs']]);
  assert.deepEqual(line(stepBar(journey, pending, 1)), [['From earlier steps', 'From earlier steps']]);
  assert.deepEqual(line(stepBar(journey, { ...pending, mode: 'send' }, 1)), [['Commits for real', 'Commits for real']]);
  const stopped = { ...pending, status: 'stopped', steps: [{ stepId: 'place', status: 'passed', findings: [], criteria: [] }, { stepId: 'ship', status: 'failed', findings: [], criteria: [] }] };
  assert.deepEqual(line(stepBar(journey, stopped, 1)), [['Step 2 stopped the run', 'Step 2 stopped the run']]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedStepIndex, findingCounts, lastRanStep, lastStatusOf, loadRuns, runEnded, recentRuns, RUNS_KEPT, runsStorageKey, saveRun, stepProblems, tallyEnvelope } from './journeys-runs.js';
import { openSession, SessionError, SESSION_HEADER } from './journeys-session.js';

const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
};

test('runs are kept per API document, newest first, at most 20 per journey', () => {
  const storage = memory();
  for (let i = 0; i < RUNS_KEPT + 3; i++) saveRun(storage, '/v1.json', { runId: `r${i}`, journeyId: 'a', startedAt: `2026-11-22T10:${String(i).padStart(2, '0')}:00Z`, steps: [] });
  saveRun(storage, '/v1.json', { runId: 'b1', journeyId: 'b', steps: [] });
  const all = loadRuns(storage, '/v1.json');
  assert.equal(all.a.length, RUNS_KEPT);
  assert.equal(all.a[0].runId, `r${RUNS_KEPT + 2}`);
  assert.equal(recentRuns(all, 'a')[0].runId, `r${RUNS_KEPT + 2}`);
  assert.deepEqual(loadRuns(storage, '/v2.json'), {}, 'another API keeps its own runs');
  saveRun(storage, '/v1.json', { runId: 'b1', journeyId: 'b', status: 'passed', steps: [] });
  assert.equal(loadRuns(storage, '/v1.json').b.length, 1, 'saving a run again replaces it');
  assert.notEqual(runsStorageKey('/a'), runsStorageKey('/b'));
});

test('unreadable or full storage forgets runs and never throws', () => {
  const broken = { getItem: () => '{oops', setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadRuns(broken, '/x'), {});
  assert.doesNotThrow(() => saveRun(broken, '/x', { runId: 'r', journeyId: 'a', steps: [] }));
  assert.deepEqual(loadRuns(null, '/x'), {});
});

const step = {
  status: 'failed',
  findings: [
    { kind: 'differs', target: 'Shipments', fields: [{ name: 'ServiceLevel', state: 'differs' }, { name: 'Carrier', state: 'approved', record: 'AD-0011' }, { name: 'OrderId', state: 'match' }] },
    { kind: 'missing', target: 'StockReservations', fields: [] },
    { kind: 'match', target: 'Orders', fields: [] },
    { kind: 'approved', target: 'AuditEvents', fields: [], record: 'AD-0007' },
    { kind: 'unchecked', target: 'quote', fields: [] },
  ],
};

test('a step’s findings are tallied as matched, approved, problems and not checked', () => {
  assert.deepEqual(findingCounts(step), { match: 1, approved: 2, problems: 2, unchecked: 1 });
  assert.deepEqual(findingCounts(undefined), { match: 0, approved: 0, problems: 0, unchecked: 0 });
});

test('a problem is a differing field, a missing or extra write or an unmet criterion, so every count agrees', () => {
  const many = { findings: [{ kind: 'differs', fields: [{ name: 'a', state: 'differs' }, { name: 'b', state: 'differs' }, { name: 'c', state: 'match' }] }, { kind: 'extra', fields: [] }], criteria: [{ passed: false }, { passed: true }] };
  assert.equal(findingCounts(many).problems, 4);
  assert.equal(findingCounts(many).problems, stepProblems(many).filter(item => item.kind !== 'approved').length + 1);
});

test('problems list each differing field and each missing write, then what was approved', () => {
  assert.deepEqual(stepProblems(step).map(item => [item.kind, item.finding.target, item.field?.name]), [
    ['differs', 'Shipments', 'ServiceLevel'], ['missing', 'StockReservations', undefined],
    ['approved', 'Shipments', 'Carrier'], ['approved', 'AuditEvents', undefined],
  ]);
});

test('the failed step is the first refused, failed or blocked one', () => {
  assert.equal(failedStepIndex({ steps: [{ status: 'passed' }, { status: 'refused' }, { status: 'skipped' }] }), 1);
  assert.equal(failedStepIndex({ steps: [{ status: 'passed' }] }), -1);
});

test('each store’s changes are tallied, SQL changes under sql', () => {
  let tally = tallyEnvelope(undefined, { changes: [{ table: 'Orders' }, { table: 'Lines' }, { store: 'mongodb', table: 'order_events' }], effects: [{ kind: 'email' }] });
  tally = tallyEnvelope(tally, { changes: [{ table: 'Payments' }] });
  assert.deepEqual(tally, { stores: { sql: 3, mongodb: 1 }, effects: 1 });
});

/** A fake host for the session protocol: records requests, answers as spec/README.md says. */
function fakeHost({ open = 201 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, keepalive: init.keepalive });
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (init.method === 'POST' && url.endsWith('/_api/sessions')) return open === 201 ? json(201, { id: 'a'.repeat(32), idleTimeoutSeconds: 300, maxLifetimeSeconds: 1800 }) : json(open, { title: 'Too many sessions', code: 'session_limit' });
    if (url.endsWith('/rewind')) return json(204);
    if (init.method === 'DELETE') return json(204);
    return json(404, {});
  };
  return { fetch, calls };
}

test('a session opens, keeps the steps that previewed, rewinds before a re-run and ends once', async () => {
  const host = fakeHost();
  const session = await openSession({ base: 'https://api.test/sendproof/', fetch: host.fetch });
  assert.deepEqual(session.header(), { [SESSION_HEADER]: 'a'.repeat(32) });
  assert.equal(host.calls[0].url, 'https://api.test/sendproof/_api/sessions');
  session.record({ status: 201, rolledBack: true, session: { step: 1 } });
  session.record({ status: 200, rolledBack: true, session: { step: 2 } });
  session.record({ status: 409, rolledBack: true, blocked: { store: 'redis' }, session: { step: 3 } });
  assert.equal(session.kept, 2, 'a blocked step leaves the session at the same step');
  await session.rewind(2);
  assert.deepEqual(JSON.parse(host.calls.at(-1).body), { step: 2 });
  assert.equal(session.kept, 1);
  await session.rewind(5);
  assert.equal(host.calls.filter(call => call.url.endsWith('/rewind')).length, 1, 'nothing to rewind past the next step');
  await session.end();
  await session.end();
  assert.equal(host.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(session.ended, true);
});

test('a run the person ended is not a failure; one that also has a failing step still is', () => {
  const steps = status => [{ status: 'passed' }, { status }];
  assert.equal(runEnded({ cancelled: true, status: 'stopped', steps: steps('skipped') }), true);
  assert.equal(runEnded({ status: 'stopped', steps: steps('refused') }), false);
  assert.equal(runEnded({ cancelled: true, status: 'stopped', steps: steps('failed') }), false);
  assert.equal(runEnded(undefined), false);
  assert.equal(lastRanStep({ steps: [{ status: 'passed' }, { status: 'passed' }, { status: 'skipped' }] }), 1);
  assert.equal(lastRanStep({ steps: [{ status: 'pending' }] }), -1);
});

test('the sidebar keeps the last finished verdict, a quiet "ended" when every run was ended, never red for it', () => {
  const ended = { cancelled: true, status: 'stopped', steps: [{ status: 'passed' }] };
  const failed = { status: 'failed', steps: [{ status: 'failed' }] };
  const passed = { status: 'passed', steps: [{ status: 'passed' }] };
  assert.equal(lastStatusOf([ended, passed]), 'passed');
  assert.equal(lastStatusOf([ended, failed, passed]), 'failed');
  assert.equal(lastStatusOf([ended, ended]), 'ended');
  assert.equal(lastStatusOf([]), null);
});

test('a refused session says why, with the problem’s code', async () => {
  await assert.rejects(openSession({ base: 'https://api.test/sendproof/', fetch: fakeHost({ open: 429 }).fetch }),
    error => error instanceof SessionError && error.code === 'session_limit' && error.status === 429 && /Too many/.test(error.message));
});

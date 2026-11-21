// Data stores in the workbench (spec/data-stores.md, mocks v6): the document diff tree, store
// groups in the Database tab, Db command logs, "Preview unavailable" before and during a run, and
// what discovery says about stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, docCard, tally, treeMarkup, valueMarkup } from './doc-diff.js';
import { coverageNote, databaseMarkup, groupsByStore } from './result-database.js';
import { logsMarkup, commandMarkup } from './result-logs.js';
import { actionBar, confirmation, previewDock } from './action-bar.js';
import { blockedHeader, blockedMarkup, blockedTab, previewFalseSnippet } from './result-blocked.js';
import { beforeRun, loadingBody, resultBar, resultCounts } from './result-states.js';
import { coverageMarkup } from './coverage-popover.js';
import { authorReason, blockedPreview, dataStores, previewUnavailable, recordCount, sqlSystem, storeMark, storeName } from './stores.js';
import { execute } from './api.js';

const oid = $oid => ({ $oid });
const date = $date => ({ $date });
const decimal = $numberDecimal => ({ $numberDecimal });
const before = {
  _id: oid('6740a1c2e5b8f1a9c4d3e201'), status: 'PendingApproval', amount: { value: decimal('50000.00'), currency: 'EUR' },
  beneficiary: { name: 'Northwind', screening: { status: 'Pending', provider: 'sanctions-eu' }, webhookSecret: '[REDACTED]' },
  fees: [{ type: 'SEPA', amount: decimal('0.20') }, { type: 'FX', amount: decimal('12.50') }],
  approvals: [], holdReason: 'Awaiting second approver', audit: { updatedAt: date('2026-11-20T09:15:03Z'), version: 3 },
};
const after = {
  _id: before._id, status: 'Approved', amount: before.amount,
  beneficiary: { ...before.beneficiary, screening: { status: 'Cleared', provider: 'sanctions-eu', checkedAt: date('2026-11-21T14:02:10Z') } },
  fees: [before.fees[0], { type: 'FX', amount: decimal('14.75') }, { type: 'Priority', amount: decimal('5.00') }],
  approvals: [{ by: 'ada.admin@acme.dev', signatureToken: '[REDACTED]' }], release: { rail: 'SEPA' },
  audit: { updatedAt: date('2026-11-21T14:02:11Z'), updatedBy: 'ada.admin@acme.dev', version: 4 },
};
const update = { operation: 'update', store: 'mongodb', namespace: 'treasury', table: 'payments', key: { _id: before._id }, before, after };

test('the document diff walks objects in order, compares arrays by index and counts changes per branch', () => {
  const rows = diffRows(before, after);
  const at = path => rows.find(row => row.path === path);
  assert.equal(at('status').kind, 'chg');
  assert.equal(at('amount').kind, 'same', 'an unchanged branch stays plain');
  assert.equal(at('amount').inner, 0);
  assert.equal(at('beneficiary').inner, 2, 'screening.status changed and checkedAt was added');
  assert.equal(at('fees[1].amount').kind, 'chg', 'arrays compare by index');
  assert.equal(at('fees[2]').kind, 'add');
  assert.ok(rows.filter(row => row.path.startsWith('fees[2].')).every(row => row.kind === 'add' && row.inherit), 'an added branch marks its contents');
  assert.equal(at('holdReason').kind, 'del');
  assert.ok(rows.findIndex(row => row.path === 'holdReason') < rows.findIndex(row => row.path === 'audit'), 'a removed key keeps its place');
  assert.deepEqual(tally(rows), { changed: 5, added: 5, removed: 1 }, 'status, screening.status, fees[1].amount, audit.updatedAt and audit.version');
});

test('values read as typed badges, a redacted pill and escaped JSON literals', () => {
  assert.match(valueMarkup(oid('abc')), /class="xt-t">ObjectId<\/span><span class="xt-v ltr">abc/);
  assert.match(valueMarkup(decimal('1.50')), />Decimal128</);
  assert.match(valueMarkup('[REDACTED]'), /class="redacted"[^>]*>.*redacted/);
  assert.doesNotMatch(valueMarkup('[REDACTED]'), /\[REDACTED\]/, 'the placeholder text itself never shows');
  assert.equal(valueMarkup('<b>'), '<span class="j-s ltr">"&lt;b&gt;"</span>');
  assert.match(valueMarkup(null), /j-null/);
});

test('an update opens on Diff with Changes only off; inserts, upserts, replacements and deletes say what they were', () => {
  const card = docCard(update, 3);
  assert.match(card, /data-doc-card="3"/);
  assert.match(card, /data-diff-view="diff" aria-pressed="true"/);
  assert.match(card, /data-diff-view="before" aria-pressed="false"/);
  assert.match(card, /data-diff-only aria-pressed="false"/);
  assert.match(card, /5 changed/);
  assert.match(card, /class="dt-k ltr">_id</, 'the key bar and the tree name the _id');
  assert.match(card, /class="dt-row is-chg/);
  assert.match(card, /dt-old.*→.*dt-new/s, 'old → new stay in one value cell');
  const insert = docCard({ operation: 'insert', via: 'upsert', store: 'mongodb', table: 'beneficiary_profiles', key: { _id: 'cp_1' }, before: null, after: { _id: 'cp_1', name: 'N', payments: 1 } });
  assert.match(insert, /via upsert/);
  assert.match(insert, /New document · 3 fields/);
  assert.doesNotMatch(insert, /data-diff-view/, 'only updates have Before and After');
  assert.doesNotMatch(insert, /is-add/, 'an insert marks rows without tinting them');
  assert.match(docCard({ ...update, via: 'replace' }), /whole document replaced/);
  assert.match(docCard({ operation: 'delete', store: 'redis', table: 'session', key: { key: 'session:42' }, before: { value: 'x' }, after: null }), /Key removed · 1 field/);
  assert.doesNotMatch(treeMarkup(update, 'before'), /is-chg|is-add|is-del/, 'Before is the document as it was, untinted');
  assert.match(treeMarkup(update, 'after'), /Approved/);
  assert.doesNotMatch(treeMarkup(update, 'after'), /PendingApproval/);
});

const sqlRow = { operation: 'update', table: 'Payments', key: { Id: '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13' }, before: { Status: 'PendingApproval' }, after: { Status: 'Approved' } };
const capabilities = {
  environment: 'Development', database: 'treasury-demo.db', identity: { name: 'Ada Admin' },
  dataStores: [{ system: 'mongodb', name: 'treasury', mode: 'preview' }, { system: 'redis', name: 'cache', mode: 'guard' }, { system: 'aws.dynamodb', name: 'idempotency', mode: 'guard' }],
};

test('one Preview groups its changes by store, SQL first, with a jump strip, read-only stores and coverage', () => {
  const result = {
    preview: true, status: 200, changes: [update, sqlRow], effects: [],
    logs: [{ level: 'Db', message: 'HMGET', db: { system: 'redis', operation: 'HMGET' } }],
  };
  assert.equal(groupsByStore(result, capabilities), true);
  const html = databaseMarkup(result, capabilities);
  assert.ok(html.indexOf('store-group-sql') < html.indexOf('store-group-mongodb'), 'SQL comes first');
  assert.match(html, /These are the changes this request would write to SQLite and MongoDB as Ada Admin/);
  assert.match(html, /data-store-jump="mongodb"[^]*1 document/);
  assert.match(html, /Read, not written:[^]*Redis/);
  assert.match(html, /<h3 id="store-group-mongodb">MongoDB<\/h3><code class="ltr">treasury<\/code>/);
  assert.match(html, /Transaction aborted/);
  assert.match(html, /<span class="k">Id<\/span> <span class="ltr">7d2e41a0…9f13<\/span>/, 'a grouped row card shows its key');
  assert.match(html, /Covered in <strong>Development<\/strong>:|Covered in Development:/);
  assert.match(html, /SQLite and MongoDB <code class="ltr">treasury<\/code> roll back; Redis <code class="ltr">cache<\/code> and DynamoDB <code class="ltr">idempotency<\/code> block writes/);
  assert.match(coverageNote(capabilities), /aren’t covered/);
  // Without stores the tab is the classic list of row cards (mocks 01 and 49 are unchanged).
  const classic = databaseMarkup({ preview: true, status: 201, changes: [sqlRow], effects: [], logs: [] }, { database: 'treasury.db' });
  assert.doesNotMatch(classic, /class="sg"|data-store-jump|class="cov"/);
  assert.match(classic, /1 row/);
});

const dbLogs = [
  { level: 'Information', category: 'Microsoft.AspNetCore.Hosting.Diagnostics', message: 'Request starting', offsetMs: 0 },
  { level: 'Sql', message: 'SELECT 1', offsetMs: 1, elapsedMs: 0.5, sql: { text: 'SELECT 1', parameters: [] } },
  { level: 'Db', message: 'update payments', offsetMs: 2, elapsedMs: 1.8, db: { system: 'mongodb', namespace: 'treasury', operation: 'update', target: 'payments', statement: '{"update":"payments","updates":[{"q":{"_id":"?"}}]}', rowsAffected: 1, parameters: [{ name: 'updates[0].signatureToken', value: '[REDACTED]' }] } },
  { level: 'Db', message: 'INCRBY', offsetMs: 3, elapsedMs: 0.2, db: { system: 'redis', operation: 'INCRBY', target: 'limits:fx', statement: 'INCRBY limits:fx ?', blocked: true } },
  { level: 'Db', message: 'GetItem keys', offsetMs: 4, db: { system: 'aws.dynamodb', operation: 'GetItem', target: 'keys' } },
];

test('Db log entries carry their store name as the level, store chips filter them, and commands keep values hidden', () => {
  const html = logsMarkup({ logs: dbLogs });
  assert.match(html, /class="lvl" title="MongoDB">MongoDB</, 'the badge says the store name, the same words as its chip');
  assert.match(html, /data-log-query="sql"[^]*data-log-query="mongodb"[^]*data-log-query="redis"/);
  assert.doesNotMatch(html, /data-log-sql/, 'with Db entries SQL is one of the query chips');
  assert.match(html, /style="--lvl-w:\d+(\.\d+)?rem"/);
  assert.match(html, /class="log-badge is-blocked"/);
  assert.match(html, /The write guard refused INCRBY: it never reached Redis/);
  assert.match(html, /DynamoDB/, 'OpenTelemetry’s aws.dynamodb reads as DynamoDB');
  assert.match(html, /data-log-copy="command"/);
  assert.match(html, /<dt>Collection<\/dt><dd>payments<\/dd>/, 'MongoDB says collection');
  assert.match(html, /class="redacted"/);
  assert.match(commandMarkup('mongodb', '{"find":"payments","filter":{"_id":"?"}}'), /class="ph"[^>]*>\?<\/span>/);
  assert.match(commandMarkup('redis', 'SET session:42 ?'), /<span class="rc-c">SET<\/span> <span class="rc-k">session:42<\/span> <span class="ph"/);
  assert.match(commandMarkup('dynamodb', 'SELECT a FROM "t" WHERE pk = ?'), /tok-k">SELECT[^]*class="ph"/);
  // A log with only SQL keeps the classic SQL toggle (mock 18).
  assert.match(logsMarkup({ logs: dbLogs.slice(0, 2) }), /data-log-sql/);
});

test('discovery: hooked stores, operations marked preview: false and the blocked 409 body', () => {
  assert.deepEqual(dataStores(capabilities).map(store => [store.system, store.mode]), [['mongodb', 'preview'], ['redis', 'guard'], ['dynamodb', 'guard']]);
  assert.deepEqual(dataStores({}), []);
  const op = { method: 'POST', path: '/api/v2/fx/quotes' };
  const cap = { previewUnavailable: [{ method: 'POST', path: '/api/v2/fx/quotes', reason: 'Preview unavailable: this operation writes to Redis', stores: ['redis'] }] };
  assert.deepEqual(previewUnavailable(op, cap), { reason: 'This operation writes to Redis', stores: ['redis'] });
  assert.equal(previewUnavailable({ method: 'GET', path: '/api/v2/fx/quotes' }, cap), undefined);
  assert.equal(authorReason('quotes are cached'), 'Quotes are cached');
  assert.equal(blockedPreview(409, { code: 'conflict' }), undefined, 'an ordinary 409 stays an ordinary response');
  assert.equal(blockedPreview(409, { code: 'preview_unavailable', store: 'redis', operation: 'INCRBY', detail: 'x' }).operation, 'INCRBY');
  assert.equal(sqlSystem({ database: 'treasury-demo.db' }), 'sqlite');
  assert.equal(storeName(sqlSystem({ database: 'orders' })), 'SQL database');
  assert.equal(recordCount('redis', 2), '2 keys');
  assert.match(storeMark('mongodb', 20), /class="mk mk-20 mk-mongodb"/);
  assert.match(storeMark('cosmosdb'), /mk-other/, 'a store without a usable mark keeps the same size with the generic glyph');
  assert.match(storeMark('somethingelse'), /mk-other/);
});

test('Preview unavailable, known in advance: Preview stays in place, disabled, with the reason docked above it', () => {
  const op = { method: 'POST', path: '/api/v2/fx/quotes' };
  const entry = { reason: 'Quotes are cached in Redis for 30 seconds.', stores: ['redis'] };
  const bar = actionBar(op, false, { unavailable: entry });
  assert.match(bar, /Send only · asks before it commits/);
  assert.match(bar, /btn-send btn-primary/, 'Send becomes primary');
  assert.match(bar, /btn-preview is-unavailable" data-action="preview" aria-disabled="true" aria-describedby="preview-dock-title"/);
  const dock = previewDock(entry);
  assert.match(dock, /id="preview-dock-title">Preview unavailable</);
  assert.match(dock, /lang="en">Quotes are cached in Redis for 30 seconds\./, 'the author’s reason keeps its language');
  assert.match(dock, /Redis can’t roll back/);
  assert.match(dock, /<code class="ltr">preview: false<\/code>/);
  assert.equal(previewDock(undefined), '');
  assert.match(confirmation('POST', '/api/v2/fx/quotes', ['redis']), /Send for real\? This writes to Redis and can’t be undone\./);
  const before = beforeRun('Response', { readOnly: false, canPreview: false, unavailable: entry, fillable: false, schemaName: () => '', op: { operation: {} } });
  assert.match(before, /This operation writes to Redis, which can’t roll back/);
  assert.match(before, /class="step-off"[^]*Preview isn’t available here[^]*Redis/);
});

const blockedResult = {
  status: 409, preview: true, duration: 23, finishedAt: Date.UTC(2026, 10, 21, 14, 2, 11), headers: { 'content-type': 'application/problem+json' },
  body: { type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable', detail: 'Preview unavailable: this operation writes to Redis', store: 'redis', operation: 'INCRBY', rolledBack: false },
  blocked: { detail: 'Preview unavailable: this operation writes to Redis', store: 'redis', operation: 'INCRBY' }, changes: [], effects: [], logs: [],
};

test('Preview unavailable, caught mid-request: a designed amber state, store by store, with what to do next', () => {
  const html = blockedMarkup(blockedResult, { capabilities, traceAvailable: true, traced: false });
  assert.match(html, /Blocked by the write guard/);
  assert.match(html, /Preview stopped before writing to Redis/);
  assert.match(html, /The handler sent <code class="ltr">INCRBY<\/code> to Redis/);
  assert.match(html, /Nothing was written/);
  assert.match(html, /Redis <code class="ltr">cache<\/code>[^]*INCRBY<\/code> refused, never sent/);
  assert.match(html, /SQLite <code class="ltr">treasury-demo\.db<\/code>[^]*Rolled back/);
  assert.match(html, /MongoDB <code class="ltr">treasury<\/code>[^]*Transaction aborted/);
  assert.match(html, /data-action="send"[^]*data-action="traced-on"/, 'Send for real, and Send with trace when it is off');
  assert.match(html, /\[SendproofPreview\(Enabled = false, Reason = &quot;This operation writes to Redis&quot;\)\]/);
  assert.match(html, /application\/problem\+json/);
  assert.equal(previewFalseSnippet('Preview unavailable: writes to Redis'), '[SendproofPreview(Enabled = false, Reason = "Writes to Redis")]');
  assert.match(blockedHeader(blockedResult), /<bdi class="ltr">409<\/bdi> <span>Preview unavailable<\/span>/);
  assert.match(blockedHeader(blockedResult), /class="resp-acts"[^]*copy-curl|class="resp-acts"/, 'Copy as cURL and Send for real travel together');
  assert.deepEqual(resultCounts(blockedResult), [undefined, '–', '–', '–', 1]);
  assert.match(blockedTab('Database', blockedResult, {}), /A blocked Preview keeps nothing/);
  assert.match(resultBar(blockedResult, {}), /Preview blocked at/);
  assert.match(loadingBody('Response', true, { blocked: true }), /class="blk"/, 'its loading state mirrors the blocked layout');
  assert.match(loadingBody('Response', true), /class="viewer"/);
});

test('execute returns the write guard’s 409 as a blocked result instead of a failed Preview', async () => {
  const saved = { fetch: globalThis.fetch, location: globalThis.location, document: globalThis.document };
  globalThis.location = new URL('http://localhost/');
  globalThis.document = { baseURI: 'http://localhost/sendproof/' };
  globalThis.fetch = async () => new Response(JSON.stringify(blockedResult.body), { status: 409, headers: { 'content-type': 'application/problem+json' } });
  try {
    const result = await execute({ method: 'POST', url: 'http://localhost/api/v2/fx/deals', headers: new Headers(), body: '{}' }, true, '/');
    assert.equal(result.status, 409);
    assert.equal(result.preview, true);
    assert.equal(result.blocked.store, 'redis');
    assert.deepEqual(result.changes, []);
    globalThis.fetch = async () => new Response(JSON.stringify({ title: 'Conflict', code: 'other' }), { status: 409 });
    await assert.rejects(execute({ method: 'POST', url: 'http://localhost/api/v2/fx/deals', headers: new Headers(), body: '{}' }, true, '/'), /not acknowledged/);
  } finally { Object.assign(globalThis, saved); }
});

test('the environment panel lists each hooked store with its mode, and says unhooked ones are not covered', () => {
  const html = coverageMarkup(capabilities);
  assert.match(html, /What Preview covers in Development/);
  assert.match(html, /SQLite <code class="ltr">treasury-demo\.db<\/code>[^]*mode-pill is-preview/);
  assert.match(html, /Redis <code class="ltr">cache<\/code>[^]*Guard only/, 'a guarded store says Guard only');
  assert.doesNotMatch(html, />Guard</);
  assert.match(html, /neither rolled back nor blocked/);
});

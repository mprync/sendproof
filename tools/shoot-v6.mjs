// Screenshots of the real workbench in the v6 data-store states (mocks/README.md, "v6"), for
// side-by-side review against the approved mocks in mocks/screens. Run after `npm ci --prefix
// tools` and `npx --prefix tools playwright install chromium`:
//
//   node tools/shoot-v6.mjs [name filter]
//
// It runs the Treasury example (or uses SENDPROOF_URL) and serves ui/ from disk (SENDPROOF_UI_DIR
// defaults to ui). The example has no MongoDB, Redis or DynamoDB, so the script answers three
// requests itself: capabilities gain `dataStores` and `previewUnavailable` (Quote FX rate is marked
// preview: false), the Approve payment Preview returns an envelope with SQL rows, MongoDB documents
// and Db logs, and the Book FX deal Preview returns the write guard's 409. Everything else is the
// real app. PNGs go to artifacts/visual-review/v6 (desktop 1440×900, phones 320×844, all at 2×).
import { mkdir, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { root, serveUiFromDirectory, startHost, stopHost } from './browser-host.mjs';

process.env.SENDPROOF_UI_DIR ??= 'ui';
const out = resolve(root, 'artifacts/visual-review/v6');
const filter = process.argv[2] || '';

const sandbox = { window: {} };
runInNewContext(await readFile(join(root, 'mocks/spec.js'), 'utf8'), sandbox);
const samples = sandbox.window.TB_SAMPLES;
const PAY = '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13';
const oid = value => ({ $oid: value });
const date = value => ({ $date: value });
const decimal = value => ({ $numberDecimal: value });
const paymentBefore = {
  _id: oid('6740a1c2e5b8f1a9c4d3e201'), paymentId: PAY, reference: 'INV-2026-1184 / Q4 freight', status: 'PendingApproval',
  amount: { value: decimal('50000.00'), currency: 'EUR' },
  beneficiary: {
    name: 'Northwind Logistics GmbH', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX',
    address: { street: 'Am Sandtorkai 52', city: 'Hamburg', postcode: '20457', country: 'DE' },
    screening: { status: 'Pending', provider: 'sanctions-eu' }, webhookSecret: '[REDACTED]',
  },
  fees: [{ type: 'SEPA', amount: decimal('0.20'), bearer: 'SHA' }, { type: 'FX', amount: decimal('12.50'), bearer: 'OUR' }],
  approvals: [], holdReason: 'Awaiting second approver',
  audit: { createdAt: date('2026-11-20T09:14:52Z'), createdBy: 'jon.ops@acme.dev', updatedAt: date('2026-11-20T09:15:03Z'), version: 3 },
};
const paymentAfter = {
  _id: paymentBefore._id, paymentId: PAY, reference: paymentBefore.reference, status: 'Approved', amount: paymentBefore.amount,
  beneficiary: { ...paymentBefore.beneficiary, screening: { status: 'Cleared', provider: 'sanctions-eu', checkedAt: date('2026-11-21T14:02:10Z') } },
  fees: [paymentBefore.fees[0], { type: 'FX', amount: decimal('14.75'), bearer: 'OUR' }, { type: 'Priority', amount: decimal('5.00'), bearer: 'OUR' }],
  approvals: [{ by: 'ada.admin@acme.dev', role: 'admin', decision: 'Approved', comment: 'Matches the invoice and PO.', at: date('2026-11-21T14:02:11Z'), signatureToken: '[REDACTED]' }],
  release: { scheduledFor: date('2026-11-23T00:00:00Z'), rail: 'SEPA', cutoff: '14:30 CET' },
  audit: { ...paymentBefore.audit, updatedAt: date('2026-11-21T14:02:11Z'), updatedBy: 'ada.admin@acme.dev', version: 4 },
};
const mongo = (operation, table, key, before, after, via) => ({ operation, store: 'mongodb', namespace: 'treasury', table, key, before, after, ...(via ? { via } : {}) });
const changes = [
  { operation: 'update', table: 'Payments', key: { Id: PAY }, before: { Status: 'PendingApproval', ApprovedAt: null, ApprovedBy: null }, after: { Status: 'Approved', ApprovedAt: '2026-11-21 14:02:11', ApprovedBy: 'ada.admin@acme.dev' } },
  { operation: 'insert', table: 'Approvals', key: { Id: '9b1f6c3e-2a7d-4b10-9e55-0c8a1d3f07d4' }, before: null, after: { Id: '9b1f6c3e-2a7d-4b10-9e55-0c8a1d3f07d4', PaymentId: PAY, Decision: 'Approved', DecidedBy: 'ada.admin@acme.dev', DecidedAt: '2026-11-21 14:02:11', Comment: 'Matches the invoice and PO.' } },
  mongo('update', 'payments', { _id: paymentBefore._id }, paymentBefore, paymentAfter),
  mongo('insert', 'audit_events', { _id: oid('6740a1d03b9e7c21f4a8e5b7') }, null, { _id: oid('6740a1d03b9e7c21f4a8e5b7'), type: 'payment.approved', paymentId: PAY, actor: { email: 'ada.admin@acme.dev', role: 'admin', sessionToken: '[REDACTED]' }, at: date('2026-11-21T14:02:11Z'), changes: ['status', 'approvals', 'release'] }),
  mongo('insert', 'beneficiary_profiles', { _id: 'cp_5b7c0000b123' }, null, { _id: 'cp_5b7c0000b123', name: 'Northwind Logistics GmbH', lastPaidAt: date('2026-11-21T14:02:11Z'), totals: { EUR: decimal('50000.00') }, payments: 1 }, 'upsert'),
  mongo('update', 'approval_snapshots', { _id: 'pay_7d2e41a0' },
    { _id: 'pay_7d2e41a0', policy: { id: 'pol_high_value', threshold: decimal('25000.00'), required: 2 }, approvers: ['jon.ops@acme.dev'], decided: false, note: 'Waiting for a second approver' },
    { _id: 'pay_7d2e41a0', policy: { id: 'pol_high_value', threshold: decimal('25000.00'), required: 2 }, approvers: ['jon.ops@acme.dev', 'ada.admin@acme.dev'], decided: true, decidedAt: date('2026-11-21T14:02:11Z') }, 'replace'),
  mongo('delete', 'payment_holds', { _id: oid('6740a0f71c2d9e8b5a3f6c10') }, { _id: oid('6740a0f71c2d9e8b5a3f6c10'), paymentId: PAY, reason: 'SecondApprovalRequired', placedBy: 'policy-engine', placedAt: date('2026-11-20T09:15:03Z') }, null),
];
const db = (offsetMs, elapsedMs, fields) => ({ level: 'Db', message: [fields.operation, fields.target].filter(Boolean).join(' '), offsetMs, elapsedMs, db: fields });
const sql = (offsetMs, elapsedMs, text) => ({ level: 'Sql', category: 'Microsoft.EntityFrameworkCore.Database.Command', message: text, offsetMs, elapsedMs, sql: { text, parameters: [{ name: '@p0', value: PAY, dbType: 'Guid' }] } });
const info = (offsetMs, category, message) => ({ level: 'Information', category, message, offsetMs });
const mongoUpdate = JSON.stringify({ update: 'payments', $db: 'treasury', updates: [{ q: { _id: '?', status: '?' }, u: { $set: { status: '?', 'fees.1.amount': '?', 'beneficiary.screening': '?', release: '?', 'audit.updatedAt': '?', 'audit.updatedBy': '?' }, $push: { approvals: '?', fees: '?' }, $unset: { holdReason: '?' }, $inc: { 'audit.version': '?' } }, upsert: '?' }], ordered: '?', txnNumber: '?', autocommit: '?' });
const logs = [
  info(0, 'Microsoft.AspNetCore.Hosting.Diagnostics', `Request starting POST /api/v2/approvals/${PAY}/approve`),
  info(1.1, 'Treasury.Auth', 'Signed in as ada.admin@acme.dev with roles admin'),
  db(2.4, 0.6, { system: 'dynamodb', namespace: 'idempotency', operation: 'GetItem', target: 'idempotency-keys', rowsAffected: 0 }),
  db(3.0, 0.9, { system: 'dynamodb', namespace: 'idempotency', operation: 'ExecuteStatement', target: 'idempotency-keys', statement: 'SELECT status, responseHash FROM "idempotency-keys" WHERE pk = ? AND sk = ?', parameters: [{ name: '1', value: `approve#${PAY}` }, { name: '2', value: 'ada.admin@acme.dev' }], rowsAffected: 0 }),
  db(3.9, 0.4, { system: 'redis', namespace: '0', operation: 'HMGET', target: 'limits:approvals:ada.admin', statement: 'HMGET limits:approvals:ada.admin ? ?' }),
  sql(5.2, 2.8, 'SELECT p.Id, p.Status, p.Amount FROM Payments AS p WHERE p.Id = @p0'),
  db(9.8, 1.2, { system: 'mongodb', namespace: 'treasury', operation: 'find', target: 'payments', statement: '{"find":"payments","filter":{"paymentId":"?"},"limit":"?"}', rowsAffected: 1 }),
  info(14.6, 'Treasury.ApprovalPolicy', 'Second approval satisfies pol_high_value'),
  sql(18.3, 3.4, 'UPDATE Payments SET Status = @p0, ApprovedAt = @p1, ApprovedBy = @p2 WHERE Id = @p3'),
  sql(22.0, 2.1, 'INSERT INTO Approvals (Id, PaymentId, Decision, DecidedBy, DecidedAt, Comment) VALUES (@p0, @p1, @p2, @p3, @p4, @p5)'),
  db(25.7, 1.8, { system: 'mongodb', namespace: 'treasury', operation: 'update', target: 'payments', statement: mongoUpdate, rowsAffected: 1,
    parameters: [{ name: 'updates[0].q._id', value: 'ObjectId("6740a1c2e5b8f1a9c4d3e201")' }, { name: 'updates[0].u.$set.status', value: 'Approved' }, { name: 'updates[0].u.$push.approvals.signatureToken', value: '[REDACTED]' }, { name: 'updates[0].u.$push.approvals.by', value: 'ada.admin@acme.dev' }] }),
  db(29.9, 0.9, { system: 'mongodb', namespace: 'treasury', operation: 'insert', target: 'audit_events', statement: '{"insert":"audit_events","documents":["?"]}', rowsAffected: 1 }),
  db(31.4, 1.1, { system: 'mongodb', namespace: 'treasury', operation: 'update', target: 'beneficiary_profiles', statement: '{"update":"beneficiary_profiles","updates":[{"q":{"_id":"?"},"u":{"$set":"?","$inc":"?"},"upsert":"?"}]}', rowsAffected: 1 }),
  db(33.0, 0.7, { system: 'mongodb', namespace: 'treasury', operation: 'update', target: 'approval_snapshots', statement: '{"update":"approval_snapshots","updates":[{"q":{"_id":"?"},"u":"?"}]}', rowsAffected: 1 }),
  db(34.2, 0.6, { system: 'mongodb', namespace: 'treasury', operation: 'delete', target: 'payment_holds', statement: '{"delete":"payment_holds","deletes":[{"q":{"paymentId":"?"},"limit":"?"}]}', rowsAffected: 1 }),
  info(38.1, 'Treasury.PaymentService', `Approved payment ${PAY}; release on 23 Nov 2026`),
];
const envelope = {
  rolledBack: true, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
  // A real Payment from the example's own recorded responses (mocks/spec.js), approved, so the
  // schema match in the head row is clean.
  body: { ...samples.payment, status: 'Approved' },
  changes, logs, effects: [{ kind: 'email', description: 'PaymentApprovedNotification → treasury-ops@acme.dev', delivered: false }],
};
const problem = { type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable', detail: 'Preview unavailable: this operation writes to Redis', store: 'redis', operation: 'INCRBY', rolledBack: false };

/** One browser context with v6 discovery, the identity, and the two Preview answers. */
async function v6Context(browser, { width, height, language = 'en-IE', theme = 'light' }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'en-IE' });
  await serveUiFromDirectory(context);
  await context.addInitScript(([language, theme]) => localStorage.setItem('sendproof-settings', JSON.stringify({ language, theme })), [language, theme]);
  await context.route(/\/sendproof\/_api\/capabilities$/, async route => {
    const response = await route.fetch();
    const capabilities = await response.json();
    Object.assign(capabilities, {
      identity: { name: 'Ada Admin', role: 'admin' },
      dataStores: [{ system: 'mongodb', name: 'treasury', mode: 'preview' }, { system: 'redis', name: 'cache', mode: 'guard' }, { system: 'dynamodb', name: 'idempotency', mode: 'guard' }],
      previewUnavailable: [{ method: 'POST', path: '/api/v2/fx/quotes', reason: 'Quotes are cached in Redis for 30 seconds.', stores: ['redis'] }],
    });
    capabilities.previewOperations = capabilities.previewOperations.filter(item => item.path !== '/api/v2/fx/quotes');
    await route.fulfill({ response, json: capabilities });
  });
  // The approval queue the payment ID lookup reads (the injected identity has no real session).
  await context.route(/\/api\/v2\/approvals\?pageSize=50/, route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ paymentId: PAY, number: 'PAY-2026-0412', valueDate: '2026-11-23', amount: 50000, currency: 'EUR', beneficiary: 'Northwind Logistics GmbH' }], totalItems: 1, page: 1, pageSize: 50 }) }));
  await context.route(/\/sendproof\/_preview\/api\/v2\/approvals\/[^/]+\/approve/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) }));
  await context.route(/\/sendproof\/_preview\/api\/v2\/fx\/deals$/, route => route.fulfill({ status: 409, contentType: 'application/problem+json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(problem) }));
  return context;
}

async function open(page, url, opid, { text } = {}) {
  await page.goto(`${url}/sendproof/#op/${opid}`);
  await page.locator('.sidebar .nav-heading').first().waitFor({ state: 'attached' });
  if (text) await page.evaluate(size => { document.documentElement.style.fontSize = size; }, text);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** Fills the required fields and runs a Preview; on a phone, returns to the result. */
async function preview(page) {
  if (await page.locator('.mobile-switch [data-view="request"]').isVisible()) await page.locator('.mobile-switch [data-view="request"]').click();
  await page.locator('.actionbar [data-action="preview"]').waitFor();
  // Approve payment: the payment ID through its lookup (typed, as a person can), and a JSON body.
  if (await page.locator('#request-tab-Params').count()) {
    await page.locator('#request-tab-Params').click();
    await page.locator('[data-parameter-name] [role="combobox"]').first().click();
    await page.locator('.lb [role="option"]').first().click();
    await page.locator('#request-tab-Body').click();
    await page.locator('[data-body-mode="JSON"]').click();
    await page.locator('#editor textarea, #editor [contenteditable="true"]').first().fill(JSON.stringify({ comment: 'Matches the invoice and PO.' }));
    await page.locator('[data-body-mode="Form"]').click();
  } else {
    // Book FX deal: Autofill → Fill required fields, as a person would. A phone has no Autofill
    // button in the tab row, so the form is filled at desktop width and the phone size restored.
    const size = page.viewportSize();
    if (size.width < 900) await page.setViewportSize({ width: 1440, height: size.height });
    await page.locator('[data-action="sample"]').click();
    await page.locator('[data-fill="required"]').click();
    if (size.width < 900) { await page.setViewportSize(size); await page.waitForTimeout(200); }
  }
  await page.waitForTimeout(400);
  await page.locator('.actionbar [data-action="preview"]').click();
  await page.locator('.response:not([aria-busy="true"]) .resp-head .status-code').waitFor({ timeout: 10000 })
    .catch(async error => { await page.screenshot({ path: join(out, 'failure.png') }); throw error; });
  await page.waitForTimeout(300);
}

const tab = (page, name) => page.getByRole('tablist', { name: 'Result' }).getByRole('tab', { name: new RegExp(`^${name}`) }).click();

const shots = [
  ['113-v6-doc-diff', { width: 1440, height: 900 }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 56; });
  }, 'ApprovalsController.Approve'],
  ['114-v6-doc-diff-dark', { width: 1440, height: 900, theme: 'dark' }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + 360; });
  }, 'ApprovalsController.Approve'],
  ['117-v6-mixed-stores', { width: 1440, height: 900 }, async page => { await tab(page, 'Database'); }, 'ApprovalsController.Approve'],
  ['119-v6-db-logs', { width: 1440, height: 900 }, async page => {
    await tab(page, 'Logs');
    const row = page.locator('#result .log-row.is-db').filter({ hasText: 'payments' }).nth(1);
    await row.click();
    await page.locator('#result .log-detail:not([hidden]) [data-log-copy="command"]').click();
    await page.evaluate(() => { const row = document.querySelector('.log-row.is-open'); const scroll = row.closest('.pane-scroll'); const sticky = document.querySelector('.log-filters'); scroll.scrollTop = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - sticky.getBoundingClientRect().height - row.offsetHeight - 8; });
  }, 'ApprovalsController.Approve'],
  ['122-v6-preview-off', { width: 1440, height: 900 }, null, 'FxController.Quote'],
  ['123-v6-preview-off-confirm-dark', { width: 1440, height: 900, theme: 'dark' }, async page => {
    await page.locator('.actionbar [data-action="send"]').click();
  }, 'FxController.Quote'],
  ['124-v6-preview-blocked', { width: 1440, height: 900 }, 'preview', 'FxController.Book'],
  ['125-v6-preview-blocked-dark', { width: 1440, height: 900, theme: 'dark' }, 'preview', 'FxController.Book'],
  // Not a mock screen: the environment chip's coverage panel (plan, "Coverage disclosure").
  ['v6-coverage-panel', { width: 1440, height: 900 }, async page => { await page.locator('.topbar [data-action="coverage"]').click(); }, 'FxController.Quote'],
  ['130-v6-rtl-ar-preview-off', { width: 1440, height: 900, language: 'ar' }, null, 'FxController.Quote'],
  ['m26-v6-doc-diff-130', { width: 320, height: 844, text: '130%' }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12 + 700; });
  }, 'ApprovalsController.Approve'],
  ['m28-v6-db-logs-130', { width: 320, height: 844, text: '130%' }, async page => {
    await tab(page, 'Logs');
    await page.locator('#result .log-row.is-db').filter({ hasText: 'payments' }).nth(1).click();
  }, 'ApprovalsController.Approve'],
  ['m29-v6-preview-off-130', { width: 320, height: 844, text: '130%' }, null, 'FxController.Quote'],
  ['m30-v6-preview-blocked-130', { width: 320, height: 844, text: '130%' }, 'preview', 'FxController.Book'],
  ['m31-v6-preview-blocked-ar-130-dark', { width: 320, height: 844, text: '130%', language: 'ar', theme: 'dark' }, 'preview', 'FxController.Book'],
];

await mkdir(out, { recursive: true });
const url = await startHost();
const browser = await chromium.launch();
try {
  for (const [name, viewport, act, opid] of shots.filter(([name]) => name.includes(filter))) {
    const context = await v6Context(browser, viewport);
    const page = await context.newPage();
    page.on('pageerror', error => console.error(`${name}: ${error.message}`));
    await open(page, url, opid, viewport);
    if (act === 'preview' || typeof act === 'function') {
      if (opid !== 'FxController.Quote') await preview(page);
      if (typeof act === 'function') await act(page);
    }
    if (viewport.width < 900 && act && opid !== 'FxController.Quote') await page.locator('.mobile-switch [data-view="response"]').click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    // Anything wider than the viewport is reported with the elements that stick out furthest.
    const sideways = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const over = document.documentElement.scrollWidth - width;
      if (over <= 0) return '';
      const name = node => `${node.tagName.toLowerCase()}.${String(node.className).split(' ').slice(0, 2).join('.')}`;
      const out = [...document.querySelectorAll('body *')].filter(node => node.getClientRects().length && node.getBoundingClientRect().right > width + 0.5)
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 4).map(node => `${name(node)} ${Math.round(node.getBoundingClientRect().right)}`);
      return `  (page scrolls sideways by ${over}px: ${out.join(', ')})`;
    });
    console.log(`${name}${sideways}`);
    await context.close();
  }
} finally {
  await browser.close();
  await stopHost();
}

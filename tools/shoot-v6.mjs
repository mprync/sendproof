// Screenshots of the real workbench in the v6 data-store states (mocks/README.md, "v6"), for
// side-by-side review against the approved mocks in mocks/screens. Run after `npm ci --prefix
// tools` and `npx --prefix tools playwright install chromium`:
//
//   node tools/shoot-v6.mjs [name filter]
//
// It runs the Acme Store example (or uses SENDPROOF_URL) and serves ui/ from disk (SENDPROOF_UI_DIR
// defaults to ui). The script runs without MongoDB, Redis or DynamoDB, so it answers three
// requests itself: capabilities gain `dataStores` and `previewUnavailable` (Quote price is marked
// preview: false), the Place order Preview returns an envelope with SQL rows, MongoDB documents,
// Redis and DynamoDB reads and Db logs, and the Redeem coupon Preview returns the write guard's 409
// (its INCRBY is a Redis write). Everything else is the real app. PNGs go to
// artifacts/visual-review/v6 (desktop 1440×900, phones 320×844, all at 2×).
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { root, serveUiFromDirectory, startHost, stopHost } from './browser-host.mjs';

process.env.SENDPROOF_UI_DIR ??= 'ui';
const out = resolve(root, 'artifacts/visual-review/v6');
const filter = process.argv[2] || '';

const ORDER = '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13';
const MIA = 'c0a10000-0000-4000-8000-000000000001';
const SKU = 'NPK-JKT-BLK-M';
const NUMBER = 'AS-2026-004513';
const oid = value => ({ $oid: value });
const date = value => ({ $date: value });
const decimal = value => ({ $numberDecimal: value });
const money = (value, currency = 'EUR') => ({ value, currency });
const variant = { id: '6e3b1d90-2a47-4c58-b0f9-71d5a2c84e13', sku: SKU, name: 'Northpeak Storm Shell Jacket, Black / M' };
const customer = { id: MIA, name: 'Mia Customer', email: 'mia.customer@acme.dev' };
const timelineBefore = {
  _id: ORDER, number: NUMBER, updatedAt: date('2026-11-20T09:14:52Z'),
  events: [],
};
const placed = { type: 'Order.Placed', at: date('2026-11-21T14:02:11Z'), actor: { email: 'mia.customer@acme.dev', name: 'Mia Customer', sessionToken: '[REDACTED]' }, status: 'Paid', summary: `Order ${NUMBER} placed for 170.10 EUR.` };
const captured = { type: 'Payment.Captured', at: date('2026-11-21T14:02:13Z'), actor: placed.actor, status: 'Paid', summary: 'Visa •••• 4242 accepted.' };
const timelineAfter = { ...timelineBefore, updatedAt: date('2026-11-21T14:02:13Z'), events: [placed, captured] };
const mongo = (operation, table, key, before, after, via) => ({ operation, store: 'mongodb', namespace: 'store', table, key, before, after, ...(via ? { via } : {}) });
const changes = [
  { operation: 'insert', table: 'Orders', key: { Id: ORDER }, before: null, after: { Id: ORDER, Number: NUMBER, CustomerId: MIA, Status: 'Paid', Currency: 'EUR', Subtotal: 188.99, Discount: 18.89, ShippingCost: 0, Tax: 31.78, Total: 170.1, CouponCode: 'ACME10', ShippingSpeed: 'Express', PlacedAt: '2026-11-21 14:02:11' } },
  { operation: 'insert', table: 'OrderLines', key: { Id: 'a3c5e7f9-1b2d-4f60-8a4c-5d7e9f1b3c20' }, before: null, after: { Id: 'a3c5e7f9-1b2d-4f60-8a4c-5d7e9f1b3c20', OrderId: ORDER, Sku: SKU, Name: variant.name, Quantity: 1, UnitPrice: 188.99, LineTotal: 188.99 } },
  { operation: 'insert', table: 'Payments', key: { Id: '5be0c7f1-93a4-4d6e-8f21-0c4a7d9e3b52' }, before: null, after: { Id: '5be0c7f1-93a4-4d6e-8f21-0c4a7d9e3b52', OrderId: ORDER, Method: 'Card', Status: 'Captured', Amount: 170.1, Currency: 'EUR', MethodDisplay: 'Visa •••• 4242', ProviderReference: 'pay_8c0e2a4b6d1f3a5' } },
  { operation: 'update', table: 'Stock', key: { Id: 'f4a6c8e0-2b1d-4a73-9c85-7e9b1d3f5a07' }, before: { OnHand: 40, Reserved: 0 }, after: { OnHand: 39, Reserved: 0 } },
  { operation: 'insert', table: 'StockMovements', key: { Id: 'b4d6f8a0-2c1e-4a39-9b57-6e8f0a2c4d71' }, before: null, after: { Id: 'b4d6f8a0-2c1e-4a39-9b57-6e8f0a2c4d71', Delta: -1, Reason: 'Sold', Reference: NUMBER, Actor: 'mia.customer@acme.dev' } },
  mongo('insert', 'order_events', { _id: oid('6740a1d03b9e7c21f4a8e5b7') }, null, { _id: oid('6740a1d03b9e7c21f4a8e5b7'), orderId: ORDER, number: NUMBER, ...placed }),
  mongo('insert', 'order_events', { _id: oid('6740a1d03b9e7c21f4a8e5b8') }, null, { _id: oid('6740a1d03b9e7c21f4a8e5b8'), orderId: ORDER, number: NUMBER, ...captured }),
  mongo('update', 'order_timelines', { _id: ORDER }, timelineBefore, timelineAfter, 'upsert'),
];
const db = (offsetMs, elapsedMs, fields) => ({ level: 'Db', message: [fields.operation, fields.target].filter(Boolean).join(' '), offsetMs, elapsedMs, db: fields });
const sql = (offsetMs, elapsedMs, text, parameters = [{ name: '@p0', value: MIA, dbType: 'Guid' }]) => ({ level: 'Sql', category: 'Microsoft.EntityFrameworkCore.Database.Command', message: text, offsetMs, elapsedMs, sql: { text, parameters } });
const info = (offsetMs, category, message) => ({ level: 'Information', category, message, offsetMs });
const mongoUpdate = JSON.stringify({ update: 'order_timelines', $db: 'store', updates: [{ q: { _id: '?' }, u: { $set: { number: '?', updatedAt: '?' }, $push: { events: { $each: '?' } } }, upsert: '?' }], ordered: '?', txnNumber: '?' });
const logs = [
  info(0, 'Microsoft.AspNetCore.Hosting.Diagnostics', 'Request starting POST /api/v2/orders'),
  info(1.1, 'StoreApi.Auth', 'Signed in as mia.customer@acme.dev with role customer'),
  sql(2.0, 1.4, 'SELECT "o"."Id", "o"."Number", "o"."RequestHash" FROM "Orders" AS "o" WHERE "o"."IdempotencyKey" = @p0 LIMIT 1', [{ name: '@p0', value: 'order-7f3a9c1e', dbType: 'String' }]),
  db(3.6, 0.6, { system: 'dynamodb', namespace: 'idempotency', operation: 'GetItem', target: 'idempotency', statement: 'GetItem idempotency pk=?', parameters: [{ name: 'Key.pk', value: 'order#order-7f3a9c1e' }], rowsAffected: 0 }),
  db(4.4, 0.4, { system: 'redis', namespace: '0', operation: 'GET', target: 'ratelimit:orders:mia.customer@acme.dev', statement: 'GET ratelimit:orders:mia.customer@acme.dev' }),
  sql(5.2, 2.1, 'SELECT "c"."Id", "c"."Email", "c"."Tier" FROM "Customers" AS "c" WHERE "c"."Id" = @p0 LIMIT 2'),
  sql(7.9, 1.8, 'SELECT "v"."Id", "v"."Sku", "v"."ProductId" FROM "Variants" AS "v" WHERE "v"."Sku" IN (@p0)', [{ name: '@p0', value: SKU, dbType: 'String' }]),
  db(10.2, 0.5, { system: 'redis', namespace: '0', operation: 'GET', target: 'quote:qt_7f3a9c1e04b2d68', statement: 'GET quote:qt_7f3a9c1e04b2d68' }),
  sql(12.6, 2.4, 'SELECT "s"."Id", "s"."OnHand", "s"."Reserved" FROM "Stock" AS "s" WHERE "s"."VariantId" = @p0 LIMIT 2', [{ name: '@p0', value: variant.id, dbType: 'Guid' }]),
  info(15.1, 'StoreApi.Orders', `Priced ${NUMBER}: 1 line, total 170.10 EUR with ACME10`),
  sql(18.3, 3.4, 'INSERT INTO "Orders" ("Id", "Number", "CustomerId", "Status", "Currency", "Total") VALUES (@p0, @p1, @p2, @p3, @p4, @p5)'),
  sql(22.0, 2.1, 'INSERT INTO "OrderLines" ("Id", "OrderId", "VariantId", "Sku", "Quantity", "UnitPrice") VALUES (@p0, @p1, @p2, @p3, @p4, @p5)'),
  sql(24.8, 1.6, 'UPDATE "Stock" SET "OnHand" = @p0, "UpdatedAt" = @p1 WHERE "Id" = @p2'),
  db(27.7, 1.8, { system: 'mongodb', namespace: 'store', operation: 'insert', target: 'order_events', statement: '{"insert":"order_events","documents":["?","?"]}', rowsAffected: 2 }),
  db(29.9, 1.9, { system: 'mongodb', namespace: 'store', operation: 'update', target: 'order_timelines', statement: mongoUpdate, rowsAffected: 1,
    parameters: [{ name: 'updates[0].q._id', value: ORDER }, { name: 'updates[0].u.$set.number', value: NUMBER }, { name: 'updates[0].u.$push.events.actor.sessionToken', value: '[REDACTED]' }] }),
  info(34.2, 'StoreApi.Orders', `Order ${NUMBER} placed by mia.customer@acme.dev: 1 item(s), 170.10 EUR.`),
];
const envelope = {
  rolledBack: true, status: 201, headers: { 'content-type': 'application/json; charset=utf-8', location: `/api/v2/orders/${ORDER}` },
  body: {
    id: ORDER, number: NUMBER, status: 'Paid', customer,
    lines: [{ id: 'a3c5e7f9-1b2d-4f60-8a4c-5d7e9f1b3c20', variant, quantity: 1, unitPrice: money(188.99), lineTotal: money(188.99) }],
    totals: { subtotal: money(188.99), discount: money(18.89), shipping: money(0), tax: money(31.78), total: money(170.1) },
    couponCode: 'ACME10', shippingSpeed: 'Express',
    shippingAddress: { recipient: 'Mia Customer', line1: '14 Harcourt Street', city: 'Dublin', region: 'Co. Dublin', postalCode: 'D02 X285', country: 'IE' },
    payment: { id: '5be0c7f1-93a4-4d6e-8f21-0c4a7d9e3b52', method: 'Visa •••• 4242', status: 'Captured' }, shipments: [],
    placedBy: { email: 'mia.customer@acme.dev', name: 'Mia Customer' }, placedAt: '2026-11-21T14:02:11Z', updatedAt: '2026-11-21T14:02:13Z',
  },
  changes, logs,
  effects: [
    { kind: 'email', description: `Order confirmation ${NUMBER} to mia.customer@acme.dev`, delivered: false },
    { kind: 'http', description: `Notify fulfilment of ${NUMBER}`, delivered: false },
    { kind: 'job', description: `Print the pick list for ${NUMBER}`, delivered: false },
    { kind: 'message', description: `Publish ${NUMBER}`, delivered: false },
  ],
};
const problem = { type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable', detail: 'Preview unavailable: this operation writes to Redis', store: 'redis', operation: 'INCRBY', rolledBack: false };
/** The request bodies typed into the JSON editor, so no run depends on what Autofill picks. */
const bodies = {
  'OrdersController.Place': {
    customerId: MIA, items: [{ sku: SKU, quantity: 1 }], currency: 'EUR', shippingSpeed: 'Express', couponCode: 'ACME10',
    shippingAddress: { recipient: 'Mia Customer', line1: '14 Harcourt Street', city: 'Dublin', region: 'Co. Dublin', postalCode: 'D02 X285', country: 'IE' },
    payment: { type: 'Card', token: 'tok_visa_4242', brand: 'Visa', holderName: 'Mia Customer' },
  },
  'CouponsController.Redeem': { count: 3, orderNumber: NUMBER },
};

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
      dataStores: [{ system: 'mongodb', name: 'store', mode: 'preview' }, { system: 'redis', name: 'cache', mode: 'guard' }, { system: 'dynamodb', name: 'idempotency', mode: 'guard' }],
      previewUnavailable: [{ method: 'POST', path: '/api/v2/quotes', reason: 'Quotes are cached in Redis for 15 minutes.', stores: ['redis'] }],
    });
    capabilities.previewOperations = capabilities.previewOperations.filter(item => item.path !== '/api/v2/quotes');
    await route.fulfill({ response, json: capabilities });
  });
  // The coupon list the code lookup reads (the injected identity has no real session).
  await context.route(/\/api\/v2\/coupons\?pageSize=100/, route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ code: 'VIPDAYS', description: 'VIP days: 20% off for three days.', kind: 'Percentage', redeemed: 112 }], totalItems: 1, page: 1, pageSize: 100 }) }));
  await context.route(/\/sendproof\/_preview\/api\/v2\/orders$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) }));
  await context.route(/\/sendproof\/_preview\/api\/v2\/coupons\/[^/]+\/redemptions$/, route => route.fulfill({ status: 409, contentType: 'application/problem+json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(problem) }));
  return context;
}

async function open(page, url, opid, { text } = {}) {
  await page.goto(`${url}/sendproof/#op/${opid}`);
  await page.locator('.sidebar .nav-heading').first().waitFor({ state: 'attached' });
  if (text) await page.evaluate(size => { document.documentElement.style.fontSize = size; }, text);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** Fills the request (a coupon code through its lookup, and a JSON body) and runs a Preview; on a phone, returns to the result. */
async function preview(page, opid) {
  if (await page.locator('.mobile-switch [data-view="request"]').isVisible()) await page.locator('.mobile-switch [data-view="request"]').click();
  await page.locator('.actionbar [data-action="preview"]').waitFor();
  if (await page.locator('#request-tab-Params').count()) {
    await page.locator('#request-tab-Params').click();
    // Redeem coupon: the code through its lookup, as a person would; Place order has only the idempotency header.
    const lookup = page.locator('[data-parameter-name] [role="combobox"]').first();
    if (await lookup.count()) {
      await lookup.click();
      await page.locator('.lb [role="option"]').first().click();
    }
  }
  await page.locator('#request-tab-Body').click();
  await page.locator('[data-body-mode="JSON"]').click();
  await page.locator('#editor textarea, #editor [contenteditable="true"]').first().fill(JSON.stringify(bodies[opid]));
  await page.locator('[data-body-mode="Form"]').click();
  await page.waitForTimeout(400);
  await page.locator('.actionbar [data-action="preview"]').click();
  await page.locator('.response:not([aria-busy="true"]) .resp-head .status-code').waitFor({ timeout: 10000 })
    .catch(async error => { await page.screenshot({ path: join(out, 'failure.png') }); throw error; });
  await page.waitForTimeout(300);
}

const tab = (page, name) => page.getByRole('tablist', { name: 'Result' }).getByRole('tab', { name: new RegExp(`^${name}`) }).click();

const PLACE = 'OrdersController.Place';
const QUOTE = 'CartsController.Quote';
const REDEEM = 'CouponsController.Redeem';
const shots = [
  ['113-v6-doc-diff', { width: 1440, height: 900 }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 56; });
  }, PLACE],
  ['114-v6-doc-diff-dark', { width: 1440, height: 900, theme: 'dark' }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + 360; });
  }, PLACE],
  ['117-v6-mixed-stores', { width: 1440, height: 900 }, async page => { await tab(page, 'Database'); }, PLACE],
  ['119-v6-db-logs', { width: 1440, height: 900 }, async page => {
    await tab(page, 'Logs');
    const row = page.locator('#result .log-row.is-db').filter({ hasText: 'order_timelines' }).first();
    await row.click();
    await page.locator('#result .log-detail:not([hidden]) [data-log-copy="command"]').click();
    await page.evaluate(() => { const row = document.querySelector('.log-row.is-open'); const scroll = row.closest('.pane-scroll'); const sticky = document.querySelector('.log-filters'); scroll.scrollTop = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - sticky.getBoundingClientRect().height - row.offsetHeight - 8; });
  }, PLACE],
  ['122-v6-preview-off', { width: 1440, height: 900 }, null, QUOTE],
  ['123-v6-preview-off-confirm-dark', { width: 1440, height: 900, theme: 'dark' }, async page => {
    await page.locator('.actionbar [data-action="send"]').click();
  }, QUOTE],
  ['124-v6-preview-blocked', { width: 1440, height: 900 }, 'preview', REDEEM],
  ['125-v6-preview-blocked-dark', { width: 1440, height: 900, theme: 'dark' }, 'preview', REDEEM],
  // Not a mock screen: the environment chip's coverage panel (plan, "Coverage disclosure").
  ['v6-coverage-panel', { width: 1440, height: 900 }, async page => { await page.locator('.topbar [data-action="coverage"]').click(); }, QUOTE],
  ['130-v6-rtl-ar-preview-off', { width: 1440, height: 900, language: 'ar' }, null, QUOTE],
  ['m26-v6-doc-diff-130', { width: 320, height: 844, text: '130%' }, async page => {
    await tab(page, 'Database');
    await page.evaluate(() => { const card = document.querySelector('[data-doc-card="2"]'); const scroll = card.closest('.pane-scroll'); scroll.scrollTop = card.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12 + 700; });
  }, PLACE],
  ['m28-v6-db-logs-130', { width: 320, height: 844, text: '130%' }, async page => {
    await tab(page, 'Logs');
    await page.locator('#result .log-row.is-db').filter({ hasText: 'order_timelines' }).first().click();
  }, PLACE],
  ['m29-v6-preview-off-130', { width: 320, height: 844, text: '130%' }, null, QUOTE],
  ['m30-v6-preview-blocked-130', { width: 320, height: 844, text: '130%' }, 'preview', REDEEM],
  ['m31-v6-preview-blocked-ar-130-dark', { width: 320, height: 844, text: '130%', language: 'ar', theme: 'dark' }, 'preview', REDEEM],
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
      if (opid !== QUOTE) await preview(page, opid);
      if (typeof act === 'function') await act(page);
    }
    if (viewport.width < 900 && act && opid !== QUOTE) await page.locator('.mobile-switch [data-view="response"]').click().catch(() => {});
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

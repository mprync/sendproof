// Regenerates every README image and the social preview from the running example app, in one
// command. Nothing is stubbed: sign-in, Preview envelopes, document diffs, logs and the write guard
// all come from the app. Start the store example with its Redis, MongoDB and DynamoDB stores
// (examples/StoreApi/README.md, "Run the local demo"), then:
//
//   npm ci --prefix tools && npx --prefix tools playwright install chromium   # once
//   node tools/readme-shots.mjs                    # capture, compose and optimise everything
//   node tools/readme-shots.mjs --only hero,docs   # a subset (names below)
//   node tools/readme-shots.mjs --compose-only     # re-render the frames from the last captures
//
// Steps: (1) the real workbench is captured at 2x into artifacts/readme/raw, light and dark;
// (2) each docs/images/src/<name>.html frame (window chrome, backdrop, crops of the captures, the
// "works with" strips) is rendered at 2x into docs/images/<name>-light.png and -dark.png, and
// social.html into docs/images/social-preview.png (1280x640); (3) the PNGs are optimised with
// pngquant and oxipng when installed, and any image over 600 KB is reported.
//
// Operations are found from the app's OpenAPI document and capabilities. Override any of them with
// an operationId: SHOT_ORDER (a write whose Preview touches SQL and MongoDB; default: POST
// /…/orders, Place order), SHOT_LIST (a GET to Send; default: GET /…/products), SHOT_DOCS
// (default: SHOT_ORDER), SHOT_UNAVAILABLE (default: the first `previewUnavailable` operation, Quote
// price), SHOT_BLOCKED (a write whose Preview the guard blocks with 409; default: POST
// /…/redemptions, Redeem coupon), SHOT_JOURNEY (a journey to Preview to the end; default: Order to
// shipment) and SHOT_DIFFERENCE (an input, as name=option, that makes a step of it write something
// other than it should; default: carrier=Ups). SENDPROOF_URL defaults to http://127.0.0.1:5189; the frames'
// address pill shows its host, so capture from http://localhost:5080 (the README's `dotnet run`)
// for the published images. SHOT_PERSONA defaults to the first persona the app lists. Every Preview
// rolls back, so the app's data is unchanged; the List Send is a read.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const url = (process.env.SENDPROOF_URL ?? 'http://127.0.0.1:5189').replace(/\/$/, '');
const raw = join(root, 'artifacts/readme/raw');
const images = resolve(root, process.env.SHOT_OUT ?? 'docs/images');
const sources = join(root, 'docs/images/src');
const args = process.argv.slice(2);
const only = (args[args.indexOf('--only') + 1] ?? '').split(',').filter(name => args.includes('--only') && name);
const composeOnly = args.includes('--compose-only');
const wanted = name => !only.length || only.includes(name);
const themes = ['light', 'dark'];
// The desktop shots close the operations sidebar (Mod+\), so the frames can show the whole window,
// top bar and logo included, at a size that reads at README width.
const desktop = { width: 1320, height: 860 };
const phone = { width: 390, height: 844 };
const settle = page => page.waitForTimeout(400);

// ---- What to capture ---------------------------------------------------------------------------

async function discover() {
  const get = async path => {
    const response = await fetch(`${url}${path}`).catch(() => { throw new Error(`Nothing answers at ${url}. Start the example app with its stores first (see the header of this script).`); });
    if (!response.ok) throw new Error(`${path} answered ${response.status}; is the example app running at ${url}?`);
    return response.json();
  };
  const capabilities = await get('/sendproof/_api/capabilities');
  const spec = await get(capabilities.openApiUrl);
  const operations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([method]) => /^(get|put|post|patch|delete)$/.test(method))
    .map(([method, operation]) => ({ id: operation.operationId, method: method.toUpperCase(), path })));
  const find = (variable, test, what) => {
    const chosen = process.env[variable] ?? operations.find(test)?.id;
    if (!chosen) throw new Error(`No operation for ${what}; set ${variable} to an operationId.`);
    if (!operations.some(operation => operation.id === chosen)) throw new Error(`${variable}=${chosen} is not in the OpenAPI document.`);
    return chosen;
  };
  const unavailable = capabilities.previewUnavailable?.[0];
  const order = find('SHOT_ORDER', operation => operation.method === 'POST' && /\/orders$/.test(operation.path), 'the order Preview');
  const personas = await get(capabilities.authProviders.find(provider => provider.kind === 'personas')?.url ?? '/auth/personas').catch(() => []);
  const redeem = operations.find(operation => operation.method === 'POST' && /\/redemptions$/.test(operation.path))?.id;
  // The journey to run: SHOT_JOURNEY, else the store example's Order to shipment, else the first published.
  const arazzo = capabilities.journeys?.[0] ? await get(capabilities.journeys[0].arazzoUrl) : null;
  const workflows = arazzo?.workflows ?? [];
  const journey = process.env.SHOT_JOURNEY ?? (workflows.find(workflow => workflow.workflowId === 'orderToShipment') ?? workflows[0])?.workflowId;
  const inputs = workflows.find(workflow => workflow.workflowId === journey)?.inputs?.properties ?? {};
  return {
    apiName: capabilities.apiName,
    document: capabilities.openApiUrl,
    persona: process.env.SHOT_PERSONA ?? personas[0]?.email,
    order,
    list: find('SHOT_LIST', operation => operation.method === 'GET' && /\/products$/.test(operation.path), 'the List Send'),
    docs: process.env.SHOT_DOCS ?? order,
    unavailable: find('SHOT_UNAVAILABLE', operation => unavailable && operation.method === unavailable.method && operation.path === unavailable.path, 'Preview unavailable'),
    // The store example's Redeem coupon runs Redis INCRBY, which the write guard stops.
    blocked: process.env.SHOT_BLOCKED ?? redeem,
    journey,
    // An input that makes the journey write something other than it expects ("name=option label"):
    // in the store example a carrier other than DHL, which AD-0011 doesn't cover.
    difference: process.env.SHOT_DIFFERENCE ?? ('carrier' in inputs ? 'carrier=Ups' : undefined),
  };
}

// ---- Driving the workbench ---------------------------------------------------------------------

/**
 * A signed-in workbench page. `layout` is the saved pane split the app restores
 * ({ sidebar: rem, request: share of the room beside the sidebar }), as a person who dragged the
 * divider would have it.
 */
async function workbench(browser, viewport, { theme, language = 'en', persona, layout, document, settings = {} }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-GB', colorScheme: theme });
  await context.addInitScript(({ settings, layout, key }) => {
    localStorage.setItem('sendproof-settings', JSON.stringify(settings));
    if (layout) localStorage.setItem(key, JSON.stringify(layout));
  }, { settings: { ...settings, language, theme }, layout, key: `sendproof-layout:${document}` });
  const page = await context.newPage();
  page.on('pageerror', error => console.error(`  page error: ${error.message}`));
  await page.goto(`${url}/sendproof/`);
  if (persona) {
    const status = await page.evaluate(async email => (await fetch(`/auth/personas/${encodeURIComponent(email)}`, { method: 'POST', credentials: 'same-origin' })).status, persona);
    if (status >= 300) throw new Error(`switching to ${persona} answered ${status}`);
  }
  return { context, page };
}

async function open(page, hash) {
  await page.goto(`${url}/sendproof/#${hash}`);
  await page.reload(); // a hash change alone keeps the capabilities from before sign-in
  await page.locator('.sidebar .nav-heading').first().waitFor({ state: 'attached' });
  await page.evaluate(() => document.fonts.ready);
  await closeSidebar(page);
  await settle(page);
}

/** Closes the operations sidebar on a desktop layout, with the app's own shortcut. */
async function closeSidebar(page) {
  const state = await page.evaluate(() => matchMedia('(min-width: 56.001rem)').matches ? document.querySelector('.workspace')?.dataset.sidebar ?? 'open' : 'mobile');
  if (state !== 'open') return;
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('ControlOrMeta+Backslash');
  await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebar === 'closed', null, { timeout: 3000 })
    .catch(() => console.warn('  the sidebar did not close'));
}

/** Scrolls every pane back to its top, so a frame never opens mid-form. */
const toTop = page => page.evaluate(() => document.querySelectorAll('.pane-scroll, main.pane, .pane').forEach(element => { element.scrollTop = 0; }));

/** Opens an operation with its documented example filled in, then picks any path record left empty. */
async function prepare(page, operation) {
  await open(page, `docs/${operation}`);
  await page.locator('[data-action="docs-try"]').first().click();
  await page.locator('.actionbar [data-action="send"]').waitFor();
  if (await page.locator('#request-tab-Params').count()) {
    await page.locator('#request-tab-Params').click();
    // Only the path's own records: optional filters stay unset, so a list returns a full page.
    const empty = page.locator('#parameters-path [data-parameter-name] [role="combobox"]:has(.placeholder)');
    for (let left = await empty.count(); left > 0; left--) {
      await empty.first().click();
      const option = page.locator('.lb [role="option"]').first();
      await option.waitFor({ timeout: 10000 });
      await option.click();
      await page.waitForTimeout(150);
    }
    const body = page.locator('#request-tab-Body');
    if (await body.count()) await body.click();
  }
  await toTop(page);
  await page.waitForTimeout(250);
}

async function run(page, action, label) {
  await page.locator(`.actionbar [data-action="${action}"]`).click();
  await page.locator('.response:not([aria-busy="true"]) .resp-head .status-code').waitFor({ timeout: 15000 });
  await settle(page);
  const status = (await page.locator('.resp-head .status-code').first().textContent())?.trim();
  console.log(`  ${label}: ${status}`);
}

const tab = (page, index) => page.locator('.pane.response > [role="tablist"] [role="tab"]').nth(index).click();
const TABS = { response: 0, database: 1, effects: 2, logs: 3, headers: 4 };

/** Scrolls the result pane so the first document card sits near the top. */
const toDocuments = page => page.evaluate(() => {
  const card = document.querySelector('#result [data-doc-card]');
  if (!card) return false;
  const scroll = card.closest('.pane-scroll');
  const heading = card.closest('section.sg')?.firstElementChild ?? card; // the store's heading
  scroll.scrollTop += heading.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
  return true;
});

/** Opens a journey's overview in Journeys mode, with the journey list beside it. */
async function openJourney(page, journey) {
  await page.goto(`${url}/sendproof/#journey/${journey}`);
  await page.reload();
  await page.locator('.actionbar [data-action="journey-preview-run"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
}

/** Sets a journey input by name ("carrier=Ups"): a choice picks the option, anything else is typed. */
async function setInput(page, assignment) {
  const [name, value] = assignment.split('=');
  const id = await page.evaluate(name => [...document.querySelectorAll('main [id$="-label"]')].find(label => label.textContent.trim() === name)?.id.replace(/-label$/, ''), name);
  if (!id) throw new Error(`no journey input ${name}`);
  const field = page.locator(`#${id}`);
  await field.scrollIntoViewIfNeeded();
  if (await field.getAttribute('role') === 'combobox') {
    await field.click();
    await page.locator('[role="option"]', { hasText: value }).first().click();
  } else await field.fill(value);
}

/** Previews the open journey to the end, on one Preview session, and waits for the run's summary. */
async function previewJourney(page, label) {
  await page.locator('.actionbar [data-action="journey-preview-run"]').click();
  await page.locator('.actionbar [data-action="journey-run-to-end"]:not(:disabled)').click();
  await page.waitForURL(/\/run\//, { timeout: 30000 });
  await page.locator('.actionbar [data-action="journey-preview-run"]:not(:disabled):not([aria-busy="true"])').waitFor({ timeout: 30000 });
  await toTop(page);
  await settle(page);
  console.log(`  ${label}: ${(await page.locator('#jr-title').first().textContent())?.trim()}`);
}

/** A phone shot of the order Preview: the form is filled at desktop width, as a person on a phone would by Autofill. */
async function phonePreview(page, ids) {
  await page.setViewportSize(desktop);
  await prepare(page, ids.order);
  await run(page, 'preview', 'phone preview');
  await page.setViewportSize(phone);
  await page.waitForTimeout(300);
  await page.locator('.mobile-switch [data-view="response"]').click().catch(() => {});
  await tab(page, TABS.database);
  await settle(page);
}

// Each capture's `layout` is the pane split it is taken with (see workbench()); with the sidebar
// closed, the request column keeps that width and the result pane takes the rest.
const captures = {
  'hero': {
    layout: { sidebar: 16, request: 0.56 },
    shots: ['order-database', 'order-documents'],
    async take(page, ids, save) {
      await prepare(page, ids.order);
      await run(page, 'preview', 'order preview');
      await tab(page, TABS.database);
      await settle(page);
      await save('order-database');
      if (!await toDocuments(page)) console.warn('  no MongoDB document cards in the order Preview');
      await settle(page);
      await save('order-documents');
    },
  },
  'logs': {
    // Compact density and a taller window, so the whole chain fits: the reads, the DynamoDB and
    // Redis lookups, the SQL writes, the MongoDB commands and the app's own log line.
    viewport: { width: 1320, height: 1240 },
    settings: { density: 'compact' },
    layout: { sidebar: 16, request: 0.45 },
    shots: ['order-logs'],
    async take(page, ids, save) {
      await prepare(page, ids.order);
      await run(page, 'preview', 'order preview');
      await tab(page, TABS.logs);
      await settle(page);
      await save('order-logs');
    },
  },
  'docs': {
    layout: { sidebar: 16, request: 0.56 },
    shots: ['docs'],
    async take(page, ids, save) {
      await open(page, `docs/${ids.docs}`);
      await save('docs');
    },
  },
  'response': {
    layout: { sidebar: 16, request: 0.45 },
    shots: ['response'],
    async take(page, ids, save) {
      await prepare(page, ids.list);
      await run(page, 'send', 'list send');
      // The schema check's popover: which schema the body matched and what was checked.
      await page.locator('.resp-head button', { hasText: /schema/i }).first().click().catch(() => console.warn('  no schema check on the List Send'));
      await settle(page);
      await save('response');
    },
  },
  'guard': {
    layout: { sidebar: 16, request: 0.56 },
    shots: ['unavailable', 'blocked'],
    async take(page, ids, save) {
      await prepare(page, ids.unavailable);
      await save('unavailable');
      if (!ids.blocked) return;
      await prepare(page, ids.blocked);
      await run(page, 'preview', 'blocked preview');
      await save('blocked');
    },
  },
  // Journeys mode keeps its journey list open: the steps of the run sit under the journey in it.
  'journeys': {
    shots: ['journey-run', 'journey-difference', 'journey-step'],
    async take(page, ids, save) {
      if (!ids.journey) return console.warn('  the app publishes no journeys');
      await openJourney(page, ids.journey);
      await previewJourney(page, 'journey preview');
      await save('journey-run');
      if (!ids.difference) return;
      await openJourney(page, ids.journey);
      await setInput(page, ids.difference);
      await previewJourney(page, `journey preview with ${ids.difference}`);
      await save('journey-difference');
      // The failing step on its operation's own screen: expected and written, field by field.
      await page.locator('#result a, #result button, main a, main button', { hasText: /^Open step/ }).first().click();
      await page.locator('.cf7-head').first().waitFor();
      await settle(page);
      await save('journey-step');
    },
  },
  'phone': {
    viewport: phone,
    shots: ['phone', 'phone-rtl'],
    async take(page, ids, save, browser, theme) {
      await phonePreview(page, ids);
      await save('phone');
      const rtl = await workbench(browser, phone, { theme, language: 'ar', persona: ids.persona, document: ids.document });
      try {
        await phonePreview(rtl.page, ids);
        await save('phone-rtl', rtl.page);
      } finally {
        await rtl.context.close();
      }
    },
  },
};

/**
 * The regions the frames crop, measured in the page at capture time so the frames follow the
 * layout: `full` is the whole viewport (top bar and logo included), `work` the visible main pane
 * and the result pane below the top bar, `result` the result pane alone, `body` the result pane's
 * scrolling content under its tabs, `content` the same down to the end of what it shows, `blocked`
 * a write-guard result down to its first next step, and `documents` the first MongoDB store
 * section down to the end of its first document. All in CSS pixels of the capture.
 */
const regions = page => page.evaluate(() => {
  const visible = element => element && !element.hidden && element.getClientRects().length;
  const box = element => element.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const top = visible(document.querySelector('.topbar')) ? box(document.querySelector('.topbar')).bottom : 0;
  const main = [...document.querySelectorAll('main.pane')].find(visible);
  const result = document.querySelector('.pane.response');
  const out = { full: { x: 0, y: 0, w: width, h: height } };
  if (main) out.work = { x: box(main).left, y: top, w: width - box(main).left, h: height - top };
  if (visible(result)) out.result = { x: box(result).left, y: top, w: box(result).width, h: height - top };
  const body = document.querySelector('#result');
  if (visible(body)) {
    const area = box(body);
    out.body = { x: area.left, y: area.top, w: area.width, h: area.height };
    const end = Math.max(...[...body.querySelectorAll(':scope > *, :scope > * > *')].filter(visible).map(element => box(element).bottom));
    out.content = { x: area.left, y: area.top, w: area.width, h: Math.min(end + 20, area.bottom) - area.top };
  }
  const guard = document.querySelector('#result .blk');
  if (visible(guard)) {
    const pad = 22;
    const area = box(guard);
    const end = box(guard.querySelector('.blk-step') ?? guard.querySelector('.blk-safe') ?? guard).bottom;
    const y = Math.max(area.top - pad, box(body).top);
    out.blocked = { x: area.left - pad, y, w: area.width + pad * 2, h: Math.min(end + 12, height) - y };
  }
  // The first journey finding that differs, with its expected and written values.
  const finding = document.querySelector('.cf7-head')?.parentElement;
  if (visible(finding)) {
    const pad = 16;
    const area = box(finding);
    out.finding = { x: area.left - pad, y: Math.max(area.top - pad, top), w: area.width + pad * 2, h: Math.min(area.bottom + pad, height) - Math.max(area.top - pad, top) };
  }
  const card = document.querySelector('#result [data-doc-card]');
  const group = card?.closest('section.sg');
  if (group) {
    // A little air around the section, without reaching the tabs above or the next card below.
    const pad = 14;
    const area = box(group);
    const y = Math.max(area.top - pad, box(body).top);
    out.documents = { x: area.left - pad, y, w: area.width + pad * 2, h: Math.min(box(card).bottom + 6, height) - y };
  }
  return { vw: width, vh: height, regions: out };
});

async function capture(browser, ids) {
  await mkdir(raw, { recursive: true });
  const manifestFile = join(raw, 'manifest.json');
  const manifest = await readFile(manifestFile, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const [name, plan] of Object.entries(captures).filter(([name]) => wanted(name))) {
    for (const theme of themes) {
      console.log(`capture ${name} (${theme})`);
      const { context, page } = await workbench(browser, plan.viewport ?? desktop, { theme, persona: ids.persona, layout: plan.layout, settings: plan.settings, document: ids.document });
      const save = async (shot, target = page) => {
        await target.screenshot({ path: join(raw, `${shot}-${theme}.png`), animations: 'disabled' });
        manifest[`${shot}-${theme}`] = await regions(target);
        await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
        // The frames' address pill shows the host the captures were taken from.
        await writeFile(join(raw, 'manifest.js'), `window.SHOTS = ${JSON.stringify(manifest)};\nwindow.SHOTS_HOST = ${JSON.stringify(new URL(url).host)};\n`);
      };
      try {
        await plan.take(page, ids, save, browser, theme);
      } catch (error) {
        await page.screenshot({ path: join(raw, `${name}-${theme}-failure.png`) }).catch(() => {});
        throw new Error(`${name} (${theme}): ${error.message.split('\n')[0]} (see artifacts/readme/raw/${name}-${theme}-failure.png)`);
      } finally {
        await context.close();
      }
    }
  }
}

// ---- Framing -----------------------------------------------------------------------------------

const frames = 'http://readme-frames.invalid';

async function compose(browser) {
  await mkdir(images, { recursive: true });
  const written = [];
  for (const file of (await readdir(sources)).filter(file => file.endsWith('.html'))) {
    const name = file.replace(/\.html$/, '');
    const social = name === 'social';
    if (!wanted(name) && !(social && wanted('social'))) continue;
    const page = await browser.newPage({ deviceScaleFactor: social ? 1 : 2 });
    // The frames are served from the repository on a private origin, not file://, so their
    // module scripts can import the marks and the language list straight from ui/.
    await page.route(`${frames}/**`, route => route.fulfill({ path: join(root, decodeURIComponent(new URL(route.request().url()).pathname)) }));
    for (const theme of social ? ['light'] : themes) {
      await page.goto(`${frames}/docs/images/src/${file}?theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth));
      const out = join(images, social ? 'social-preview.png' : `${name}-${theme}.png`);
      await page.locator('#canvas').screenshot({ path: out, animations: 'disabled' });
      written.push(out);
    }
    await page.close();
  }
  return written;
}

function has(tool) {
  try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function optimise(files) {
  const pngquant = has('pngquant');
  const oxipng = has('oxipng');
  if (!pngquant && !oxipng) console.warn('pngquant and oxipng are not installed; the PNGs are not optimised.');
  for (const file of files) {
    if (pngquant) execFileSync('pngquant', ['--force', '--skip-if-larger', '--quality', '70-92', '--speed', '1', '--strip', '--output', file, file], { stdio: 'ignore' });
    if (oxipng) execFileSync('oxipng', ['-o', '4', '--strip', 'safe', '-q', file]);
    const size = (await stat(file)).size;
    console.log(`${file.replace(`${root}/`, '')}  ${Math.round(size / 1024)} KB${size > 600 * 1024 ? '  (over 600 KB)' : ''}`);
  }
}

const browser = await chromium.launch();
try {
  if (!composeOnly) {
    const ids = await discover();
    console.log(`${ids.apiName} at ${url}: order ${ids.order}, list ${ids.list}, docs ${ids.docs}, unavailable ${ids.unavailable}${ids.blocked ? `, blocked ${ids.blocked}` : ''}, signed in as ${ids.persona ?? 'nobody'}`);
    await capture(browser, ids);
  }
  await optimise(await compose(browser));
} finally {
  await browser.close();
}

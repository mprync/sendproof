// Regenerates every README image and the social preview from the running example app, in one
// command. Nothing is stubbed: sign-in, Preview envelopes, document diffs, logs and the write guard
// all come from the app. Start the example with its Redis and MongoDB stores (see its README,
// "Optional data stores"), then:
//
//   npm ci --prefix tools && npx --prefix tools playwright install chromium   # once
//   node tools/readme-shots.mjs                    # capture, compose and optimise everything
//   node tools/readme-shots.mjs --only hero,docs   # a subset (names below)
//   node tools/readme-shots.mjs --compose-only     # re-render the frames from the last captures
//
// Steps: (1) the real workbench is captured at 2x into artifacts/readme/raw, light and dark;
// (2) each docs/images/src/<name>.html frame (window chrome, backdrop, crops of the captures) is
// rendered at 2x into docs/images/<name>-light.png and -dark.png, and social.html into
// docs/images/social-preview.png (1280x640); (3) the PNGs are optimised with pngquant and oxipng
// when installed, and any image over 600 KB is reported.
//
// Operations are found from the app's OpenAPI document and capabilities. Override any of them with
// an operationId: SHOT_ORDER (a write whose Preview touches SQL and MongoDB; default: POST
// /…/orders), SHOT_LIST (a GET to Send; default: GET /…/products), SHOT_DOCS (default: SHOT_ORDER),
// SHOT_UNAVAILABLE (default: the first `previewUnavailable` operation), SHOT_BLOCKED (a write whose
// Preview the guard blocks with 409; optional). SENDPROOF_URL defaults to http://127.0.0.1:5189 and
// SHOT_PERSONA to the first persona the app lists. Every Preview rolls back, so the app's data is
// unchanged; the List Send is a read.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const desktop = { width: 1480, height: 920 };
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
  return {
    apiName: capabilities.apiName,
    persona: process.env.SHOT_PERSONA ?? personas[0]?.email,
    order,
    list: find('SHOT_LIST', operation => operation.method === 'GET' && /\/products$/.test(operation.path), 'the List Send'),
    docs: process.env.SHOT_DOCS ?? order,
    unavailable: find('SHOT_UNAVAILABLE', operation => unavailable && operation.method === unavailable.method && operation.path === unavailable.path, 'Preview unavailable'),
    blocked: process.env.SHOT_BLOCKED,
  };
}

// ---- Driving the workbench ---------------------------------------------------------------------

async function workbench(browser, viewport, { theme, language = 'en', persona }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-GB', colorScheme: theme });
  await context.addInitScript(settings => localStorage.setItem('sendproof-settings', JSON.stringify(settings)), { language, theme });
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
  await settle(page);
}

/** Opens an operation with its documented example filled in, then picks any path record left empty. */
async function prepare(page, operation) {
  await open(page, `docs/${operation}`);
  await page.locator('[data-action="docs-try"]').first().click();
  await page.locator('.actionbar [data-action="send"]').waitFor();
  if (await page.locator('#request-tab-Params').count()) {
    await page.locator('#request-tab-Params').click();
    const empty = page.locator('[data-parameter-name] [role="combobox"]:has(.placeholder)');
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

const captures = {
  'hero': {
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
    shots: ['order-logs'],
    async take(page, ids, save) {
      await prepare(page, ids.order);
      await run(page, 'preview', 'order preview');
      await tab(page, TABS.logs);
      const db = page.locator('#result .log-row.is-db').first();
      if (await db.count()) await db.click();
      await settle(page);
      await save('order-logs');
    },
  },
  'docs': {
    shots: ['docs'],
    async take(page, ids, save) {
      await open(page, `docs/${ids.docs}`);
      await save('docs');
    },
  },
  'response': {
    shots: ['response'],
    async take(page, ids, save) {
      await prepare(page, ids.list);
      await run(page, 'send', 'list send');
      await save('response');
    },
  },
  'guard': {
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
  'phone': {
    viewport: phone,
    shots: ['phone', 'phone-rtl'],
    async take(page, ids, save, browser, theme) {
      await phonePreview(page, ids);
      await save('phone');
      const rtl = await workbench(browser, phone, { theme, language: 'ar', persona: ids.persona });
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
 * layout: `work` is the visible main pane and the result pane below the top bar, `result` the
 * result pane alone, `body` the result pane's scrolling content under its tabs, `full` the whole
 * viewport. All in CSS pixels of the capture.
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
  if (visible(body)) out.body = { x: box(body).left, y: box(body).top, w: box(body).width, h: box(body).height };
  return { vw: width, vh: height, regions: out };
});

async function capture(browser, ids) {
  await mkdir(raw, { recursive: true });
  const manifestFile = join(raw, 'manifest.json');
  const manifest = await readFile(manifestFile, 'utf8').then(JSON.parse).catch(() => ({}));
  for (const [name, plan] of Object.entries(captures).filter(([name]) => wanted(name))) {
    for (const theme of themes) {
      console.log(`capture ${name} (${theme})`);
      const { context, page } = await workbench(browser, plan.viewport ?? desktop, { theme, persona: ids.persona });
      const save = async (shot, target = page) => {
        await target.screenshot({ path: join(raw, `${shot}-${theme}.png`), animations: 'disabled' });
        manifest[`${shot}-${theme}`] = await regions(target);
        await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
        await writeFile(join(raw, 'manifest.js'), `window.SHOTS = ${JSON.stringify(manifest)};\n`);
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

async function compose(browser) {
  await mkdir(images, { recursive: true });
  const written = [];
  for (const file of (await readdir(sources)).filter(file => file.endsWith('.html'))) {
    const name = file.replace(/\.html$/, '');
    const social = name === 'social';
    if (!wanted(name) && !(social && wanted('social'))) continue;
    const page = await browser.newPage({ deviceScaleFactor: social ? 1 : 2 });
    for (const theme of social ? ['light'] : themes) {
      await page.goto(`${pathToFileURL(join(sources, file)).href}?theme=${theme}`);
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

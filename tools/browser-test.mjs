// End-to-end test against the real Treasury example. Run after `npm ci --prefix tools`
// and `npx --prefix tools playwright install chromium`. Run `node tools/browser-test.mjs`.
// SENDPROOF_URL can be the root or /sendproof URL of an already-running Treasury example.
// It MUST be disposable: this test commits one payment and reduces an account balance.
// Without SENDPROOF_URL, a temporary host and new SQLite database are used and removed.
// Local demo: SENDPROOF_URL=http://localhost:5080 node tools/browser-test.mjs
// SENDPROOF_UI_DIR=ui serves the workbench from that directory (not the host's embedded copy), so
// UI edits can be checked against a host built earlier.
// Only point it at a disposable demo database. Evidence goes to artifacts/browser,
// or SENDPROOF_ARTIFACTS when set; no approved mock is ever overwritten.
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { audit, runAccessibility } from './accessibility.mjs';
import { checkCrumbsInEngines } from './crumb-engines.mjs';
import { shortcutAria, shortcutParts } from '../ui/shortcuts.js';

import { root, serveUiFromDirectory, startHost, stopHost } from './browser-host.mjs';
const errors = [];
const responses = [];
const layoutFailures = [];
const artifacts = resolve(root, process.env.SENDPROOF_ARTIFACTS || 'artifacts/browser');
let browser, page, mock;
await mkdir(artifacts, { recursive: true });
await Promise.all(['failure.txt', 'failure-actual.png', 'failure-reference.png', 'comparison.txt']
  .map(filename => rm(join(artifacts, filename), { force: true })));

function watchPage(page) {
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  // Name the URL of every failed response, so an unexpected status is easy to trace.
  page.on('response', response => {
    if (response.status() >= 400) responses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}

// Keep the approved PNG untouched. The pixel delta is diagnostic: real API values,
// timestamps, and platform fonts differ from the static design, so geometry/style
// assertions below are the executable parity gate rather than a pixel percentage.
async function evidence(actual, reference, name) {
  const registered = await actual.evaluate(() => ({
    orphaned: [...document.querySelectorAll('.kbd, [aria-keyshortcuts]')].filter(node =>
      node.classList.contains('kbd') ? !node.closest('[data-shortcut-hint]') : !node.hasAttribute('data-shortcut'))
      .map(node => node.outerHTML),
    hints: [...document.querySelectorAll('[data-shortcut-hint]')].map(node => [
      node.dataset.shortcutHint.split(' '), [...node.querySelectorAll('.kbd, .then')].map(key => key.textContent),
    ]),
    aria: [...document.querySelectorAll('[data-shortcut]')].map(node => [
      node.dataset.shortcut.split(' '), node.getAttribute('aria-keyshortcuts'),
    ]),
  }));
  assert.deepEqual(registered.orphaned, [], `${name}: every displayed or announced shortcut is registered`);
  for (const [ids, display] of registered.hints) assert.deepEqual(display, ids.flatMap(shortcutParts));
  for (const [ids, aria] of registered.aria) assert.equal(aria, shortcutAria(...ids));
  await Promise.all([actual.evaluate(() => document.fonts.ready), reference.evaluate(() => document.fonts.ready)]);
  const [a, r] = await Promise.all([
    actual.screenshot({ animations: 'disabled' }),
    reference.screenshot({ animations: 'disabled' }),
  ]);
  await Promise.all([
    writeFile(join(artifacts, `${name}-actual.png`), a),
    writeFile(join(artifacts, `${name}-reference.png`), r),
    copyFile(join(root, 'mocks', 'screens', `${name.split('--')[0]}.png`), join(artifacts, `${name}-approved.png`)),
  ]);
  // Both screenshots use the same viewport and scale. Highlight differing pixels in red.
  const delta = await reference.evaluate(async ([actualData, referenceData]) => {
    const load = source => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = source;
    });
    const [actualImage, referenceImage] = await Promise.all([load(actualData), load(referenceData)]);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(actualImage.width, referenceImage.width);
    canvas.height = Math.max(actualImage.height, referenceImage.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(referenceImage, 0, 0);
    const ref = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(actualImage, 0, 0); const result = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < result.data.length; i += 4) {
      const diff = Math.max(...[0, 1, 2, 3].map(n => Math.abs(result.data[i + n] - ref.data[i + n])));
      if (diff) { result.data[i] = 255; result.data[i + 1] = 0; result.data[i + 2] = 0; }
      else for (let n = 0; n < 3; n++) result.data[i + n] = Math.round(result.data[i + n] * 0.35);
      result.data[i + 3] = 255;
    }
    ctx.putImageData(result, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
  }, [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${r.toString('base64')}`]);
  await writeFile(join(artifacts, `${name}-delta.png`), Buffer.from(delta, 'base64'));
}

// Compare the actual geometry with the approved HTML, not a self-generated baseline.
async function compareLayout(page, mockPage, label, selectors, tolerance = 0.5, clipToViewport = false) {
  const failures = [];
  for (const [name, actualSelector, mockSelector, dimensions = ['x', 'y', 'width', 'height']] of selectors) {
    const bounds = async (target, selector) => {
      const box = await target.locator(selector).first().boundingBox();
      if (!box || !clipToViewport) return box;
      const viewport = target.viewportSize();
      const x = Math.max(0, Math.min(viewport.width, box.x));
      const y = Math.max(0, Math.min(viewport.height, box.y));
      return { x, y, width: Math.max(0, Math.min(viewport.width, box.x + box.width) - x),
        height: Math.max(0, Math.min(viewport.height, box.y + box.height) - y) };
    };
    const actual = await bounds(page, actualSelector);
    const mock = await bounds(mockPage, mockSelector);
    assert.ok(actual && mock, `${label}: ${name} must be visible in both layouts`);
    for (const dimension of dimensions) {
      const delta = Math.abs(actual[dimension] - mock[dimension]);
      if (delta > tolerance) failures.push(`${label}: ${name}.${dimension} differs by ${delta.toFixed(1)}px (limit ${tolerance}px)`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
}

async function compareStyle(page, mockPage, label, actualSelector, mockSelector, properties, failures) {
  const styles = await Promise.all([[page, actualSelector], [mockPage, mockSelector]].map(([p, selector]) =>
    p.locator(selector).first().evaluate((node, names) => Object.fromEntries(names.map(name => [name, getComputedStyle(node).getPropertyValue(name)])), properties)));
  for (const property of properties) {
    if (styles[0][property] !== styles[1][property]) failures.push(`${label} ${property}: actual ${styles[0][property]}, mock ${styles[1][property]}`);
  }
}

async function compareShell(page, mock, name, query, mobile = false, resizing = false) {
  await mock.goto(pathToFileURL(join(root, 'mocks', 'workbench.html')).href + '?' + query);
  await mock.evaluate(() => document.fonts.ready);
  if (name === 'm12-headers-130-dark') {
    await mock.locator('.kv-toolbar').evaluate(toolbar => {
      const pane = toolbar.closest('.pane-scroll');
      pane.scrollTop += toolbar.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
    });
  }
  await evidence(page, mock, name);
  const selectors = [
    ['topbar', '.topbar', '.topbar'],
    ['request pane', '.request', '.request'],
    ['action bar', '.actionbar', '.actionbar', ['x', 'width']],
    ...(mobile ? [['view switch', '.mobile-switch', '.mobile-switch']] : [
      ['sidebar', '.sidebar', '.sidebar'],
      ['result pane', '.response', '.response'],
      ['resize handles', '.resize-handle', '.resize-handle', ['x', 'y', 'height']],
    ]),
  ];
  if (name === '55-keyboard-shortcuts') selectors.push(
    ['shortcuts dialog', '.dialog', '.dialog', ['x', 'y', 'width']],
    ['shortcuts header', '.dialog-head', '.dialog-head', ['height']],
  );
  if (name === '56-command-palette') selectors.push(
    ['command palette', '.palette', '.palette', ['x', 'y', 'width']],
    ['palette search', '.palette .pop-search', '.palette .pop-search', ['height']],
  );
  // At large text, compare visible bounds. The approved mock can have a larger
  // intrinsic minimum size than its viewport, which the app must not inherit.
  await compareLayout(page, mock, name, selectors, 0.5, mobile).catch(error => layoutFailures.push(error.message));
  await compareStyle(page, mock, name, '.topbar', '.topbar', ['background-color', 'border-bottom-color'], layoutFailures);
  if (resizing) await compareStyle(page, mock, name, '.size-tip', '.size-tip', ['color', 'background-color', 'font-size'], layoutFailures);
  console.log(`Captured and compared ${name}`);
}

/** Toggles light and dark with the registered shortcut (the button moved into Display settings). */
async function toggleTheme(page) {
  await page.locator('body').press('Control+Shift+L');
}

async function selectOperation(page, title) {
  await page.getByRole('searchbox', { name: 'Filter operations' }).fill(title);
  await page.locator('.nav-item').filter({ hasText: title }).click();
  await page.locator('#filter').evaluate(input => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Opens a lookup (or select) and picks the option whose name matches, from its listbox popover. */
async function pickLookup(page, field, name) {
  await field.click();
  const options = await field.getAttribute('aria-controls');
  await page.locator(`[id="${options}"]`).getByRole('option', { name }).first().click();
}

/** Picks a value in a field-styled select by its option name. */
async function pickOption(page, field, name) {
  await pickLookup(page, field, name);
  await page.locator('.lb').waitFor({ state: 'detached' });
}

async function verifyHeaders(page, mock) {
  await page.locator('[data-request-tab="Headers"]').click();
  const grid = page.getByRole('grid', { name: 'Request headers' });
  const add = grid.getByRole('button', { name: /^Add header/i });
  const custom = grid.locator('[data-header-kind="custom"]');
  await add.click();
  await custom.last().locator('[data-header-field="name"]').fill('X-Request-ID');
  await custom.last().locator('[data-header-field="value"]').fill('{{uuid}}');
  await add.click();
  await custom.last().locator('[data-header-field="name"]').fill('X-Tenant');
  await custom.last().locator('[data-header-field="value"]').fill('local-browser-check');
  await custom.last().getByRole('checkbox').uncheck();
  await add.click();
  const name = grid.locator('[data-header-kind="custom"] [data-header-field="name"]').last();
  const value = grid.locator('[data-header-kind="custom"] [data-header-field="value"]').last();
  await name.fill('Acc');
  await page.getByRole('listbox', { name: 'Header suggestions' }).waitFor();
  await page.keyboard.press('Escape');
  await name.fill('X Trace');
  await value.fill('on');
  assert.equal(await name.getAttribute('aria-invalid'), 'true', 'invalid header name is marked on its input');
  assert.ok(await name.getAttribute('aria-describedby'), 'header error is associated with its input');
  await toggleTheme(page);
  await compareShell(page, mock, '53-headers-invalid-dark', 'tab=headers&hstate=invalid&theme=dark&rtab=headers');
  const desktopViewport = page.viewportSize();
  const mobileViewport = { width: 390, height: 844 };
  await Promise.all([page.setViewportSize(mobileViewport), mock.setViewportSize(mobileViewport)]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  await page.locator('.mobile-switch [data-view="request"]').click();
  await page.locator('.kv-toolbar').evaluate(toolbar => {
    const pane = toolbar.closest('.pane-scroll');
    pane.scrollTop += toolbar.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
  });
  await compareShell(page, mock, 'm12-headers-130-dark', 'tab=headers&hstate=invalid&theme=dark&text=130', true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile header editor fits at 130% text');
  await Promise.all([page.setViewportSize(desktopViewport), mock.setViewportSize(desktopViewport)]);
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await toggleTheme(page);
  await name.fill('X-Trace');
  assert.notEqual(await name.getAttribute('aria-invalid'), 'true', 'editing the name clears its error');
  await page.getByRole('button', { name: 'Bulk edit', exact: true }).click();
  assert.match(await page.getByLabel('Custom headers').inputValue(), /# X-Tenant: local-browser-check/);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('.request .pane-scroll').evaluate(pane => { pane.scrollTop = 0; });
  await page.locator('[data-request-tab="Body"]').click();
}

async function verifyKeyboard(page, mock) {
  await page.keyboard.press('Shift+Slash');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await shortcuts.waitFor();
  await compareShell(page, mock, '55-keyboard-shortcuts', 'state=filled&overlay=shortcuts');
  const search = shortcuts.getByRole('searchbox');
  await search.fill('Bulk edit');
  assert.equal(await shortcuts.locator('.sc-row').count(), 1, 'shortcut search filters the registry');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('head');
  await palette.getByRole('option', { name: /^Add header/ }).waitFor();
  assert.equal(await palette.getByRole('option', { name: /^Show response headers/ }).count(), 1,
    'palette includes commands for the current result');
  await compareShell(page, mock, '56-command-palette', 'state=filled&overlay=palette');
  await page.keyboard.press('Tab');
  assert.equal(await palette.locator('.scope').textContent(), 'Actions');
  assert.equal(await palette.getByRole('option', { name: /^Show response headers/ }).count(), 0,
    'scope switch removes commands from other panes');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B');
  await page.getByLabel('Custom headers').waitFor();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('[data-request-tab="Body"]').click();
}

async function verifyPreviewCapture(page, mock) {
  const tabs = page.getByRole('tablist', { name: 'Result' });
  await tabs.getByRole('tab', { name: 'Response', exact: true }).click();
  await page.locator('#result .viewer').waitFor();
  assert.ok(await page.locator('#result .timing-bar').isVisible(), 'server timing makes a real timing bar');
  assert.ok(await page.locator('#result [data-follow-up]').count(), 'a response ID offers a documented follow-up');
  await audit(page, 'response viewer');
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  const raw = await page.locator('#result [data-response-content]').innerText();
  assert.match(raw, /"id"\s*:/, 'Raw displays the actual response');
  await page.getByRole('button', { name: 'Schema', exact: true }).click();
  await page.locator('#result .schema-pane .attr').first().waitFor();
  assert.ok(await page.locator('#result .schema-pane .attr.is-on').count(), 'the schema view marks returned properties');
  assert.equal(await page.locator('#result .schema-pane .attr-desc').count(), 0, 'the schema view keeps compact rows');
  await audit(page, 'response schema');
  await compareShell(page, mock, '30-response-schema', 'state=filled&run=preview&rtab=response&rview=schema');
  await page.getByRole('button', { name: 'Pretty', exact: true }).click();
  await tabs.getByRole('tab', { name: /^Side effects/ }).click();
  await page.locator('#result .fx').first().waitFor();
  await audit(page, 'preview side effects');
  await tabs.getByRole('tab', { name: /^Logs/ }).click();
  const sql = page.locator('#result .log-row.lvl-sql').first();
  await sql.waitFor();
  await sql.press('Enter');
  await page.locator('#result .log-detail').first().waitFor();
  await audit(page, 'structured SQL log');
  await compareShell(page, mock, '18-copied-sql', 'state=filled&run=preview&rtab=logs');
  await tabs.getByRole('tab', { name: /^Headers/ }).click();
  assert.ok(await page.locator('#result .hdr').first().isVisible(), 'response headers are available');
  await audit(page, 'response headers');
  const sentHeaders = page.locator('details.capture-section').filter({ hasText: 'Request headers as sent' });
  await mock.goto(pathToFileURL(join(root, 'mocks', 'workbench.html')).href + '?state=filled&run=preview&rtab=headers');
  await compareLayout(page, mock, 'result headers', [
    ['request header disclosure label', 'summary.collapsed-section .title', '.collapsed-section .title', ['x']],
  ], 0.5).catch(error => layoutFailures.push(error.message));
  await sentHeaders.locator('summary').press('Enter');
  assert.match(await sentHeaders.innerText(), /Prefer\s+tx=rollback/, 'request headers show the value sent to Preview');
  await sentHeaders.locator('summary').press('Enter');
  await tabs.getByRole('tab', { name: /^Database/ }).click();
}

async function verifyObservedCapture(page, mock) {
  await page.locator('[data-body-mode="Form"]').click();
  await page.getByRole('tablist', { name: 'Result' }).getByRole('tab', { name: /^Side effects/ }).click();
  await page.locator('#result .fx').first().waitFor();
  assert.match(await page.locator('#result .fx .tag').first().textContent(), /deliver|sent/i);
  await page.getByRole('tablist', { name: 'Result' }).getByRole('tab', { name: /^Database/ }).click();
  await page.locator('#result .banner-ok').waitFor();
  await compareShell(page, mock, '49-send-traced', 'state=filled&run=send&rtab=database');
}

/** Column edges, head line and bottom-bar line of the three columns showing now (see the v4 stable shell). */
const shellLines = page => page.evaluate(() => {
  const round = value => Math.round(value * 10) / 10;
  const [side, main, right] = document.querySelectorAll('.workspace > .sidebar, .workspace > .pane:not([hidden])');
  const head = pane => pane.querySelector(':scope > .tabs, :scope > #context > .ctx-bar, :scope > .ctx-bar, :scope > .aside-head, :scope > .resp-head').getBoundingClientRect().bottom;
  const bar = pane => pane.querySelector(':scope > .pane-bar, :scope > .actionbar').getBoundingClientRect().top;
  return {
    columns: [round(side.getBoundingClientRect().right), round(right.getBoundingClientRect().left)],
    heads: [side, main, right].map(pane => round(head(pane))), bars: [side, main, right].map(pane => round(bar(pane))),
  };
});

/** Fails unless the head line and bottom-bar line are one line across all three columns. */
async function assertAligned(page, label, expectedColumns) {
  const lines = await shellLines(page);
  assert.equal(new Set(lines.heads).size, 1, `${label}: head rows share one line ${JSON.stringify(lines)}`);
  assert.equal(new Set(lines.bars).size, 1, `${label}: bottom bars share one line ${JSON.stringify(lines)}`);
  if (expectedColumns) assert.deepEqual(lines.columns, expectedColumns, `${label}: column edges did not move`);
  // The shell fills the viewport exactly; only its panes scroll. Content leaking out of a pane's
  // scroll box (e.g. absolutely positioned .sr-only labels) would make the whole page scroll past the app.
  const page_ = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight, width: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
  assert.ok(page_.height <= page_.viewport && page_.width <= page_.viewportWidth, `${label}: the page itself does not scroll ${JSON.stringify(page_)}`);
  return lines;
}

/**
 * The language picker and the code samples: keyboard use, one remembered choice shared by Docs and
 * Try it, a trigger that never changes size, coloured tokens in every language, samples that never
 * wrap, and copying that carries code only (no line numbers) from the JSON viewers.
 */
async function verifyCodeSamples(page, url) {
  const LANGUAGES = ['cURL', 'JavaScript', 'Python', 'C#', 'Go', 'Java', 'Kotlin', 'PHP', 'Ruby', 'Rust', 'PowerShell'];
  await page.evaluate(() => localStorage.removeItem('sendproof-code-language'));
  await page.goto(`${url}/sendproof/#docs/PaymentsController.Create`);
  const trigger = page.locator('#docs-code-picker');
  const sample = page.locator('[data-sample]');
  await trigger.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-sample]')?.textContent.includes('curl'));
  const triggerBox = async () => trigger.evaluate(node => { const box = node.getBoundingClientRect(); return { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, x: Math.round(box.x), y: Math.round(box.y) }; });
  const copyX = async () => page.locator('[data-action="copy-sample"]').evaluate(node => Math.round(node.getBoundingClientRect().x));
  const first = await triggerBox();
  const copyBefore = await copyX();

  // Mouse: the list shows every language with its library, exactly one row is selected, and Esc returns focus.
  await trigger.click();
  const list = page.getByRole('listbox', { name: 'Language' });
  await list.waitFor();
  assert.deepEqual(await list.getByRole('option').locator('.main').allInnerTexts(), LANGUAGES, 'the picker lists every adapter language');
  assert.match(await list.getByRole('option', { name: /Python/ }).innerText(), /requests/, 'each row shows its client library');
  assert.equal(await list.locator('[aria-selected="true"]').count(), 1, 'exactly one row is selected');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await list.locator('svg.lang-ico').count(), LANGUAGES.length, 'every row has a mark');
  const gaps = await list.getByRole('option').evaluateAll(rows => rows.map(row => {
    const [main, end] = [row.querySelector('.main'), row.querySelector('.end')].map(node => node.getBoundingClientRect());
    return { name: row.querySelector('.main').textContent, gap: Math.round(Math.max(end.left - main.right, main.left - end.right)), clipped: row.querySelector('.end').scrollWidth > row.querySelector('.end').clientWidth };
  }));
  for (const { name, gap, clipped } of gaps) {
    assert.ok(gap >= 16, `${name} keeps a gap before its library (${gap}px)`);
    assert.equal(clipped, false, `${name}'s library is not truncated`);
  }
  await assertAligned(page, 'picker open');
  await page.screenshot({ path: join(artifacts, 'code-picker-open.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Esc returns focus to the trigger');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

  // Keyboard: ArrowDown opens on the selected row; arrows, Home, End and type-ahead move; Enter chooses.
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const focusedLanguage = () => page.evaluate(() => document.activeElement?.querySelector?.('.main')?.textContent);
  assert.equal(await focusedLanguage(), 'cURL', 'the list opens on the selected language');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focusedLanguage(), 'JavaScript');
  await page.keyboard.press('End');
  assert.equal(await focusedLanguage(), 'PowerShell');
  await page.keyboard.press('Home');
  assert.equal(await focusedLanguage(), 'cURL');
  await page.keyboard.press('r');
  assert.equal(await focusedLanguage(), 'Ruby', 'typing a letter jumps to the next language that starts with it');
  await page.keyboard.press('u');
  assert.equal(await focusedLanguage(), 'Ruby', 'typing more letters keeps the match that still fits');
  await page.keyboard.press('s');
  assert.equal(await focusedLanguage(), 'Rust', 'typing more letters narrows the match');
  await page.keyboard.press('Enter');
  await list.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'choosing returns focus to the trigger');
  assert.match(await trigger.innerText(), /Rust\s+reqwest/);
  assert.match(await sample.innerText(), /use reqwest::blocking::Client;/);
  await trigger.press('Enter');
  assert.equal(await page.locator('[role="option"][aria-selected="true"] .main').innerText(), 'Rust', 'the chosen row carries aria-selected');
  await page.keyboard.press('Escape');

  // A short window: the list scrolls inside the room it has instead of running off the screen.
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: 420 });
  await trigger.click();
  const shortBox = await page.getByRole('listbox').boundingBox();
  assert.ok(shortBox.y >= 0 && shortBox.y + shortBox.height <= 420, `the list fits a short window ${JSON.stringify(shortBox)}`);
  await page.keyboard.press('End');
  assert.equal(await focusedLanguage(), 'PowerShell', 'End reaches the last language even when the list scrolls');
  await page.keyboard.press('Escape');
  await page.setViewportSize(size);
  await page.locator('#aside-scroll').evaluate(pane => { pane.scrollTop = 0; });

  // The trigger is the same size, and nothing beside it moves, whichever language is chosen.
  for (const language of LANGUAGES) {
    await trigger.click();
    await page.getByRole('option').filter({ has: page.locator('.main', { hasText: new RegExp(`^${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).click();
    assert.deepEqual(await triggerBox(), first, `the trigger keeps its size and place for ${language}`);
    assert.equal(await copyX(), copyBefore, `the copy button does not move for ${language}`);
    assert.ok((await sample.innerText()).trim().length > 40, `${language} renders a sample`);
    const overflow = await sample.evaluate(node => ({ wrap: getComputedStyle(node).whiteSpace, x: getComputedStyle(node).overflowX }));
    assert.deepEqual(overflow, { wrap: 'pre', x: 'auto' }, `${language} samples never wrap; they scroll sideways`);
  }

  // Colours: tokens exist for cURL and fetch (they used to be plain text) and for every other language.
  for (const [language, kinds] of [['cURL', ['f', 'fl', 'u', 's', 'k']], ['JavaScript', ['kw', 'f', 'u', 'k', 's']], ['Python', ['kw', 'c', 'f', 's']], ['Go', ['kw', 'f', 's']], ['Rust', ['kw', 'f', 's', 'c']]]) {
    await trigger.click();
    await page.getByRole('option', { name: new RegExp(`^${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }).click();
    for (const kind of kinds) assert.ok(await sample.locator(`.tok-${kind}`).count() > 0, `${language} sample has .tok-${kind} tokens`);
  }
  const colours = await page.evaluate(() => {
    const color = selector => getComputedStyle(document.querySelector(`[data-sample] ${selector}`)).color;
    return { kw: color('.tok-kw'), f: color('.tok-f'), s: color('.tok-s') };
  });
  assert.equal(new Set(Object.values(colours)).size, 3, 'keyword, call and string colours differ');

  // The choice is remembered and shared: Rust here is Rust in Try it, and a change there shows in Docs.
  await trigger.click();
  await page.getByRole('option', { name: /^Rust\b/ }).click();
  await page.goto(`${url}/sendproof/#op/PaymentsController.Create`);
  await page.locator('[data-request-tab="Code"]').click();
  const editorTrigger = page.locator('#editor-code-picker');
  await editorTrigger.waitFor();
  assert.match(await editorTrigger.innerText(), /Rust\s+reqwest/, 'Try it uses the language chosen in Docs');
  assert.match(await page.locator('#snippet').innerText(), /use reqwest::blocking::Client;/);
  assert.equal(await editorTrigger.evaluate(node => Math.round(node.getBoundingClientRect().width * 10) / 10), first.width, 'both screens use the same trigger width');
  await editorTrigger.click();
  await page.getByRole('option', { name: /^Python\b/ }).click();
  assert.equal(await editorTrigger.evaluate(node => node === document.activeElement), true, 'focus returns to the Try it trigger after the panel re-renders');
  for (const kind of ['kw', 'f', 's', 'k']) assert.ok(await page.locator(`#snippet .tok-${kind}`).count() > 0, `Python Code panel has .tok-${kind}`);
  const stored = await page.evaluate(() => localStorage.getItem('sendproof-code-language'));
  assert.equal(stored, 'python', 'the choice is stored');
  await page.goto(`${url}/sendproof/#docs/PaymentsController.Create`);
  await trigger.waitFor();
  assert.match(await trigger.innerText(), /Python\s+requests/, 'Docs shows the language chosen in Try it');
  await page.reload();
  await trigger.waitFor();
  assert.match(await trigger.innerText(), /Python\s+requests/, 'the choice survives a reload');
  await assertAligned(page, 'docs with samples');

  // Selecting JSON selects code only: the gutter cannot be selected, and the copy event carries the code with its indentation.
  const example = page.locator('.sample-card [role="tabpanel"]:not([hidden]) .code-view').first();
  await example.waitFor();
  const gutter = await example.locator('.ln').first().evaluate(line => Object.fromEntries(['.no', '.fold', '.src'].map(selector => [selector, line.querySelector(selector) ? getComputedStyle(line.querySelector(selector)).userSelect : 'absent'])));
  assert.equal(gutter['.no'], 'none', 'the line number cannot be selected');
  assert.ok(['none', 'absent'].includes(gutter['.fold']), 'the fold button cannot be selected');
  assert.notEqual(gutter['.src'], 'none', 'the code itself can be selected');
  const lineCount = await example.locator('.ln').count();
  assert.ok(lineCount >= 6, 'the response example has several lines');
  const first_ = example.locator('.ln').nth(1).locator('.src');
  const last_ = example.locator('.ln').nth(4).locator('.src');
  await first_.scrollIntoViewIfNeeded();
  const [a, b] = [await first_.boundingBox(), await last_.boundingBox()];
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.min(b.width, 120), b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString());
  assert.ok(selected.includes('\n'), 'the drag selects several lines');
  assert.doesNotMatch(selected, /^\s*\d+\s*$/m, 'Selection.toString() has no line numbers either: they are generated content');
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented, lines: [...document.querySelector('.sample-card [role="tabpanel"]:not([hidden]) .code-view').querySelectorAll('.ln .src')].map(src => ({ text: src.textContent, depth: Number(src.style.getPropertyValue('--d')) })) };
  });
  assert.equal(copied.prevented, true, 'the viewer takes over the copy');
  const rows = copied.text.split('\n');
  assert.ok(rows.length >= 3, 'several lines were copied');
  assert.doesNotMatch(copied.text, /(^|\n)\s*\d+\s*(\n|$)/, 'the copied text has no line numbers');
  assert.doesNotMatch(copied.text, /Copy|Collapse|Expand/, 'the copied text has no button labels');
  const expected = copied.lines.slice(1, 5).map(line => '  '.repeat(line.depth) + line.text);
  // The drag ends part-way along its last line, so that line is a prefix; the lines before it are whole.
  assert.equal(rows.slice(1, -1).join('\n'), expected.slice(1, rows.length - 1).join('\n'), 'inner lines keep their indentation and line breaks');
  assert.ok(expected[rows.length - 1].startsWith(rows.at(-1)), 'the last line is the selected part of its source');
  assert.ok(rows.every(row => !/^\d+$/.test(row.trim())), 'no copied line is only a number');
  await page.evaluate(() => getSelection().removeAllRanges());
  // Leave on Try it, where the rest of the run continues.
  await page.goto(`${url}/sendproof/#op/PaymentsController.Create`);
  await page.locator('[data-body-mode="JSON"]').waitFor();
}

/** Docs, Models, navigation, history, remembered groups and the JSON viewer (mocks 57–75, m13–m17). */
async function verifyReference(page, mock, url) {
  const reading = '#doc-pane';
  const scroller = '#doc-pane [data-scroll="main"]';
  const compareReading = async (name, query) => {
    await mock.goto(pathToFileURL(join(root, 'mocks', 'workbench.html')).href + '?' + query);
    await mock.evaluate(() => document.fonts.ready);
    await evidence(page, mock, name);
    await compareLayout(page, mock, name, [
      ['sidebar', '.sidebar', '.sidebar'], ['main pane', '#doc-pane', '.doc-pane'], ['right pane', '#aside-pane', '.aside-pane'],
      ['head row', '#doc-pane .ctx-bar', '.doc-pane .ctx-bar', ['x', 'y', 'width', 'height']],
      ['bottom bar', '#doc-pane .pane-bar', '.doc-pane .pane-bar', ['x', 'y', 'width', 'height']],
      ['right bottom bar', '#aside-pane .pane-bar', '.aside-pane .pane-bar', ['x', 'y', 'width', 'height']],
    ], 1).catch(error => layoutFailures.push(error.message));
  };

  // One stable shell: columns, head line and bottom line are identical in Try it, Docs and Models,
  // also after dragging the divider, resizing the window and switching views.
  await page.goto(`${url}/sendproof/#op/PaymentsController.Create`);
  await page.locator('#request .op-title').waitFor();
  const columns = (await assertAligned(page, 'Try it')).columns;
  await page.keyboard.press('d');
  await page.locator(reading).waitFor();
  await assertAligned(page, 'Docs', columns);
  await compareReading('24-docs', 'view=docs');
  await page.locator('[data-body-view="example"]').click();
  assert.ok(await page.locator('#doc-pane .code-view').count(), 'the body Example view is a JSON viewer');
  await page.locator('[data-body-view="schema"]').click();
  await page.locator('#doc-pane .type-link[data-model]').first().click();
  await page.locator('#model-title').waitFor();
  await assertAligned(page, 'Model from an operation', columns);
  const handle = page.getByRole('separator', { name: /Resize (the )?(main|panes|request)/i }).first();
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const moved = await assertAligned(page, 'Model after moving the divider');
  assert.notDeepEqual(moved.columns, columns, 'the divider moved');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('#doc-title').waitFor();
  await assertAligned(page, 'Docs after the divider moved', moved.columns);
  await page.keyboard.press('d');
  await page.locator('#request .op-title').waitFor();
  await assertAligned(page, 'Try it after the divider moved', moved.columns);
  await page.setViewportSize({ width: 1200, height: 800 });
  await assertAligned(page, 'Try it after resizing the window');
  await page.keyboard.press('d');
  await assertAligned(page, 'Docs after resizing the window');
  await page.setViewportSize({ width: 1440, height: 900 });
  await handle.dblclick({ position: { x: 4, y: 20 } });

  // A JSON response opens with every node expanded.
  await page.goto(`${url}/sendproof/#op/PaymentsController.List`);
  await page.locator('.actionbar [data-action="send"]').click();
  await page.locator('.response:not([aria-busy="true"]) .resp-head .status-code').waitFor();
  assert.equal(await page.locator('#result .code-view .fold[aria-expanded="false"]').count(), 0, 'every JSON node opens expanded');
  assert.ok(await page.locator('#result .code-view .fold[aria-expanded="true"]').count() > 1, 'the response has foldable nodes');
  await page.locator('#result [data-fold-all]').click();
  assert.ok(await page.locator('#result .code-view .fold[aria-expanded="false"]').count(), 'Collapse all collapses');
  await page.locator('#result [data-fold-all]').click();
  assert.equal(await page.locator('#result .code-view .fold[aria-expanded="false"]').count(), 0, 'Expand all opens everything again');

  // Docs → model → ⌥←: back on Docs, same scroll position; browser history and deep links work.
  await page.goto(`${url}/sendproof/#docs/PaymentsController.Create`);
  await page.locator(reading).waitFor();
  await page.locator(scroller).evaluate(node => { node.scrollTop = 500; });
  const scrollBefore = await page.locator(scroller).evaluate(node => node.scrollTop);
  assert.ok(scrollBefore > 0, 'the Docs page scrolls');
  await page.locator('#doc-pane .type-link[data-model]').first().click();
  await page.locator('#model-title').waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#model\/\w+\?from=docs\/PaymentsController\.Create$/, 'the model address names its operation');
  assert.equal(await page.locator('#doc-pane .crumbs li').count(), 3, 'Tag › Operation › Model breadcrumbs');
  assert.equal(await page.locator('#doc-pane [data-action="model-back"]').count(), 1, 'one Back control');
  assert.equal(await page.locator('.pane-bar [data-action="model-back"]').count(), 0, 'no Back in the bottom bar');
  assert.equal(await page.locator('.nav-item.is-context[aria-current="location"]').count(), 1, 'the operation stays marked as context');
  assert.equal(await page.locator('#side-tab-operations').getAttribute('aria-selected'), 'true', 'the sidebar tab did not change');
  assert.match(await page.locator('[data-action="model-back"]').innerText(), /^Back to Create payment/, 'Back names its target');
  await page.locator('[data-action="model-back"]').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('#doc-title').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#docs/PaymentsController.Create');
  assert.equal(await page.locator(scroller).evaluate(node => node.scrollTop), scrollBefore, 'Back restores the Docs scroll position');
  await page.goForward();
  await page.locator('#model-title').waitFor();
  await page.goBack();
  await page.locator('#doc-title').waitFor();
  assert.equal(await page.locator(scroller).evaluate(node => node.scrollTop), scrollBefore, 'browser Back restores it too');
  await page.goto(`${url}/sendproof/#model/Payment?from=docs/PaymentsController.Create`);
  await page.reload();
  await page.locator('#model-title').waitFor();
  assert.equal((await page.locator('#doc-pane .crumbs').innerText()).replace(/\s+/g, ' ').trim(), 'Payments Create payment Payment', 'a deep link reload shows the breadcrumbs');
  await page.locator('#doc-pane [data-action="model-back"]').click();
  await page.locator('#doc-title').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#docs/PaymentsController.Create', 'Back works after a reload, with no earlier entry');
  // A $ref followed from a model extends the trail.
  await page.goto(`${url}/sendproof/#model/Payment?from=docs/PaymentsController.Create`);
  await page.locator('#model-title').waitFor();
  await page.locator('#doc-pane .attr-type.is-ref').first().click();
  assert.match(await page.evaluate(() => location.hash), /via=Payment$/, 'following a $ref adds the model to the trail');
  assert.match(await page.locator('[data-action="model-back"]').innerText(), /^Back to Payment/);

  // A model picked in the Models tab: Models › Group › Model and no Back.
  await page.goto(`${url}/sendproof/#model/Payment`);
  await page.locator('#model-title').waitFor();
  assert.equal((await page.locator('#doc-pane .crumbs').innerText()).replace(/\s+/g, ' ').trim(), 'Models Resources Payment');
  assert.equal(await page.locator('#doc-pane [data-action="model-back"]').count(), 0, 'no Back for a model picked in the Models tab');
  assert.equal(await page.locator('#side-tab-models').getAttribute('aria-selected'), 'true');
  await compareReading('27-model-payment', 'view=model&model=Payment&side=models');
  await audit(page, 'model page');

  // Sidebar groups start open, collapse, and stay collapsed after a reload.
  await page.goto(`${url}/sendproof/#overview`);
  await page.locator('#side-tab-operations').click();
  await page.locator('.nav-heading').first().waitFor();
  const states = () => page.locator('.nav-heading').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded')));
  assert.ok((await states()).every(state => state === 'true'), 'every operation group starts open');
  await page.locator('.nav-heading').first().click();
  assert.equal((await states())[0], 'false', 'a heading collapses its group');
  await page.reload();
  await page.locator('.nav-heading').first().waitFor();
  assert.equal((await states())[0], 'false', 'the collapsed group is remembered after a reload');
  await page.locator('[data-action="toggle-groups"]').click();
  assert.ok((await states()).every(state => state === 'false'), 'Collapse all closes every group');
  await page.locator('[data-action="toggle-groups"]').click();
  assert.ok((await states()).every(state => state === 'true'), 'Expand all opens them again');
  await page.locator('#side-tab-models').click();
  const lists = page.locator('.nav-heading[data-group="lists"]');
  assert.equal(await lists.getAttribute('aria-expanded'), 'false', 'List pages start collapsed');
  await page.locator('#side-tab-operations').click();
  await audit(page, 'docs page');
}

/** Puts the language (and theme) in local storage and reloads at a route. */
async function withSettings(page, url, hash, { language = 'en-IE', theme = 'light' } = {}) {
  await page.evaluate(([language, theme]) => localStorage.setItem('sendproof-settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('sendproof-settings') || '{}'), language, theme })), [language, theme]);
  await page.goto(`${url}/sendproof/${hash}`);
  await page.locator('.sidebar .nav-heading').first().waitFor({ state: 'attached' });
  // A phone shows one pane at a time: start on the request.
  if (await page.locator('.mobile-switch [data-view="request"]').isVisible()) await page.locator('.mobile-switch [data-view="request"]').click();
  await page.waitForTimeout(300);
}

const activeOption = page => page.evaluate(() => {
  const id = document.activeElement?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.querySelector('.v')?.textContent.trim() : undefined;
});
const noPageScroll = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal page scroll`);

/**
 * The v5 controls (mocks 76–112, m18–m25): the select's keyboard model, the radio group,
 * popover anchoring in both directions, bottom sheets on a phone, the deprecation notice's
 * carry-over, the one-line response toolbar at the narrowest pane, the Table view and no
 * horizontal page scroll. Each state gets an axe audit.
 */
async function verifyV5Controls(page, url) {
  await withSettings(page, url, '#op/AccountsController.List');
  await page.locator('[data-request-tab="Params"]').click();
  await noPageScroll(page, 'Try it');
  // Select: ↓ opens, Home and End jump, type-ahead finds a value, Enter chooses, Esc returns focus.
  const type = () => page.getByRole('combobox', { name: /^type$/i });
  await type().focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await type().getAttribute('aria-expanded'), 'true', 'ArrowDown opens the select');
  await audit(page, 'select open');
  const control = await type().boundingBox();
  const list = await page.locator('.lb').boundingBox();
  assert.ok(Math.abs(list.x - control.x) <= 1, 'the listbox lines up with the control’s start edge');
  assert.ok(list.width >= control.width - 1, 'the listbox is at least the control’s width');
  assert.ok(list.y >= control.y + control.height || list.y + list.height <= control.y, 'the listbox never covers its control');
  await page.keyboard.press('End');
  assert.equal(await activeOption(page), 'Escrow', 'End jumps to the last value');
  await page.keyboard.press('Home');
  assert.equal(await activeOption(page), 'Any', 'Home jumps to "Any"');
  await page.keyboard.press('s');
  assert.equal(await activeOption(page), 'Savings', 'type-ahead jumps to the value that starts with what was typed');
  assert.match(await page.locator('.lb [data-typed]').innerText(), /Typed\s+s/, 'the footer echoes what was typed');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.lb').count(), 0, 'Enter chooses and closes');
  assert.equal(await type().innerText(), 'Savings');
  assert.equal(await type().evaluate(node => node === document.activeElement), true, 'focus stays on the select');
  assert.match(await page.locator('[data-parameter-name="type"] .assist').innerText(), /Sends type=Savings/, 'the status line says what will be sent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.lb').count(), 0, 'Escape closes the listbox');
  assert.equal(await type().evaluate(node => node === document.activeElement), true, 'Escape returns focus to the select');
  await page.locator('[data-parameter-name="type"] .field-clear').click();
  assert.match(await type().innerText(), /Any/, 'Clear unsets an optional select');
  // More than 8 values get a search box that matches values and descriptions.
  await page.getByRole('combobox', { name: /^currency$/i }).click();
  const search = page.locator('.lb .lb-search input');
  await search.fill('kr');
  assert.ok(await page.locator('.lb .lb-opt').count() >= 2, 'search matches the krona and krone');
  await page.keyboard.press('Escape');
  assert.equal(await search.inputValue(), '', 'Esc clears the search first');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.lb').count(), 0);
  // Radio group: arrows move and choose, Delete clears an optional value.
  const status = page.getByRole('radiogroup', { name: /^status$/i });
  await status.getByRole('radio', { name: 'Open' }).click();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radiogroup', { name: /^status$/i }).getByRole('radio', { name: 'Frozen' }).getAttribute('aria-checked'), 'true', 'ArrowRight chooses the next value');
  await page.keyboard.press('Delete');
  assert.equal(await page.getByRole('radiogroup', { name: /^status$/i }).locator('[aria-checked="true"]').count(), 0, 'Delete clears an optional radio group');
  await audit(page, 'radio group and selects');

  // RTL: the listbox anchors to the control's start edge, the right.
  await withSettings(page, url, '#op/AccountsController.List', { language: 'he-IL' });
  await page.locator('[data-request-tab="Params"]').click();
  const rtlType = page.locator('[data-parameter-name="type"] [role="combobox"]');
  await rtlType.click();
  const [rtlControl, rtlList] = [await rtlType.boundingBox(), await page.locator('.lb').boundingBox()];
  assert.ok(Math.abs(rtlList.x + rtlList.width - (rtlControl.x + rtlControl.width)) <= 1, 'in RTL the listbox lines up with the control’s right edge');
  await audit(page, 'select open, RTL');
  await page.keyboard.press('Escape');
  await noPageScroll(page, 'Hebrew Try it');

  // Language picker: 34 languages; search covers English names; an RTL row previews a field.
  await withSettings(page, url, '#op/AccountsController.List');
  await page.locator('#display-btn').click();
  await page.locator('#display-language').click();
  assert.equal(await page.locator('.lang-pop .lb-opt').count(), 34, 'the picker lists 34 languages');
  await page.locator('.lang-pop .lb-search input').fill('he');
  assert.ok(await page.locator('.lang-pop .lb-opt', { hasText: 'עברית' }).count(), '"he" finds Hebrew');
  assert.ok(await page.locator('.lang-pop .lb-opt', { hasText: 'Nederlands' }).count(), '"he" finds Dutch through "Netherlands"');
  await page.locator('.lang-pop .lb-opt', { hasText: 'עברית' }).hover();
  await page.locator('.lang-preview .lp-box[dir="rtl"]').waitFor();
  await audit(page, 'language picker');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Display settings' }).count(), 1, 'Esc closes the picker and leaves Display settings open');
  await page.keyboard.press('Escape');

  // Deprecation: "Open Get balance" opens the replacement with id carried over as accountId.
  await withSettings(page, url, '#op/BalancesController.LegacyBalance');
  await page.locator('[data-request-tab="Params"]').click();
  const notice = page.locator('.request .dep');
  assert.match(await notice.innerText(), /Stops working on 30 June 2027/);
  assert.match(await notice.innerText(), /Carries over id as accountId/);
  await audit(page, 'deprecation notice');
  const legacyId = page.locator('[data-parameter-name="id"] [role="combobox"]');
  await pickLookup(page, legacyId, /./);
  const chosen = (await legacyId.locator('.picked .main').innerText()).trim();
  await page.locator('[data-replace-op]').click();
  await page.waitForFunction(() => location.hash === '#op/BalancesController.Get');
  await page.locator('[data-parameter-name="accountId"] .picked .main').waitFor();
  assert.equal((await page.locator('[data-parameter-name="accountId"] .picked .main').innerText()).trim(), chosen, 'the replacement opens with id carried over as accountId');

  // The response toolbar stays on one line at the narrowest result pane; the match sits in the status line.
  await withSettings(page, url, '#op/AccountsController.List');
  await page.locator('.actionbar [data-action="send"]').click();
  await page.locator('.resp-head .match').waitFor();
  const oneLine = () => page.locator('.response-viewer .viewer-bar.vb').evaluate(bar => {
    const tops = [...bar.children].filter(node => node.offsetParent).map(node => Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2));
    return Math.max(...tops) - Math.min(...tops) <= 2 && bar.scrollWidth <= bar.clientWidth + 1;
  });
  assert.equal(await oneLine(), true, 'the toolbar is one line');
  await page.locator('.workspace').evaluate(node => { node.style.gridTemplateColumns = 'var(--sidebar-width, 15.5rem) minmax(0, 1fr) 20rem'; });
  await page.waitForTimeout(200);
  assert.equal(await oneLine(), true, 'the toolbar stays one line in a 20rem result pane');
  await page.locator('.workspace').evaluate(node => { node.style.gridTemplateColumns = ''; });
  await page.locator('.resp-head .match').click();
  await page.locator('.match-tip').waitFor();
  await audit(page, 'schema match toggletip');
  await page.keyboard.press('Escape');
  // Table: a real table with a sticky header, the name column first, sideways scroll inside it.
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('.tbl table').waitFor();
  assert.equal(await page.locator('.tbl thead th').first().evaluate(node => getComputedStyle(node).position), 'sticky', 'the header is sticky');
  assert.equal((await page.locator('.tbl thead th.lead').innerText()).trim(), 'name', 'the record’s name leads');
  assert.equal(await page.locator('[data-table-more]').isVisible(), true, 'the footer says how many columns there are to scroll to');
  await noPageScroll(page, 'Table view');
  await audit(page, 'table view');
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  assert.equal(await page.locator('.code-view.is-raw .ln .src').first().evaluate(node => getComputedStyle(node).whiteSpace), 'pre', 'Raw does not wrap');
  await page.locator('[data-wrap]').click();
  assert.equal(await page.locator('.code-view.is-raw .ln .src').first().evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap', 'Wrap is an option');

  // A phone: selects, the lookup and the language picker are bottom sheets.
  await page.setViewportSize({ width: 390, height: 844 });
  await withSettings(page, url, '#op/AccountsController.List');
  await page.locator('[data-request-tab="Params"]').click();
  await page.getByRole('combobox', { name: /^type$/i }).click();
  const sheet = page.locator('.lb.is-sheet');
  await sheet.waitFor();
  assert.equal(await sheet.getAttribute('role'), 'dialog', 'the sheet is a dialog');
  assert.equal(await sheet.getAttribute('aria-modal'), 'true');
  const box = await sheet.boundingBox();
  assert.ok(Math.abs(box.y + box.height - 844) <= 1 && Math.abs(box.width - 390) <= 1, 'the sheet sits at the bottom, full width');
  assert.ok((await sheet.locator('[data-sheet-close]').boundingBox()).height >= 44, 'Close is a 44 px target');
  await audit(page, 'select sheet');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('combobox', { name: /^type$/i }).evaluate(node => node === document.activeElement), true, 'closing the sheet returns focus');
  await withSettings(page, url, '#op/AccountsController.Get');
  await page.locator('[data-parameter-name="id"] [role="combobox"]').click();
  await page.locator('.lb.is-sheet .lb-src').waitFor();
  await audit(page, 'lookup sheet');
  await page.keyboard.press('Escape');
  await noPageScroll(page, 'phone Try it');
  await page.setViewportSize({ width: 1440, height: 900 });
  await withSettings(page, url, '#op/AccountsController.List');
}

/**
 * Reports every label that clips, overlaps or leaves the viewport, in whatever page is open: the
 * run buttons, the Try it | Docs switch, the Back button and the mobile Request | Result switch
 * must hold their whole label inside their own box and inside the viewport, no two run buttons
 * may overlap, and every crumb must keep a readable stub of its text (3 rem for an earlier crumb,
 * 5 rem for the page) with its full text in a title. Runs in the page.
 */
const clipProblems = (checkPageScroll = true) => {
  const problems = [];
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const shown = node => node.getClientRects().length > 0;
  const name = node => `${node.className.toString().split(' ').filter(Boolean).slice(0, 2).join('.')} “${node.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)}”`;
  const buttons = [...document.querySelectorAll('.actionbar .btn-run, .ctx-bar .view-switch button, .ctx-bar .back-btn, .mobile-switch button')].filter(shown);
  for (const node of buttons) {
    const box = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const content = range.getBoundingClientRect();
    if (content.left < box.left - 0.5 || content.right > box.right + 0.5) problems.push(`${name(node)} label leaves its button (${content.left.toFixed(1)}–${content.right.toFixed(1)} in ${box.left.toFixed(1)}–${box.right.toFixed(1)})`);
    if (box.left < -0.5 || box.right > innerWidth + 0.5) problems.push(`${name(node)} leaves the viewport (${box.left.toFixed(1)}–${box.right.toFixed(1)} of ${innerWidth})`);
    if (node.scrollWidth > node.clientWidth + 1) problems.push(`${name(node)} scrolls (${node.scrollWidth} > ${node.clientWidth})`);
  }
  const runButtons = buttons.filter(node => node.matches('.actionbar .btn-run')).map(node => node.getBoundingClientRect());
  runButtons.forEach((a, index) => runButtons.slice(index + 1).forEach(b => {
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) problems.push('two run buttons overlap');
  }));
  const crumbs = [...document.querySelectorAll('.ctx-bar .crumbs li')].filter(shown);
  crumbs.forEach((item, index) => {
    const text = item.querySelector('a, [aria-current]');
    const here = index === crumbs.length - 1;
    const readable = Math.min(text.scrollWidth, (here ? 5 : 3) * rem);
    if (text.clientWidth < readable - 0.5) problems.push(`crumb ${name(text)} shows only ${text.clientWidth}px of ${text.scrollWidth}px`);
    if (text.getAttribute('title') !== text.textContent.trim()) problems.push(`crumb ${name(text)} has no title with its full text`);
  });
  // The sidebar's controls (the Operations | Models tabs, the signed-out notice's Sign in and seeded-account
  // buttons, the foot bar) keep their whole label, inside their own box and inside the sidebar.
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && shown(sidebar)) {
    const edge = sidebar.getBoundingClientRect();
    for (const node of sidebar.querySelectorAll('.tab, .auth-notice .btn, .foot button')) {
      if (!shown(node)) continue;
      const box = node.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(node);
      const content = range.getBoundingClientRect();
      if (content.left < box.left - 0.5 || content.right > box.right + 0.5 || content.top < box.top - 0.5 || content.bottom > box.bottom + 0.5) problems.push(`sidebar ${name(node)} label leaves its button`);
      // A tab's own box includes empty padding (English's overshoots by a few pixels); what must stay inside is its label and count.
      const seen = node.matches('.tab') ? content : box;
      if (seen.left < edge.left - 0.5 || seen.right > edge.right + 0.5) problems.push(`sidebar ${name(node)} leaves the sidebar (${seen.left.toFixed(1)}–${seen.right.toFixed(1)} of ${edge.left.toFixed(1)}–${edge.right.toFixed(1)})`);
      if (node.scrollWidth > node.clientWidth + 1) problems.push(`sidebar ${name(node)} scrolls (${node.scrollWidth} > ${node.clientWidth})`);
      for (const label of node.querySelectorAll(':scope > span:not(.n):not(.flag):not(.sr-only)')) {
        if (label.scrollWidth > label.clientWidth + 1 && node.getAttribute('title') !== label.textContent.trim()) problems.push(`sidebar ${name(node)} shortens its label without a title (${label.scrollWidth} > ${label.clientWidth})`);
      }
    }
  }
  if (checkPageScroll && document.documentElement.scrollWidth > document.documentElement.clientWidth) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth})`);
  return problems;
};

/** Opens a route in one language and reloads, so the language really changes. */
async function openIn(page, url, hash, language) {
  await page.evaluate(language => localStorage.setItem('sendproof-settings', JSON.stringify({ language, theme: 'light' })), language);
  await page.goto(`${url}/sendproof/${hash}`);
  await page.reload();
  await page.locator('.sidebar .nav-heading').first().waitFor({ state: 'attached' });
  if (await page.locator('.mobile-switch [data-view="request"]').isVisible()) await page.locator('.mobile-switch [data-view="request"]').click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/**
 * The host may refuse the seeded-account list (the Treasury example answers 403 when the workbench is
 * opened from another machine). Then the option is hidden everywhere, with no error and no layout
 * shift: the sidebar notice has no seeded button, the sign-in page shows a pointer to password
 * sign-in instead of the panel, and the notice does not move once the page has settled. A 500 keeps
 * today's behaviour (the option stays, the sign-in panel shows its error row).
 */
async function verifyPersonaRefusal(browser, url) {
  const open = async status => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IE' });
    await serveUiFromDirectory(context);
    await context.route(/\/auth\/personas$/, route => route.fulfill({ status, contentType: 'application/json', body: status === 500 ? 'boom' : '{}' }));
    const view = await context.newPage();
    view.setDefaultTimeout(5000);
    const shifts = [];
    await view.addInitScript(() => {
      window.__noticeRects = [];
      new MutationObserver(() => {
        const notice = document.querySelector('.sidebar .auth-notice');
        if (notice) { const box = notice.getBoundingClientRect(); window.__noticeRects.push([box.top, box.height]); }
      }).observe(document, { childList: true, subtree: true });
    });
    await view.goto(`${url}/sendproof/#op/PaymentsController.Create`);
    await view.locator('.sidebar .auth-notice').waitFor();
    await view.waitForTimeout(600);
    shifts.push(...await view.evaluate(() => [...new Set(window.__noticeRects.map(rect => rect.join(':')))]));
    return { context, view, shifts };
  };
  for (const status of [403, 401, 404]) {
    const { context, view, shifts } = await open(status);
    try {
      assert.equal(await view.locator('.sidebar .auth-notice [data-action="signin"]').isVisible(), true, `${status}: Sign in stays`);
      assert.equal(await view.locator('.sidebar .auth-notice [data-action="seeded-menu"]').count(), 0, `${status}: no seeded-account button`);
      assert.equal(await view.locator('[role="alert"]').count(), 0, `${status}: no error shown`);
      assert.equal(shifts.length, 1, `${status}: the notice is drawn once and never moves (${shifts.join(' → ')})`);
      await view.locator('.sidebar .auth-notice [data-action="signin"]').click();
      await view.locator('#email').waitFor();
      await view.locator('#personas-refused').waitFor();
      assert.equal(await view.locator('.persona-card, .persona-row').count(), 0, `${status}: no seeded panel on the sign-in page`);
      assert.equal(await view.locator('#signin-form [type="submit"]').isVisible(), true, `${status}: password sign-in remains`);
      assert.deepEqual(await view.evaluate(clipProblems), [], `${status}: the sign-in page does not clip`);
      await audit(view, `sign-in without seeded accounts (${status})`);
    } finally { await context.close(); }
  }
  const { context, view } = await open(500);
  try {
    assert.equal(await view.locator('.sidebar .auth-notice [data-action="seeded-menu"]').count(), 1, '500: the seeded-account button stays');
    await view.locator('.sidebar .auth-notice [data-action="signin"]').click();
    await view.locator('#email').waitFor();
    await view.locator('#personas [role="alert"]').waitFor();
    assert.equal(await view.locator('#personas-refused').count(), 0, '500: no pointer, the error row shows instead');
  } finally { await context.close(); }
}

/**
 * Every catalogue (one language each; Arabic, Hebrew and Persian are the right-to-left ones), signed
 * out, at 320, 768, 1100 and 1440 px and at 100 % and 130 % text: no sidebar control may clip (the
 * navigation drawer is opened where the sidebar is one), and the page may never scroll sideways.
 * Runs in its own signed-out context, since the signed-out notice (and its Sign in button) only
 * exists there.
 */
async function verifyLocaleLayouts(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IE' });
  await serveUiFromDirectory(context);
  const sweep = await context.newPage();
  sweep.setDefaultTimeout(5000);
  try {
    await sweep.goto(`${url}/sendproof/`);
    const languages = await sweep.evaluate(async () => {
      const { LANGUAGES, CATALOGUES } = await import('/sendproof/i18n.js');
      return CATALOGUES.map(id => LANGUAGES.find(item => item.catalogue === id).id);
    });
    assert.ok(languages.length >= 25, 'every catalogue is swept');
    const failures = [];
    for (const language of languages) {
      await openIn(sweep, url, '#op/PaymentsController.Create', language);
      for (const width of [320, 768, 1100, 1440]) {
        await sweep.setViewportSize({ width, height: 800 });
        for (const size of ['100%', '130%']) {
          await sweep.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
          const drawer = sweep.locator('[data-action="navigation"]');
          const opened = await drawer.isVisible();
          if (opened) await drawer.click();
          await sweep.evaluate(() => document.fonts.ready);
          await sweep.waitForTimeout(100);
          // The head row and run buttons are judged elsewhere (verifyNoClipping); here the sidebar and the page.
          const problems = (await sweep.evaluate(clipProblems)).filter(problem => problem.startsWith('sidebar ') || problem.startsWith('the page scrolls'));
          if (problems.length) failures.push(`${language} ${width} px ${size}: ${problems.join('; ')}`);
          if (opened) await sweep.keyboard.press('Escape');
        }
      }
    }
    assert.deepEqual(failures, [], 'no sidebar control clips and no page scrolls sideways in any catalogue');
  } finally {
    await context.close();
  }
}

/**
 * Long translations at the smallest phone with large text: Greek, Russian and Ukrainian (the
 * longest Send, Preview and Docs labels) and Arabic (right to left) at 320 px with 130 % text must
 * not clip a crumb or a button label, in Try it, Docs, a model page and the "Send for real?"
 * confirmation. The fixed Send and Preview widths of every catalogue (tools/measure-widths.mjs)
 * must hold the real label with its keycaps at all three densities and both platforms.
 */
async function verifyNoClipping(page, url) {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const language of ['el-GR', 'ru-RU', 'uk-UA', 'ar']) {
    for (const hash of ['#op/PaymentsController.Create', '#docs/PaymentsController.Create', '#model/Payment?from=docs/PaymentsController.Create']) {
      await openIn(page, url, hash, language);
      await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
      await page.waitForTimeout(150);
      assert.deepEqual(await page.evaluate(clipProblems), [], `${language} ${hash} at 320 px and 130% text`);
    }
    await openIn(page, url, '#op/PaymentsController.Create', language);
    await page.evaluate(async () => {
      document.documentElement.style.fontSize = '130%';
      const { confirmation } = await import('/sendproof/action-bar.js');
      document.querySelector('.actionbar').innerHTML = confirmation('POST', '/api/v2/payments');
    });
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(clipProblems), [], `${language} confirmation at 320 px and 130% text`);
  }

  // A crowded desktop pane: the switch wraps below the crumbs instead of squeezing them.
  await page.setViewportSize({ width: 1100, height: 800 });
  for (const language of ['el-GR', 'ru-RU']) {
    await openIn(page, url, '#op/PaymentsController.Create', language);
    await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
    await page.waitForTimeout(150);
    // The response tabs scroll sideways inside their own pane; the page itself must never scroll sideways.
    assert.deepEqual(await page.evaluate(clipProblems), [], `${language} at 1100 px and 130% text`);
  }

  // Every catalogue's fixed Send and Preview widths hold the label, keycaps and padding.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openIn(page, url, '#op/PaymentsController.Create', 'en-IE');
  const tooNarrow = await page.evaluate(async () => {
    const { LANGUAGES, CATALOGUES, configure, loadLanguage, runButtonWidths } = await import('/sendproof/i18n.js');
    const { updateSettings } = await import('/sendproof/settings.js');
    const { runButtons } = await import('/sendproof/action-bar.js');
    const host = document.createElement('div');
    host.className = 'actionbar';
    host.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;inline-size:max-content;block-size:auto;visibility:hidden';
    document.body.append(host);
    const failures = [];
    for (const id of CATALOGUES) {
      const language = LANGUAGES.find(item => item.catalogue === id).id;
      await loadLanguage(language);
      for (const platform of ['mac', 'win']) {
        for (const density of ['compact', 'default', 'comfortable']) {
          updateSettings({ language, density });
          configure({ language, platform });
          const widths = runButtonWidths();
          document.documentElement.style.setProperty('--w-preview', widths.preview);
          document.documentElement.style.setProperty('--w-send', widths.send);
          host.innerHTML = runButtons({ method: 'POST' }, true) + runButtons({ method: 'GET' }, true);
          // Script fonts load after the first layout: wait until the widths stop moving.
          let last = '';
          for (let attempt = 0; attempt < 60; attempt++) {
            await document.fonts.ready;
            await new Promise(resolve => setTimeout(resolve, 60));
            const now = [...host.querySelectorAll('.btn-run')].map(node => node.scrollWidth).join();
            if (now === last && document.fonts.status === 'loaded') break;
            last = now;
          }
          for (const node of host.querySelectorAll('.btn-run')) {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node);
            const content = range.getBoundingClientRect();
            const room = parseFloat(style.paddingInlineStart);
            if (content.left < box.left + room - 0.5 || content.right > box.right - room + 0.5) failures.push(`${id} ${platform} ${density} ${node.dataset.action}`);
          }
        }
      }
    }
    host.remove();
    return failures;
  });
  assert.deepEqual(tooNarrow, [], 'every catalogue’s Send and Preview width holds its label (node tools/measure-widths.mjs --write)');
  // Back to English at the default density (openIn stores the language alone).
  await openIn(page, url, '#op/AccountsController.List', 'en-IE');
}

try {
  const url = await startHost();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-IE' });
  await serveUiFromDirectory(context);
  page = await context.newPage();
  mock = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  watchPage(page);
  page.setDefaultTimeout(5000);
  mock.setDefaultTimeout(5000);
  // Check the actual discovery contract, then follow its advertised OpenAPI URL.
  const discovery = await context.request.get(`${url}/sendproof/_api/capabilities`);
  assert.equal(discovery.status(), 200, 'capabilities discovery');
  const capabilities = await discovery.json();
  assert.equal(capabilities.protocolVersion, 1, 'capabilities protocol');
  assert.ok(capabilities.openApiUrl, 'capabilities advertises an OpenAPI URL');
  const documentUrl = new URL(capabilities.openApiUrl, `${url}/sendproof/`);
  const document = await context.request.get(documentUrl.href);
  assert.equal(document.status(), 200, `discovered OpenAPI document ${documentUrl.href}`);
  assert.ok((await document.json()).paths['/api/v2/payments'], 'discovered document contains payments');
  let releaseDiscovery;
  const pausedDiscovery = new Promise(resolve => { releaseDiscovery = resolve; });
  await page.route('**/sendproof/_api/capabilities', async route => {
    await pausedDiscovery;
    await route.continue();
  }, { times: 1 });
  const shellBounds = () => page.evaluate(() =>
    ['.topbar', '.sidebar', '.request', '.response', '.actionbar'].map(selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return [x, y, width, height];
    }));
  let loadingBounds;
  try {
    await page.goto(`${url}/sendproof/#op/PaymentsController.Create`);
    assert.equal(await page.getByRole('status').textContent(), 'Loading API…');
    assert.equal(await page.getByRole('button').count(), 0, 'loading placeholders are non-interactive');
    loadingBounds = await shellBounds();
  } finally {
    releaseDiscovery();
  }
  await page.locator('.sidebar .nav-heading').first().waitFor();
  assert.deepEqual(await shellBounds(), loadingBounds, 'discovery preserves the default workbench panel bounds');
  try { await runAccessibility(page); }
  catch (error) {
    layoutFailures.push(`accessibility: ${error.stack || error}`);
    await page.goto(`${url}/sendproof/#op/PaymentsController.Create`);
    await page.locator('.sidebar .nav-heading').first().waitFor();
  }
  await selectOperation(page, 'Sign in with a password');
  await page.locator('.actionbar [data-action="send"]').click();
  assert.equal(await page.locator('#issues .issue-link').count(), 2, 'blank credentials report both fields');
  await page.locator('#autofill').click();
  await page.getByRole('menuitem', { name: /^Fill every field/ }).click();
  const emailField = page.getByLabel(/^Email/i);
  assert.ok(await emailField.inputValue(), 'autofill supplies the email');
  assert.ok(await page.getByLabel(/^Password/i).inputValue(), 'autofill supplies the password');
  await emailField.fill('kk');
  await page.locator('.actionbar [data-action="send"]').click();
  assert.equal(await emailField.getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('[data-action="confirm-send"]').count(), 0);
  await page.locator('.topbar [data-action="signin"]').click();
  await page.locator('#email').waitFor();
  await page.locator('.persona-row').first().waitFor();
  await page.locator('#email').fill('ada.admin@acme.dev');
  await page.locator('#password').fill('Demo123!');
  const login = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST');
  await page.locator('#signin-form button[type="submit"]').click();
  assert.equal((await login).status(), 200, 'password sign-in');
  await page.locator('#signin-form').waitFor({ state: 'detached' });
  await page.locator('.sidebar .nav-heading').first().waitFor();
  const identity = await context.request.get(`${url}/auth/me`);
  assert.equal(identity.status(), 200, 'signed-in identity');
  assert.equal((await identity.json()).email, 'ada.admin@acme.dev');

  await selectOperation(page, 'Create payment');
  assert.match(await page.locator('h1.op-title').innerText(), /Create payment/i);
  const debit = page.getByRole('combobox', { name: /^Debit account/i });
  const counterparty = page.getByRole('combobox', { name: /^Counterparty/i });
  assert.equal(await debit.locator('.placeholder').count(), 1, 'lookup initially has no selection');
  await page.locator('#autofill').click();
  await compareShell(page, mock, '51-autofill', 'state=blank&overlay=autofill&rtab=response');
  assert.deepEqual(await page.locator('#result .steps [data-shortcut-hint="autofill-required"] .kbd').allTextContents(),
    shortcutParts('autofill-required'), 'the empty state displays the binding used by Autofill');
  assert.equal(await page.locator('.response .tabs [role="tab"]').count(), 5, 'all five result tabs exist before a run');
  await page.keyboard.press('Escape');
  await page.locator('.actionbar [data-action="send"]').click();
  for (const lookup of [debit, counterparty]) {
    assert.equal(await lookup.getAttribute('aria-invalid'), 'true');
    assert.equal(await lookup.evaluate(node => node.closest('.control').classList.contains('is-invalid')), true);
  }
  const addPurpose = page.getByRole('button', { name: /^Add purposeCode\b/i });
  const purposeCode = page.getByLabel(/^Purpose code/i);
  assert.equal(await purposeCode.count(), 0, 'unused optional fields have a chip');
  await addPurpose.press('Enter');
  assert.equal(await purposeCode.evaluate(node => node === document.activeElement), true);
  await purposeCode.fill('TEST');
  await page.getByRole('button', { name: /^Remove Purpose code$/i }).click();
  assert.equal(await purposeCode.count(), 0, 'removing the field clears its value');
  assert.equal(await addPurpose.evaluate(node => node === document.activeElement), true);
  await page.getByLabel(/^Amount/i).fill('g');
  await page.getByLabel(/^Value date/i).fill('31/02/2026');
  await pickOption(page, page.getByRole('combobox', { name: /^Currency$/i }), /^EUR\b/);
  await page.getByLabel(/^Reference/i).fill('Invoice reference longer than thirty-five characters');
  await page.locator('.actionbar [data-action="send"]').click();
  const issueRows = await page.locator('#issues .issue-link').evaluateAll(rows => rows.map(row => {
    const target = document.getElementById(row.dataset.issueTarget);
    const assistance = target?.getAttribute('aria-describedby')?.split(' ')
      .map(id => document.getElementById(id)?.querySelector('.field-error')?.textContent).filter(Boolean);
    return { name: row.querySelector('.name').textContent, issue: row.querySelector('.why').textContent,
      assistance, target: target?.id };
  }));
  assert.ok(issueRows.length >= 4, 'invalid values are collected in the action bar');
  const count = Number((await page.locator('#issues-title').textContent()).match(/^\d+/)?.[0]);
  assert.equal(issueRows.length, count, 'validation lists one issue per field');
  assert.equal(new Set(issueRows.map(row => row.target)).size, count, 'no field has duplicate issue rows');
  for (const row of issueRows) {
    assert.deepEqual(row.assistance, [row.issue], `assistance matches issue for ${row.name}`);
    assert.doesNotMatch(row.issue, /required pattern|\[1-9\]|\\d/, 'the UI keeps regex internals out of errors');
  }
  assert.match(issueRows.find(row => row.name === 'Amount')?.issue || '', /Enter a number, like 1,250\.00/);
  assert.equal(await page.locator('[data-request-tab="Body"] [data-tab-flag]:not([hidden])').count(), 1, 'the Body tab shows an issue dot');
  assert.match(issueRows.find(row => row.name === 'Value date')?.issue || '', /doesn’t exist/);
  await page.locator('.request .pane-scroll').evaluate(pane => { pane.scrollTop = 0; });
  await compareShell(page, mock, '22-validation', 'state=validation&overlay=issues&rtab=response');
  await page.keyboard.press('Escape');
  await page.getByLabel(/^Reference/i).fill('');
  await pickLookup(page, debit, /^Operating EUR/);
  assert.match(await debit.locator('.picked').innerText(), /Operating EUR/);
  assert.equal(await counterparty.locator('.placeholder').count(), 1, 'counterparty initially has no selection');
  await pickLookup(page, counterparty, /^Northwind Logistics GmbH/);
  assert.match(await counterparty.locator('.picked').innerText(), /Northwind Logistics/);
  const amount = page.getByLabel(/^Amount/i);
  assert.equal(await amount.getAttribute('inputmode'), 'decimal', 'amount requests a decimal keyboard');
  await amount.fill('g');
  await page.locator('.actionbar [data-action="send"]').click();
  assert.equal(await amount.inputValue(), 'g', 'invalid numeric draft stays editable');
  assert.equal(await amount.getAttribute('aria-invalid'), 'true', 'letters fail numeric validation');
  assert.equal(await page.locator('[data-action="confirm-send"]').count(), 0);
  await amount.fill('1.23');
  const date = page.getByLabel(/^Value date/i);
  assert.equal(await date.getAttribute('placeholder'), 'dd/mm/yyyy', 'date accepts an editable draft');
  await date.fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await pickOption(page, page.getByRole('combobox', { name: /^Currency$/i }), /^EUR\b/);
  // A short enum is a radio group: every value visible, the chosen one filled.
  const priority = page.getByRole('radiogroup', { name: /^Priority/i });
  await priority.getByRole('radio', { name: /^Normal$/i }).click();
  assert.equal(await page.getByRole('radiogroup', { name: /^Priority/i }).getByRole('radio', { name: /^Normal$/i }).getAttribute('aria-checked'), 'true');
  await page.locator('[data-request-tab="Headers"]').click();
  const idempotencyKey = await page.locator('[data-header-id="declared-header-Idempotency-Key"] [data-header-field="value"]').inputValue();
  assert.match(idempotencyKey, /^[0-9a-f-]{36}$/i, 'the required idempotency key is generated');
  await page.locator('[data-request-tab="Body"]').click();
  await page.locator('[data-body-mode="JSON"]').click();
  const editor = page.locator('#json');
  const body = JSON.parse(await editor.inputValue());
  assert.equal(body.debitAccountId, '3f9c0000-0000-4000-8000-00000000a21e');
  assert.equal(body.counterpartyId, '5b7c0000-0000-4000-8000-00000000b123');
  assert.equal(body.amount, 1.23);
  assert.equal(body.currency, 'EUR');
  assert.equal(body.priority, 'Normal');
  const reference = `browser-${Date.now()}`;
  body.reference = reference;
  body.remittanceLines = ['Browser integration purchase order'];
  await editor.fill(JSON.stringify(body));
  const readPayments = async () => {
    const response = await context.request.get(`${url}/api/v2/payments`);
    assert.equal(response.status(), 200, 'independent payment read');
    return response.json();
  };
  const readAccounts = async () => {
    const response = await context.request.get(`${url}/api/v2/accounts?pageSize=100`);
    assert.equal(response.status(), 200, 'independent account read');
    return response.json();
  };
  const before = await readPayments();
  const accountsBefore = await readAccounts();
  const previewPattern = '**/sendproof/_preview/api/v2/payments';
  // Abort only the preview transport to exercise the real network-error renderer.
  await page.route(previewPattern, route => route.abort('failed'));
  await page.locator('.actionbar [data-action="preview"]').click();
  await page.locator('.response .state[role="alert"]').waitFor();
  await page.unroute(previewPattern);
  let releasePreview;
  const previewGate = new Promise(resolve => { releasePreview = resolve; });
  await page.route(previewPattern, async route => { await previewGate; await route.continue(); });
  await page.locator('[data-body-mode="Form"]').click();
  const previewResponse = page.waitForResponse(response => response.url().includes('/sendproof/_preview/api/v2/payments') && response.request().method() === 'POST');
  await page.locator('.actionbar [data-action="preview"]').click();
  await page.locator('.response[aria-busy="true"] .sk').first().waitFor();
  const separator = page.getByRole('separator', { name: 'Resize operations sidebar' });
  const widthBefore = await separator.getAttribute('aria-valuenow');
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(Number(await separator.getAttribute('aria-valuenow')) > Number(widthBefore), 'keyboard resizes the sidebar');
  await page.keyboard.press('ArrowLeft');
  await separator.blur();
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 20);
  await page.mouse.down();
  await compareShell(page, mock, '54-in-flight-resizing', 'state=running&resizing=1', false, true);
  await page.mouse.up();
  await separator.dblclick({ position: { x: 4, y: 20 } });
  releasePreview();
  const preview = await previewResponse;
  await page.unroute(previewPattern);
  assert.equal(preview.status(), 200, 'preview transport');
  const previewBody = await preview.json();
  assert.equal(previewBody.rolledBack, true, 'preview confirms rollback');
  assert.equal(previewBody.status, 201, 'preview executes the real operation');
  assert.match(preview.headers()['server-timing'], /handler;dur=/, 'preview returns timing from the API');
  assert.ok(previewBody.changes?.length, 'preview reports database changes');
  await page.locator('.response .banner').waitFor();
  assert.deepEqual(await readPayments(), before, 'preview did not persist a payment');
  assert.deepEqual(await readAccounts(), accountsBefore, 'preview did not persist the account debit');

  await page.locator('[data-body-mode="Form"]').click();
  await compareShell(page, mock, '01-request-default', 'state=filled&run=preview&rtab=database');
  await verifyPreviewCapture(page, mock);

  await toggleTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await compareShell(page, mock, '02-request-default-dark', 'state=filled&run=preview&rtab=database&theme=dark');
  await toggleTheme(page);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await verifyKeyboard(page, mock);
  await verifyHeaders(page, mock);

  await page.locator('[data-body-mode="JSON"]').click();
  const invalidBody = { ...body, amount: 999999999, valueDate: '2000-01-01' };
  await editor.fill(JSON.stringify(invalidBody));
  await page.locator('.actionbar [data-action="send"]').click();
  await page.locator('.actionbar [data-action="confirm-send"]').waitFor();
  await editor.fill(JSON.stringify({ ...invalidBody, reference: `${reference}-edit` }));
  assert.equal(await page.locator('.actionbar [data-action="confirm-send"]').count(), 0, 'editing cancels confirmation');
  await editor.fill(JSON.stringify(invalidBody));
  await page.locator('.actionbar [data-action="send"]').click();
  const invalidResponse = page.waitForResponse(response => response.url().endsWith('/api/v2/payments') && response.request().method() === 'POST');
  await page.locator('.actionbar [data-action="confirm-send"]').click();
  const invalid = await invalidResponse;
  assert.equal(invalid.status(), 400, 'invalid request returns validation 400');
  assert.equal(invalid.request().headers()['idempotency-key'], idempotencyKey, 'invalid request carries the prepared key');
  await page.locator('.resp-head .status-code.warn').waitFor(); // 4xx takes the warning hue
  await page.locator('.actionbar .issues-btn').waitFor();
  assert.equal(await page.getByLabel(/^Amount/i).getAttribute('aria-invalid'), 'true', 'server validation marks the amount');
  assert.equal(await page.getByLabel(/^Value date/i).getAttribute('aria-invalid'), 'true', 'server validation marks the date');
  assert.deepEqual(await readPayments(), before, 'invalid request does not write');
  assert.deepEqual(await readAccounts(), accountsBefore, 'invalid request does not debit account');

  await page.locator('[data-body-mode="JSON"]').click();
  await editor.fill(JSON.stringify(body));
  await page.locator('.actionbar [data-action="send"]').click();
  const sendResponse = page.waitForResponse(response => response.url().endsWith('/api/v2/payments') && response.request().method() === 'POST');
  const traceResponse = page.waitForResponse(response => response.url().includes('/sendproof/_api/traces/'));
  await page.locator('.actionbar [data-action="confirm-send"]').click();
  const sent = await sendResponse;
  assert.equal(sent.status(), 201, 'explicit Send commits');
  assert.equal(sent.request().headers()['idempotency-key'], idempotencyKey, 'valid edit reuses the unconsumed key');
  assert.match(sent.request().headers()['x-request-id'], /^[0-9a-f-]{36}$/i, 'dynamic header resolves at send time');
  assert.equal(sent.request().headers()['x-tenant'], undefined, 'unchecked headers stay out of the request');
  assert.match(sent.request().headers().prefer, /\btrace\b/, 'observed Send asks for a trace on the real operation');
  const trace = await traceResponse;
  assert.equal(trace.status(), 200, 'the signed-in actor can read the observation');
  const capture = await trace.json();
  assert.ok(capture.effects?.length && capture.effects.every(effect => effect.delivered === true),
    'the trace acknowledges delivered effects');
  await page.locator('.resp-head .status-code').filter({ hasText: '201' }).waitFor();
  // The database is seeded with payments, so compare with the count before and find the new payment by its reference.
  const after = await readPayments();
  assert.ok(before.totalItems >= 150, 'the demo database is seeded with payments');
  assert.equal(after.totalItems, before.totalItems + 1, 'Send persists exactly one payment');
  const found = await (await context.request.get(`${url}/api/v2/payments?reference=${encodeURIComponent(reference)}`)).json();
  assert.equal(found.totalItems, 1, 'sent payment is independently readable');
  assert.equal(found.items[0].reference, reference);
  const accountsAfter = await readAccounts();
  const accountId = body.debitAccountId;
  const balance = accounts => accounts.items.find(account => account.id === accountId)?.availableBalance;
  assert.ok(Math.abs(balance(accountsBefore) - balance(accountsAfter) - body.amount) < 0.00001, 'Send persists the account debit');
  await verifyObservedCapture(page, mock);

  await page.getByRole('tablist', { name: 'Result' }).getByRole('tab', { name: 'Response', exact: true }).click();
  await page.locator('#result [data-follow-up]').filter({ hasText: /Get payment/i }).first().click();
  assert.match(await page.locator('h1.op-title').innerText(), /Get payment/i, 'follow-up loads the documented operation');
  const sentBody = await sent.json();
  assert.ok(sentBody.id, 'the response supplies a record ID');
  await page.locator('[data-path-param]').click();
  const pathId = page.locator('[data-parameter-name] [role="combobox"]').first();
  assert.equal(await pathId.getAttribute('aria-expanded'), 'true', 'path token opens the ID lookup');
  const search = page.locator('.lb .lb-search input');
  assert.ok(await search.getAttribute('aria-activedescendant'), 'lookup announces its active option');
  const lastResponse = page.locator('.lb .lb-group', { hasText: 'From your last request' });
  assert.equal(await lastResponse.isVisible(), true, 'the most recent response is offered first');
  assert.match(await page.locator('.lb .lb-src').innerText(), /GET \/api\/v2\/payments/, 'the lookup’s source is in its footer');
  await compareShell(page, mock, '52-id-lookup', 'op=get&tab=params&overlay=lookup&rtab=response');
  await search.press('Enter');
  assert.equal(await pathId.locator('.picked .placeholder').count(), 0, 'picking the response retains its ID');

  await page.locator('[data-action="palette"]').click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  // Use a real matching operation; the static design uses a different API fixture.
  await palette.getByLabel('Search operations and commands').fill('payment');
  await palette.getByRole('option').first().waitFor();
  await palette.getByLabel('Search operations and commands').fill('List payments');
  await palette.getByRole('option').filter({ hasText: 'List payments' }).click();
  assert.match(await page.locator('h1.op-title').innerText(), /List payments/i);
  await verifyReference(page, mock, url);
  await verifyCodeSamples(page, url);
  await verifyV5Controls(page, url);
  await verifyNoClipping(page, url);
  await verifyPersonaRefusal(browser, url);
  await verifyLocaleLayouts(browser, url);
  await page.setViewportSize({ width: 390, height: 844 });
  await mock.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action="navigation"]').click();
  await selectOperation(page, 'Create payment');
  // Selecting an operation clears its previous result; restore known valid data.
  await page.locator('[data-body-mode="JSON"]').click();
  await page.locator('#json').fill(JSON.stringify(body));
  await page.locator('[data-body-mode="Form"]').click();
  for (const lookup of [debit, counterparty]) {
    await lookup.click();
    await lookup.press('Escape');
    await lookup.press('Backspace');
  }
  await page.getByLabel(/^Amount/i).fill('g');
  await page.locator('.actionbar [data-action="send"]').click();
  await compareShell(page, mock, 'm01-request', 'state=filled', true);
  await pickLookup(page, debit, /^Operating EUR/);
  await pickLookup(page, counterparty, /^Northwind Logistics GmbH/);
  await page.getByLabel(/^Amount/i).fill(String(body.amount));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page has no horizontal overflow');
  await page.locator('.mobile-switch [data-view="response"]').click();
  assert.equal(await page.locator('.workspace').getAttribute('data-view'), 'result');
  assert.equal(await page.locator('.response').isVisible(), true, 'mobile result is visible');
  await page.locator('.mobile-switch [data-view="request"]').click();
  assert.equal(await page.locator('.request').isVisible(), true, 'mobile request is visible');
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile large text has no horizontal overflow');
  assert.equal(await page.locator('.actionbar [data-action="preview"]').isVisible(), true, 'preview remains available with large text');
  await page.locator('.actionbar [data-action="preview"]').click();
  await page.locator('.response .banner').waitFor();
  if (await page.locator('.workspace').getAttribute('data-view') !== 'result') {
    await page.locator('.mobile-switch [data-view="response"]').click();
  }
  const mobileSignIn = await context.newPage();
  watchPage(mobileSignIn);
  await mobileSignIn.setViewportSize({ width: 390, height: 844 });
  await mobileSignIn.goto(`${url}/sendproof/signin.html`);
  await mobileSignIn.locator('#signin-form').waitFor();
  await mobileSignIn.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert.equal(await mobileSignIn.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'mobile sign-in fits the viewport');
  await mobileSignIn.close();

  // Chromium emits this browser-generated message for the intentional 4xx response.
  const expectedNetworkError = `console: Failed to load resource: the server responded with a status of ${invalid.status()}`;
  const unexpected = [...errors];
  // The intentionally aborted preview is expected to produce one network error.
  const abortedIndex = unexpected.findIndex(error => error.includes('net::ERR_FAILED'));
  if (abortedIndex >= 0) unexpected.splice(abortedIndex, 1);
  const expectedIndex = unexpected.findIndex(error => error.startsWith(expectedNetworkError));
  if (expectedIndex >= 0) unexpected.splice(expectedIndex, 1);
  assert.deepEqual(unexpected, [], `no JavaScript or unexpected console errors (failed responses: ${responses.join(', ')})`);
  await writeFile(join(artifacts, 'comparison.txt'), layoutFailures.length ? `${layoutFailures.join('\n')}\n` : 'All geometry, style and accessibility checks passed.\n');
  assert.deepEqual(layoutFailures, [], layoutFailures.join('\n'));
  // Short earlier crumbs leave no gap before their chevron in every engine Playwright has installed.
  const engines = await checkCrumbsInEngines(url);
  console.log(`Crumb gap checked in ${engines.ran.join(', ')}${engines.skipped.length ? ` (not installed, skipped: ${engines.skipped.join(', ')})` : ''}`);
  await mock.close();
  await context.close();
  console.log('PASS: authentication, typed request, rollback, Send, 4xx, palette, theme, desktop and mobile mock layout');
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), `${error.stack || error}\n`);
  if (layoutFailures.length) await writeFile(join(artifacts, 'comparison.txt'), `${layoutFailures.join('\n')}\n`);
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure-actual.png'), animations: 'disabled' }).catch(() => {});
  if (mock && !mock.isClosed()) await mock.screenshot({ path: join(artifacts, 'failure-reference.png'), animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stopHost();
}

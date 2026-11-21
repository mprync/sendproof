import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { serveUiFromDirectory, startHost, stopHost } from './browser-host.mjs';

// Axe complements keyboard and visual review; it cannot establish WCAG conformance alone.
export async function audit(page, state) {
  // Axe reads computed colours, so let colour transitions (a theme switch, a hover) finish first.
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))));
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  assert.deepEqual(violations.map(({ id, impact, nodes }) => ({
    id, impact, targets: nodes.map(node => node.target),
  })), [], `${state}: axe violations`);
}

/** Check the initial workbench and restore its viewport and editor after the audit. */
export async function runAccessibility(page) {
  await audit(page, 'workbench');
  const search = page.getByRole('button', { name: /^Search or run a command/ });
  await search.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  assert.equal(await dialog.isVisible(), true, 'command palette opens by keyboard');
  const input = dialog.getByRole('combobox');
  assert.equal(await input.evaluate(node => document.activeElement === node), true, 'palette receives focus');
  await page.keyboard.press('ArrowDown');
  assert.ok(await input.getAttribute('aria-activedescendant'), 'active result is announced');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'focus stays in the dialog');
  await audit(page, 'command palette');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape closes palette');
  assert.equal(await search.evaluate(node => document.activeElement === node), true, 'palette restores focus');

  const bodyTab = page.getByRole('tab', { name: 'Body', exact: true });
  await bodyTab.focus();
  await page.keyboard.press('ArrowRight');
  const headersTab = page.getByRole('tablist', { name: 'Request', exact: true }).getByRole('tab', { name: /^Headers/ });
  assert.equal(await headersTab.getAttribute('aria-selected'), 'true', 'arrow activates next request tab');
  assert.equal(await headersTab.evaluate(node => document.activeElement === node), true, 'focus follows selected tab');
  assert.equal(await page.locator('#editor').getAttribute('aria-labelledby'), 'request-tab-Headers');
  await audit(page, 'headers grid');
  await page.keyboard.press('Home');
  assert.equal(await bodyTab.getAttribute('aria-selected'), 'true', 'Home returns to first request tab');

  // A present optional object may contain required children. Its errors must be reachable.
  const validation = await page.evaluate(async () => {
    const { createSchemaForm } = await import('./schema.js');
    const host = document.createElement('div');
    document.querySelector('main').append(host);
    const form = createSchemaForm({ container: host, flattenRoot: true,
      schema: { type: 'object', properties: { optional: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
      value: { optional: {} } });
    const before = host.querySelector('.prop-chip') === null;
    const invalid = form.validate();
    const input = host.querySelector('input');
    const during = { invalid: input.getAttribute('aria-invalid'), described: !!document.getElementById(input.getAttribute('aria-describedby')) };
    form.setValue({ optional: { name: 'ok' } });
    const valid = form.validate();
    const cleared = host.querySelector('input').hasAttribute('aria-invalid');
    form.destroy();
    host.remove();
    return { before, errors: invalid.errors.length, during, valid: valid.valid, cleared };
  });
  assert.deepEqual(validation, { before: true, errors: 1,
    during: { invalid: 'true', described: true }, valid: true, cleared: false },
  'present optional values show their descendants and validation errors');

  // Every view and the main overlays, in both themes and in a right-to-left language.
  const views = [['API overview', '#overview'], ['Docs', '#docs/PaymentsController.Create'], ['model page', '#model/CreatePaymentRequest'],
    ['model opened from Docs', '#model/Payment?from=docs/PaymentsController.Create'], ['union model', '#model/BankDetails'], ['enum model', '#model/PaymentStatus']];
  for (const [name, hash] of views) {
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.locator('#doc-pane:not([hidden]) h1').waitFor();
    await audit(page, name);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await audit(page, `${name}, dark`);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  }
  await page.locator('#side-tab-operations').click();
  // The attribute list: child lists start open; each toggle is a button that says what it does,
  // and what the user closes stays closed after a reload (local storage, per API and list).
  await page.evaluate(() => { location.hash = '#docs/CounterpartiesController.Create'; });
  await page.locator('#doc-pane:not([hidden]) h1').waitFor();
  const list = page.locator('#doc-pane [data-body-card] .stree');
  const toggle = list.locator('.attr-toggle[aria-expanded="true"]').first();
  const path = await toggle.getAttribute('data-attr-toggle');
  assert.ok(path, 'a child list starts open');
  assert.match(await toggle.innerText(), /Hide child attributes/);
  await toggle.focus();
  await page.keyboard.press('Enter');
  const closed = list.locator(`[data-attr-toggle="${path}"]`);
  assert.equal(await closed.getAttribute('aria-expanded'), 'false', 'Enter closes the child list');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.attrToggle), path, 'focus stays on its toggle');
  await page.reload();
  await page.locator('#doc-pane:not([hidden]) h1').waitFor();
  assert.equal(await page.locator(`#doc-pane [data-body-card] [data-attr-toggle="${path}"]`).getAttribute('aria-expanded'), 'false', 'the closed list is remembered');
  await page.locator(`#doc-pane [data-body-card] [data-attr-toggle="${path}"]`).click();
  await audit(page, 'docs property tree');
  await page.evaluate(() => { location.hash = '#op/PaymentsController.Create'; });
  await page.locator('#request:not([hidden]) .op-title').waitFor();
  await page.locator('#display-btn').click();
  const display = page.getByRole('dialog', { name: 'Display settings' });
  await display.waitFor();
  await audit(page, 'display settings');
  await page.keyboard.press('Escape');
  assert.equal(await display.count(), 0, 'Escape closes Display settings');
  // Code samples: the Code tab and the open language list, in both themes.
  await page.locator('[data-request-tab="Code"]').click();
  await page.locator('#editor-code-picker').waitFor();
  await audit(page, 'Code tab');
  await page.locator('#editor-code-picker').click();
  const languages = page.getByRole('listbox', { name: 'Language' });
  await languages.waitFor();
  await audit(page, 'language list');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await audit(page, 'language list, dark');
  await page.keyboard.press('Escape');
  await audit(page, 'Code tab, dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('[data-request-tab="Body"]').click();
  const info = page.getByRole('button', { name: 'About Amount' });
  await info.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.locator('.toggletip').waitFor();
  await audit(page, 'field toggletip');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.toggletip').count(), 0, 'Escape closes the toggletip');
  for (const language of ['ar', 'de-DE']) {
    await page.evaluate(id => localStorage.setItem('testbench-settings', JSON.stringify({ language: id })), language);
    await page.reload();
    await page.locator('#request .op-title').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), language);
    assert.equal(await page.locator('html').getAttribute('dir'), language === 'ar' ? 'rtl' : 'ltr');
    await audit(page, `workbench in ${language}`);
    for (const [name, hash] of [['Docs', '#docs/CounterpartiesController.Create'], ['model page', '#model/Payment?from=docs/PaymentsController.Create']]) {
      await page.evaluate(value => { location.hash = value; }, hash);
      await page.locator('#doc-pane:not([hidden]) h1').waitFor();
      await audit(page, `${name} in ${language}`);
      if (name === 'Docs') {
        // The language list mirrors in right-to-left: rows and trigger stay inside the viewport.
        await page.locator('#docs-code-picker').click();
        const list = page.getByRole('listbox');
        await list.waitFor();
        const box = await list.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width, `the language list fits the viewport in ${language}`);
        const gaps = await list.getByRole('option').evaluateAll(rows => rows.map(row => {
          const [main, end] = [row.querySelector('.main'), row.querySelector('.end')].map(node => node.getBoundingClientRect());
          return Math.round(Math.max(end.left - main.right, main.left - end.right));
        }));
        assert.ok(gaps.every(gap => gap >= 16), `every language keeps a gap before its library in ${language} (${gaps})`);
        await audit(page, `language list in ${language}`);
        await page.keyboard.press('Escape');
      }
    }
    await page.evaluate(() => { location.hash = '#op/PaymentsController.Create'; });
    await page.locator('#request:not([hidden]) .op-title').waitFor();
  }
  await page.evaluate(() => localStorage.removeItem('testbench-settings'));
  await page.reload();
  await page.locator('#request .op-title').waitFor();

  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 700 });
  const fontSize = await page.evaluate(() => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '130%';
    return previous;
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile viewport has no document overflow');
  await search.click();
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'palette content reflows at large text size');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await page.evaluate(() => {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    document.body.append(spinner);
    const animation = getComputedStyle(spinner).animationName;
    spinner.remove();
    return animation;
  }), 'none', 'spinner respects reduced motion');
  await audit(page, 'mobile workbench');
  // Docs and Models on a phone at 130% text: stacked columns, 44 px targets, no overflow.
  for (const [name, hash] of [['Docs', '#docs/CounterpartiesController.Create'], ['model page', '#model/Payment?from=docs/PaymentsController.Create']]) {
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.locator('#doc-pane:not([hidden]) h1').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `mobile ${name} has no document overflow`);
    await audit(page, `mobile ${name}`);
  }
  await page.locator('[data-action="navigation"]').click();
  await audit(page, 'mobile sidebar drawer');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#op/PaymentsController.Create'; });
  await page.locator('#request:not([hidden]) .op-title').waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await audit(page, 'mobile dark workbench');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(value => { document.documentElement.style.fontSize = value; }, fontSize);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (viewport) await page.setViewportSize(viewport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let browser;
  try {
    const url = await startHost();
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IE' });
    await serveUiFromDirectory(context);
    const page = await context.newPage();
    await page.goto(`${url}/bench/#op/PaymentsController.Create`);
    await page.locator('.sidebar .nav-heading').first().waitFor();
    await runAccessibility(page);
    console.log('PASS: axe in every view, both themes, Arabic and German; keyboard navigation, focus and large text');
  } finally {
    await browser?.close();
    await stopHost();
  }
}

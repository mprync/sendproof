// The head row's short earlier crumbs sit tight against their chevron in every browser engine.
//
// An earlier crumb reserves min(5rem, its natural width) (ui/crumb-fit.js sets --nat, ui/app.css
// uses it), so "FX deals" leaves no gap before "› Quote FX rate". The mechanism is plain CSS plus
// a measurement, so it must hold in WebKit and Firefox as well as Chromium. This opens the Quote FX
// rate Docs page in each engine Playwright has installed, at a roomy and at a tight width and at
// 130% text, and reports the engines that ran and those that were skipped as not installed.
// Run from browser-test.mjs, or alone: node tools/crumb-engines.mjs (starts the Acme Store example).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
import { serveUiFromDirectory, startHost, stopHost } from './browser-host.mjs';

const ENGINES = { chromium, firefox, webkit };

/** Runs in the page: how many px each earlier crumb's box is wider than its link, and its --nat. */
const crumbGaps = () => [...document.querySelectorAll('.ctx-bar .crumbs li:not(:last-child)')].map(item => {
  const link = item.querySelector('a');
  return {
    text: link.textContent.trim(), nat: item.style.getPropertyValue('--nat'),
    gap: item.getBoundingClientRect().width - link.getBoundingClientRect().width,
    stub: link.clientWidth, full: link.scrollWidth,
  };
});

/**
 * @param {string} url the running example's origin
 * @returns {Promise<{ ran: string[], skipped: string[] }>}
 */
export async function checkCrumbsInEngines(url) {
  const ran = [], skipped = [];
  for (const [name, type] of Object.entries(ENGINES)) {
    if (!existsSync(type.executablePath())) { skipped.push(name); continue; }
    const browser = await type.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-IE' });
      await serveUiFromDirectory(context);
      const page = await context.newPage();
      await page.goto(`${url}/sendproof/#docs/CartsController.Quote`);
      await page.waitForSelector('.ctx-bar .crumbs li:not(:last-child) a');
      // Measured after the row renders: --nat appears on the earlier crumb.
      await page.waitForFunction(() => document.querySelector('.ctx-bar .crumbs li:not(:last-child)')?.style.getPropertyValue('--nat'));
      for (const [label, width, size] of [['1440px', 1440, ''], ['900px', 900, ''], ['1440px at 130% text', 1440, '130%']]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
        // Re-measured after the change (resize, root font size): wait for the probe's observer to settle.
        await page.waitForTimeout(250);
        const crumbs = await page.evaluate(crumbGaps);
        assert.ok(crumbs.length > 0, `${name}: ${label}: the earlier crumb is shown`);
        for (const crumb of crumbs) {
          assert.ok(crumb.nat.endsWith('px'), `${name}: ${label}: “${crumb.text}” has a measured --nat (${crumb.nat})`);
          assert.ok(crumb.gap <= 1.5, `${name}: ${label}: “${crumb.text}” leaves a ${crumb.gap.toFixed(1)}px gap before the chevron`);
          assert.ok(crumb.stub >= Math.min(crumb.full, 3 * 16) - 0.5, `${name}: ${label}: “${crumb.text}” keeps a readable stub (${crumb.stub}px of ${crumb.full}px)`);
        }
      }
      ran.push(name);
    } finally {
      await browser.close();
    }
  }
  return { ran, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.SENDPROOF_UI_DIR ??= 'ui';
  try {
    const { ran, skipped } = await checkCrumbsInEngines(await startHost());
    console.log(`PASS: short crumbs sit tight against their chevron in ${ran.join(', ')}${skipped.length ? ` (not installed, skipped: ${skipped.join(', ')})` : ''}`);
  } finally {
    await stopHost();
  }
}

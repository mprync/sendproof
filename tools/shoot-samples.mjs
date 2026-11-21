// Screenshots of the request-sample picker and code samples from the running Treasury demo.
//
//   node tools/shoot-samples.mjs              writes artifacts/v5-live/
//
// Env: BASE=<url> (default http://127.0.0.1:5189), OUT=<dir>. Desktop is 1440×900 in both themes,
// plus one 390 px phone. Signed in as the seeded Ada Admin account.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.BASE || 'http://127.0.0.1:5189').replace(/\/$/, '').replace(/\/sendproof$/, '');
const out = process.env.OUT || join(root, 'artifacts', 'v5-live');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

/** A fresh context in one theme and size, signed in, with the language picker reset. */
async function open({ theme, mobile = false }) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('sendproof-settings', JSON.stringify({ theme, language: 'en-IE', density: 'default', tracedSend: true }));
    localStorage.removeItem('sendproof-code-language');
  }, { theme });
  await context.request.post(`${base}/auth/login`, { data: { email: 'ada.admin@acme.dev', password: 'Demo123!' } });
  const page = await context.newPage();
  return { context, page };
}
const choose = async (page, trigger, language) => {
  await page.locator(trigger).click();
  await page.getByRole('option', { name: new RegExp(`^${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }).click();
  await page.waitForTimeout(150);
};

for (const theme of ['light', 'dark']) {
  const { context, page } = await open({ theme });
  const shot = name => page.screenshot({ path: join(out, `${name}-${theme}.png`) });
  await page.goto(`${base}/sendproof/#docs/PaymentsController.Create`);
  await page.locator('#docs-code-picker').waitFor();
  await page.waitForTimeout(400);
  await page.locator('#docs-code-picker').click();
  await page.getByRole('listbox').waitFor();
  await page.waitForTimeout(200);
  await shot('01-picker-open');
  await page.keyboard.press('Escape');
  for (const [file, language] of [['02-sample-curl', 'cURL'], ['03-sample-fetch', 'JavaScript'], ['04-sample-python', 'Python'], ['05-sample-go', 'Go'], ['06-sample-rust', 'Rust']]) {
    await choose(page, '#docs-code-picker', language);
    await shot(file);
  }
  // A selection across JSON lines in the response example; the copy puts code only on the clipboard.
  const lines = page.locator('.sample-card [role="tabpanel"]:not([hidden]) .code-view .ln .src');
  await lines.nth(1).scrollIntoViewIfNeeded();
  const [a, b] = [await lines.nth(1).boundingBox(), await lines.nth(5).boundingBox()];
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.min(b.width - 4, 150), b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await shot('07-json-selection');
  // Try it: the Code panel shares the choice.
  await page.goto(`${base}/sendproof/#op/PaymentsController.Create`);
  await page.locator('[data-request-tab="Code"]').click();
  await page.locator('#editor-code-picker').waitFor();
  await page.waitForTimeout(300);
  await shot('08-try-it-code');
  await context.close();
}

// The language list in German and Arabic (right to left): the name and library keep their gap.
for (const language of ['de-DE', 'ar']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.addInitScript(({ language }) => {
    localStorage.setItem('sendproof-settings', JSON.stringify({ theme: 'light', language, density: 'default', tracedSend: true }));
    localStorage.removeItem('sendproof-code-language');
  }, { language });
  await context.request.post(`${base}/auth/login`, { data: { email: 'ada.admin@acme.dev', password: 'Demo123!' } });
  const page = await context.newPage();
  await page.goto(`${base}/sendproof/#docs/PaymentsController.Create`);
  await page.locator('#docs-code-picker').waitFor();
  await page.waitForTimeout(400);
  await page.locator('#docs-code-picker').click();
  await page.getByRole('listbox').waitFor();
  await page.screenshot({ path: join(out, `11-picker-open-${language.slice(0, 2)}.png`) });
  await context.close();
}

// One phone width.
const phone = await open({ theme: 'light', mobile: true });
await phone.page.goto(`${base}/sendproof/#docs/PaymentsController.Create`);
await phone.page.locator('#docs-code-picker').waitFor({ state: 'attached' });
await phone.page.locator('#docs-code-picker').scrollIntoViewIfNeeded();
await phone.page.waitForTimeout(500);
await phone.page.screenshot({ path: join(out, '09-phone-390-docs-sample.png') });
await phone.page.locator('#docs-code-picker').click();
await phone.page.getByRole('listbox').waitFor();
await phone.page.screenshot({ path: join(out, '10-phone-390-picker-open.png') });
await phone.context.close();
await browser.close();
console.log(`Screenshots in ${out}`);

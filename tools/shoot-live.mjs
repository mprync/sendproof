// Captures the live workbench at the states of the mock screens and writes side-by-side
// composites (mock | live) so differences in layout, spacing, components, copy and states are
// easy to see. SET=v4 (default) shoots the v4 screens (57–70, 74, 75, m13–m17); SET=v5 shoots
// the v5 screens (76, 78, 81, 88, 91, 93, 97, 100, 102, 104, 107, m19, m20) and a Docs page and a
// model page in both themes, which show the v5 colour. Boards 71–73 are design boards: the live
// equivalent is the geometry assertion in tools/browser-test.mjs.
//
//   node tools/shoot-live.mjs                 every v4 state
//   SET=v5 node tools/shoot-live.mjs          every v5 state, into artifacts/v5-impl
//   node tools/shoot-live.mjs 58 docs m1      only names containing "58", "docs" or "m1"
//
// Env: BASE=<url>      the running Treasury example (default http://127.0.0.1:5189)
//      OUT=<dir>       screenshots (default artifacts/v4-live or artifacts/v5-impl); composites go to <OUT>/compare
//      DSF=1           render at 1× for quick looks (default 2)
// Desktop is 1440×900, mobile 390×844. Signed-in states use the seeded Ada Admin account
// (ada.admin@acme.dev / Demo123!); `out` states start with no session. The demo's data is
// real, so values differ from the mocks' snapshot; layout, components and copy should match.
import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.BASE || 'http://127.0.0.1:5189').replace(/\/$/, '').replace(/\/bench$/, '');
const set = process.env.SET || 'v4';
const out = process.env.OUT ? process.env.OUT : join(root, 'artifacts', set === 'v5' ? 'v5-impl' : 'v4-live');
const dsf = Number(process.env.DSF || 2);
const mockDir = join(root, 'mocks', 'screens');
mkdirSync(join(out, 'compare'), { recursive: true });

// Operation ids by summary, so the script doesn't depend on a fixed spec.
const spec = await (await fetch(`${base}/openapi/v1.json`)).json();
const ids = {};
for (const [path, item] of Object.entries(spec.paths)) for (const [verb, op] of Object.entries(item)) if (op?.operationId) ids[op.summary] = { id: op.operationId, verb, path };
const op = summary => ids[summary]?.id ?? (() => { throw new Error(`No operation "${summary}"`); })();
const CREATE = 'PaymentsController.Create';

const click = async (page, selector) => { await page.locator(selector).first().click(); await page.waitForTimeout(250); };
const run = async (page, action) => { await click(page, `.actionbar [data-action="${action}"]`); await page.waitForSelector('.response:not([aria-busy="true"]) .resp-head .status-code', { timeout: 15000 }); await page.waitForTimeout(300); };
const scrollTo = (page, selector) => page.evaluate(sel => { const node = document.querySelector(sel); const pane = node?.closest('.pane-scroll'); if (pane) pane.scrollTop = node.offsetTop - 12; }, selector);

// name, mock file, options. `setup(page)` performs the state's interactions after load.
const shots = [
  // Signed out, so the result is a public read: expanded JSON next to the sidebar's signed-out notice.
  { name: '57-shell-try-it', out: true, hash: `#op/${op('List development personas')}`, setup: async page => { await run(page, 'send'); } },
  { name: '58-shell-docs', out: true, hash: `#docs/${CREATE}` },
  { name: '59-shell-model', out: true, hash: `#model/Payment?from=op/${CREATE}` },
  { name: '60-docs-inline-expand', out: true, hash: `#docs/${CREATE}`, setup: async page => { await click(page, '[data-response-toggle="201"][aria-expanded="false"]'); await scrollTo(page, '#doc-responses'); } },
  { name: '61-model-nested-ref', out: true, hash: `#model/Approval?from=op/${CREATE}&via=Payment` },
  { name: '62-models-tab', hash: '#model/Payment', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: '63-model-json-schema-dark', theme: 'dark', hash: '#model/Payment', setup: async page => { await click(page, '#side-tab-models'); await click(page, '[data-aside="schema"]'); } },
  { name: '64-model-expand-all', hash: '#model/Payment', setup: async page => { await click(page, '#side-tab-models'); await click(page, '[data-tree-all]'); } },
  { name: '65-model-no-description', hash: '#model/Account', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: '66-model-enum', hash: '#model/PaymentStatus', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: '67-signed-out-docs-dark', out: true, theme: 'dark', hash: `#docs/${CREATE}` },
  { name: '68-json-expanded', hash: `#op/${op('Get the current user')}`, setup: async page => { await run(page, 'send'); } },
  { name: '69-json-large', hash: `#op/PaymentsController.List`, setup: async page => { await click(page, '[data-request-tab="Params"]'); await page.locator('[data-parameter-name="pageSize"] input').fill('100'); await run(page, 'send'); } },
  { name: '70-sidebar-groups-remembered', nav: ['Authentication', 'Accounts', 'Balances'], hash: `#op/${CREATE}` },
  { name: '74-docs-oneof-inline', hash: '#docs/CounterpartiesController.Create', setup: async page => { await scrollTo(page, '#doc-body'); } },
  { name: '75-docs-list-parameters', theme: 'dark', hash: '#docs/PaymentsController.List' },
  { name: 'm13-docs-signed-out', mobile: true, out: true, hash: `#docs/${CREATE}` },
  { name: 'm14-model-from-docs', mobile: true, hash: `#model/Payment?from=docs/${CREATE}` },
  { name: 'm15-drawer-signed-out', mobile: true, out: true, hash: `#op/${CREATE}`, setup: async page => { await click(page, '[data-action="navigation"]'); } },
  { name: 'm16-json-expanded-dark', mobile: true, theme: 'dark', hash: `#op/${op('Get the current user')}`, setup: async page => { await run(page, 'send'); await click(page, '.mobile-switch [data-view="response"]'); } },
  { name: 'm17-model-130', mobile: true, text: 130, hash: '#model/BankDetails?from=docs/CounterpartiesController.Create&via=Counterparty' },
];

// v5: the field anatomy, selects, lookup, deprecation, attribute list, response viewer and
// language picker. Fields are set the way the mocks show them (status Open, currency EUR).
const params = async page => { await click(page, '[data-request-tab="Params"]'); };
const filled = async page => {
  await params(page);
  await click(page, '[role="radiogroup"] [role="radio"][data-value="Open"]');
  await click(page, '[data-parameter-name="currency"] [role="combobox"]');
  await click(page, '.lb [role="option"]:has-text("EUR")');
};
const pickAccount = async page => { await params(page); await click(page, '[data-parameter-name="id"] [role="combobox"]'); await click(page, '.lb [role="option"] >> nth=1'); };
const v5 = [
  { name: '76-v5-fields', hash: '#op/AccountsController.List', setup: filled },
  { name: '78-v5-select-open', hash: '#op/AccountsController.List', setup: async page => { await filled(page); await scrollTo(page, '[data-parameter-name="status"] .field'); await click(page, '[data-parameter-name="type"] [role="combobox"]'); await page.keyboard.press('c'); } },
  { name: '81-v5-lookup-open', hash: '#op/AccountsController.Get', setup: async page => { await params(page); await click(page, '[data-parameter-name="id"] [role="combobox"]'); await page.keyboard.press('ArrowDown'); } },
  { name: '88-v5-deprecated-try-it', hash: '#op/BalancesController.LegacyBalance', setup: async page => { await params(page); await click(page, '[data-parameter-name="id"] [role="combobox"]'); await click(page, '.lb [role="option"] >> nth=0'); } },
  { name: '91-v5-model-account', hash: '#model/Account', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: '93-v5-model-oneof-deep', hash: '#model/Counterparty', setup: async page => { await click(page, '#side-tab-models'); await click(page, '[data-attr-toggle="address"][aria-expanded="true"]'); await scrollTo(page, '[data-path="address"]'); } },
  { name: '97-v5-docs-params', hash: '#docs/AccountsController.List' },
  { name: '100-v5-response-match', hash: '#op/AccountsController.Get', setup: async page => { await pickAccount(page); await run(page, 'send'); await click(page, '.resp-head .match'); } },
  { name: '102-v5-response-schema', hash: '#op/AccountsController.Get', setup: async page => { await pickAccount(page); await run(page, 'send'); await click(page, '[data-response-mode="schema"]'); } },
  { name: '104-v5-response-table', hash: '#op/AccountsController.List', setup: async page => { await run(page, 'send'); await click(page, '[data-response-mode="table"]'); } },
  { name: '107-v5-language-picker', hash: '#op/AccountsController.List', setup: async page => { await click(page, '#display-btn'); await click(page, '#display-language'); } },
  { name: 'm19-v5-select-130', mobile: true, text: 130, hash: '#op/AccountsController.List', setup: async page => { await filled(page); await click(page, '[data-parameter-name="type"] [role="combobox"]'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); } },
  { name: 'm20-v5-rtl-he', mobile: true, lang: 'he-IL', hash: '#op/AccountsController.List', setup: async page => { await params(page); await click(page, '[data-parameter-name="currency"] [role="combobox"]'); } },
  { name: 'v5-docs-colour', hash: `#docs/${CREATE}` },
  { name: 'v5-docs-colour-dark', theme: 'dark', hash: `#docs/${CREATE}` },
  { name: 'v5-docs-responses', hash: '#docs/AccountsController.Get', setup: async page => { await scrollTo(page, '#doc-responses'); } },
  { name: 'v5-model-colour', hash: '#model/Payment', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: 'v5-model-colour-dark', theme: 'dark', hash: '#model/Payment', setup: async page => { await click(page, '#side-tab-models'); } },
  { name: 'v5-i18n-de', lang: 'de-DE', hash: '#op/PaymentsController.Create' },
  { name: 'v5-i18n-fi', lang: 'fi-FI', hash: '#docs/AccountsController.List' },
  { name: 'v5-i18n-ja', lang: 'ja-JP', hash: '#op/AccountsController.List', setup: async page => { await run(page, 'send'); await click(page, '[data-response-mode="table"]'); } },
  { name: 'v5-i18n-zh-Hant', lang: 'zh-Hant', hash: '#model/Account', setup: async page => { await click(page, '#side-tab-models'); } },
];
// The mock PNGs are named with their slug ("76-v5-fields"); composites pair them by name.
const list = set === 'v5' ? v5 : shots;

const filters = process.argv.slice(2);
const browser = await chromium.launch({ chromiumSandbox: false });
let failed = 0;
for (const shot of list) {
  if (filters.length && !filters.some(filter => shot.name.includes(filter))) continue;
  const [width, height] = shot.mobile ? [390, 844] : [1440, 900];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, isMobile: !!shot.mobile, hasTouch: !!shot.mobile });
  await context.addInitScript(({ theme, nav, lang }) => {
    localStorage.setItem('testbench-settings', JSON.stringify({ theme: theme || 'light', language: lang || 'en-IE', density: 'default', tracedSend: true }));
    if (nav) localStorage.setItem('testbench-nav:/openapi/v1.json', JSON.stringify({ ops: Object.fromEntries(nav.map(name => [name, true])), models: {} }));
  }, { theme: shot.theme, nav: shot.nav, lang: shot.lang });
  if (!shot.out) await context.request.post(`${base}/auth/login`, { data: { email: 'ada.admin@acme.dev', password: 'Demo123!' } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => message.type() === 'error' && !/40[134]|status of 4/.test(message.text()) && errors.push(message.text()));
  try {
    await page.goto(`${base}/bench/${shot.hash}`);
    await page.waitForSelector('.app:not(.loading-shell) #context', { state: 'attached', timeout: 15000 });
    if (shot.text) await page.evaluate(percent => { document.documentElement.style.fontSize = percent + '%'; }, shot.text);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await shot.setup?.(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${shot.name}.png`), animations: 'disabled' });
    // Side-by-side composite: mock on the left, live on the right.
    const mockPath = join(mockDir, `${shot.name}.png`);
    if (existsSync(mockPath)) {
      const composite = await browser.newPage({ viewport: { width: width * 2 + 72, height: height + 40 } });
      const html = join(out, 'compare', '_composite.html');
      writeFileSync(html, `<body style="margin:0;background:#888;display:flex;gap:24px;padding:20px 12px;box-sizing:border-box;font:12px sans-serif">
        <div><div style="color:#fff;margin-bottom:4px">mock</div><img src="${pathToFileURL(mockPath).href}" style="width:${width}px;display:block"></div>
        <div><div style="color:#fff;margin-bottom:4px">live</div><img src="${pathToFileURL(join(out, shot.name + '.png')).href}" style="width:${width}px;display:block"></div></body>`);
      await composite.goto(pathToFileURL(html).href);
      await composite.waitForFunction(() => [...document.images].every(image => image.complete));
      await composite.screenshot({ path: join(out, 'compare', `${shot.name}.png`) });
      await composite.close();
    }
    console.log(errors.length ? 'ERROR' : 'shot ', shot.name, errors.join(' | '));
    if (errors.length) failed++;
  } catch (error) {
    failed++;
    console.log('ERROR', shot.name, error.message.split('\n')[0]);
    await page.screenshot({ path: join(out, `${shot.name}-failed.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;

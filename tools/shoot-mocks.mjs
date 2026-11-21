// Renders the approved workbench mocks in mocks/ to PNG: workbench.html screens, board.html
// state boards and flow.html sequences (which embed the screens, so they render last).
// It first checks the v4 stable shell: Try it, Docs and a model page must share column edges,
// the head line and the bottom-bar line, or the run fails.
//   node tools/shoot-mocks.mjs              every screen
//   node tools/shoot-mocks.mjs 24 docs      only screens whose name contains "24" or "docs"
// Desktop is 1440×900, mobile 390×844, both at deviceScaleFactor 2.
// Env: OUT=<dir> writes elsewhere, DSF=1 renders at 1x for quick checks.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'mocks');
const out = process.env.OUT || join(root, 'screens');
const dsf = Number(process.env.DSF || 2);
// Exact name match with a leading '=' (node tools/shoot-mocks.mjs =76-v5-fields).
mkdirSync(out, { recursive: true });

// [name, page, query, mobile?]
const shots = [
  ['01-request-default', 'workbench', 'state=filled&run=preview&rtab=database'],
  ['02-request-default-dark', 'workbench', 'state=filled&run=preview&rtab=database&theme=dark'],
  ['03-density-compact', 'workbench', 'density=compact&state=filled&run=preview&rtab=database'],
  ['04-density-comfortable', 'workbench', 'density=comfortable&state=filled&run=preview&rtab=response'],
  ['05-display-settings', 'workbench', 'overlay=display&state=filled'],
  ['06-send-tooltip', 'workbench', 'overlay=send-tip&state=filled'],
  ['07-before-run-response', 'workbench', 'state=blank&rtab=response'],
  ['08-before-run-side-effects', 'workbench', 'state=blank&rtab=effects'],
  ['09-signed-out', 'workbench', 'auth=out&state=blank&rtab=response'],
  ['10-signed-out-auth-tab', 'workbench', 'auth=out&tab=auth&state=blank&rtab=database'],
  ['11-result-401', 'workbench', 'auth=out&op=list&run=401&rtab=response'],
  ['12-result-401-database-dark', 'workbench', 'auth=out&op=list&run=401&rtab=database&theme=dark'],
  ['13-send-not-captured', 'workbench', 'state=filled&run=send&traced=off&rtab=database'],
  ['14-signin-error', 'workbench', 'view=signin&signin=error500'],
  ['15-signin-error-dark', 'workbench', 'view=signin&signin=error500&theme=dark&details=1'],
  ['16-signin-wrong-password', 'workbench', 'view=signin&signin=wrong'],
  ['17-copied-url', 'workbench', 'state=filled&run=preview&rtab=response&copied=url'],
  ['18-copied-sql', 'workbench', 'state=filled&run=preview&rtab=logs&copied=sql'],
  ['19-copy-failed-body', 'workbench', 'state=filled&run=preview&rtab=response&copied=bodyfailed'],
  ['20-code-placeholders', 'workbench', 'tab=code&state=blank&rtab=response'],
  ['21-code-copy-failed', 'workbench', 'tab=code&state=blank&copied=failed&rtab=response'],
  ['22-validation', 'workbench', 'state=validation&overlay=issues&rtab=response'],
  ['23-field-toggletip', 'workbench', 'state=filled&overlay=toggletip&focus=amount&scrollto=amount'],
  ['24-docs', 'workbench', 'view=docs'],
  ['25-docs-responses-dark', 'workbench', 'view=docs&scroll=responses&theme=dark'],
  ['26-docs-deprecated', 'workbench', 'view=docs&op=update'],
  ['27-model-payment', 'workbench', 'view=model&model=Payment&side=models'],
  ['28-model-ref-oneof', 'workbench', 'view=model&model=BankDetails&from=CounterpartiesController.Create&via=Counterparty'],
  ['29-model-ref-oneof-dark', 'workbench', 'view=model&model=BankDetails&from=CounterpartiesController.Create&via=Counterparty&theme=dark&variant=BankDetailsUsAch'],
  ['30-response-schema', 'workbench', 'state=filled&run=preview&rtab=response&rview=schema'],
  ['31-wand-menu', 'workbench', 'state=filled&overlay=wand&focus=amount&scrollto=amount'],
  ['32-wand-generated', 'workbench', 'state=generated'],
  ['33-get-read-only', 'workbench', 'op=list&rtab=response'],
  ['34-filter-no-match', 'workbench', 'filter=nomatch&state=filled'],
  ['35-history-empty', 'workbench', 'overlay=history&state=filled'],
  ['36-headers-empty', 'workbench', 'tab=headers&hstate=empty&rtab=headers'],
  ['37-logs-filtered-empty', 'workbench', 'state=filled&run=preview&rtab=logs&logs=empty'],
  ['38-side-effects-zero', 'workbench', 'state=filled&run=preview&rtab=effects&effects=zero'],
  ['39-loading', 'workbench', 'boot=loading'],
  ['40-spec-error', 'workbench', 'boot=error'],
  ['41-network-error', 'workbench', 'state=filled&run=neterror'],
  ['42-board-before-run', 'board', 'set=before-run'],
  ['43-board-zero-and-empty', 'board', 'set=zero'],
  ['44-board-copy-feedback', 'board', 'set=copy'],
  ['45-i18n-de-DE', 'workbench', 'lang=de&state=filled&run=preview&rtab=database'],
  ['46-rtl-ar', 'workbench', 'lang=ar&state=filled&run=preview&rtab=database'],
  ['47-rtl-ar-dark-docs', 'workbench', 'lang=ar&view=docs&theme=dark'],
  ['48-api-overview-signed-out', 'workbench', 'view=overview&auth=out'],
  ['49-send-traced', 'workbench', 'state=filled&run=send&rtab=database'],
  ['50-display-settings-ar', 'workbench', 'lang=ar&overlay=display&state=filled'],
  ['51-autofill', 'workbench', 'state=blank&overlay=autofill&rtab=response'],
  ['52-id-lookup', 'workbench', 'op=get&tab=params&overlay=lookup&rtab=response'],
  ['53-headers-invalid-dark', 'workbench', 'tab=headers&hstate=invalid&theme=dark&rtab=headers'],
  ['54-in-flight-resizing', 'workbench', 'state=running&resizing=1'],
  ['55-keyboard-shortcuts', 'workbench', 'state=filled&overlay=shortcuts'],
  ['56-command-palette', 'workbench', 'state=filled&overlay=palette'],
  // v4: stable shell, one reference space, model visualiser, auth notice, expanded JSON.
  ['57-shell-try-it', 'workbench', 'auth=out&state=filled&run=preview&rtab=response'],
  ['58-shell-docs', 'workbench', 'auth=out&view=docs'],
  ['59-shell-model', 'workbench', 'auth=out&view=model&model=Payment&from=PaymentsController.Create'],
  ['60-docs-inline-expand', 'workbench', 'auth=out&view=docs&scroll=responses&expand=counterparty'],
  ['61-model-nested-ref', 'workbench', 'auth=out&view=model&model=Approval&from=PaymentsController.Create&via=Payment'],
  ['62-models-tab', 'workbench', 'view=model&model=Payment&side=models'],
  ['63-model-json-schema-dark', 'workbench', 'view=model&model=Payment&side=models&aside=schema&theme=dark'],
  ['64-model-expand-all', 'workbench', 'view=model&model=Payment&side=models&expandAll=1'],
  ['65-model-no-description', 'workbench', 'view=model&model=Account&side=models&strip=descriptions'],
  ['66-model-enum', 'workbench', 'view=model&model=PaymentStatus&side=models'],
  ['67-signed-out-docs-dark', 'workbench', 'auth=out&view=docs&theme=dark'],
  ['68-json-expanded', 'workbench', 'op=get&run=send&rtab=response'],
  ['69-json-large', 'workbench', 'op=list&run=send&rtab=response&body=large'],
  ['70-sidebar-groups-remembered', 'workbench', 'state=filled&collapsed=Authentication,Accounts,Balances'],
  ['74-docs-oneof-inline', 'workbench', 'view=docs&opid=CounterpartiesController.Create&scroll=body&expand=bankDetails'],
  ['75-docs-list-parameters', 'workbench', 'view=docs&opid=PaymentsController.List&theme=dark'],
  ['71-board-nav-before', 'flow', 'set=before'],
  ['72-board-nav-after', 'flow', 'set=after'],
  ['73-board-alignment', 'flow', 'set=align'],
  ['m01-request', 'workbench', 'state=filled', true],
  ['m02-request-130-dark', 'workbench', 'state=filled&text=130&theme=dark', true],
  ['m03-result-before-run', 'workbench', 'state=blank&mview=result&rtab=database', true],
  ['m04-result-401', 'workbench', 'auth=out&op=list&run=401&mview=result', true],
  ['m05-toggletip', 'workbench', 'state=filled&overlay=toggletip&focus=amount&scrollto=amount', true],
  ['m06-wand-menu', 'workbench', 'state=filled&overlay=wand&focus=amount&scrollto=amount', true],
  ['m07-docs', 'workbench', 'view=docs', true],
  ['m08-model-ref', 'workbench', 'view=model&model=Payment&from=PaymentsController.Create&expand=counterparty', true],
  ['m09-signin-error', 'workbench', 'view=signin&signin=error500&details=1', true],
  ['m10-de-130', 'workbench', 'lang=de&text=130&state=filled&run=preview&rtab=database&mview=result', true],
  ['m11-rtl-ar', 'workbench', 'lang=ar&state=filled', true],
  ['m12-headers-130-dark', 'workbench', 'tab=headers&hstate=invalid&theme=dark&text=130', true],
  ['m13-docs-signed-out', 'workbench', 'auth=out&view=docs', true],
  ['m14-model-from-docs', 'workbench', 'view=model&model=Payment&from=PaymentsController.Create', true],
  ['m15-drawer-signed-out', 'workbench', 'auth=out&state=filled&drawer=1', true],
  ['m16-json-expanded-dark', 'workbench', 'op=get&run=send&rtab=response&mview=result&theme=dark', true],
  ['m17-model-130', 'workbench', 'view=model&model=BankDetails&from=CounterpartiesController.Create&via=Counterparty&text=130', true],
  // v5 (README "v5"): Stripe-style reference, new form controls, response viewer, languages.
  ['76-v5-fields', 'workbench', 'v5=1&opid=AccountsController.List'],
  ['77-v5-fields-dark', 'workbench', 'v5=1&opid=AccountsController.List&theme=dark'],
  ['78-v5-select-open', 'workbench', 'v5=1&opid=AccountsController.List&pop=type&active=Collections'],
  ['79-v5-select-search', 'workbench', 'v5=1&opid=AccountsController.List&pop=currency&search=kr&theme=dark'],
  ['80-v5-select-typeahead', 'workbench', 'v5=1&opid=AccountsController.List&pop=sort&typed=-b'],
  ['81-v5-lookup-open', 'workbench', 'v5=1&opid=AccountsController.Get&pop=id'],
  ['82-v5-board-controls', 'controls', 'v5=1&set=controls'],
  ['83-v5-board-controls-dark', 'controls', 'v5=1&set=controls&theme=dark'],
  ['84-v5-board-anatomy', 'controls', 'v5=1&set=anatomy'],
  ['85-v5-board-lookup-states', 'controls', 'v5=1&set=lookup'],
  ['86-v5-validation', 'workbench', 'v5=1&opid=AccountsController.List&state=validation&scrollto=q'],
  ['87-v5-create-payment', 'workbench', 'v5=1&opid=PaymentsController.Create&focus=valueDate&scrollto=amount'],
  ['88-v5-deprecated-try-it', 'workbench', 'v5=1&opid=BalancesController.LegacyBalance'],
  ['89-v5-deprecated-docs', 'workbench', 'v5=1&view=docs&opid=BalancesController.LegacyBalance&theme=dark'],
  ['90-v5-deprecated-sidebar-tip', 'workbench', 'v5=1&opid=AccountsController.List&pop=dep-tip'],
  ['91-v5-model-account', 'workbench', 'v5=1&view=model&model=Account&side=models'],
  ['92-v5-model-nested-dark', 'workbench', 'v5=1&view=model&model=AccountBalance&side=models&theme=dark'],
  ['93-v5-model-oneof-deep', 'workbench', 'v5=1&view=model&model=Counterparty&side=models&collapse=address&mscroll=address'],
  ['94-v5-model-array-deep', 'workbench', 'v5=1&view=model&model=Payment&side=models&mscroll=approvals'],
  ['95-v5-model-union', 'workbench', 'v5=1&view=model&model=FxDeal&side=models'],
  ['96-v5-model-enum', 'workbench', 'v5=1&view=model&model=PaymentStatus&side=models'],
  ['97-v5-docs-params', 'workbench', 'v5=1&view=docs&opid=AccountsController.List'],
  ['98-v5-docs-body', 'workbench', 'v5=1&view=docs&opid=PaymentsController.Create&scroll=body'],
  ['99-v5-docs-responses-dark', 'workbench', 'v5=1&view=docs&opid=AccountsController.Get&scroll=responses&theme=dark'],
  ['100-v5-response-match', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&pop=match'],
  ['101-v5-response-mismatch', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&match=fail&pop=match'],
  ['102-v5-response-schema', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&rview=schema'],
  ['103-v5-response-schema-mismatch-dark', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&rview=schema&match=fail&theme=dark'],
  ['104-v5-response-table', 'workbench', 'v5=1&opid=AccountsController.List&run=send&rview=table'],
  ['105-v5-response-raw', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&rview=raw'],
  ['106-v5-response-narrow', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&match=fail&narrow=1'],
  ['107-v5-language-picker', 'workbench', 'v5=1&opid=AccountsController.List&overlay=display&pop=lang'],
  ['108-v5-language-rtl-preview', 'workbench', 'v5=1&opid=AccountsController.List&overlay=display&pop=lang&lsearch=he&lactive=he-IL'],
  ['109-v5-i18n-ja', 'workbench', 'v5=1&lang=ja&opid=AccountsController.List&run=send&rview=table'],
  ['110-v5-i18n-he-docs', 'workbench', 'v5=1&lang=he&view=docs&opid=AccountsController.List'],
  ['111-v5-response-table-scrolled', 'workbench', 'v5=1&opid=AccountsController.List&run=send&rview=table&tscroll=1&theme=dark'],
  ['112-v5-select-open-rtl', 'workbench', 'v5=1&lang=he&opid=AccountsController.List&pop=type&active=Payroll'],
  ['m18-v5-fields', 'workbench', 'v5=1&opid=AccountsController.List', true],
  ['m19-v5-select-130', 'workbench', 'v5=1&opid=AccountsController.List&pop=type&active=Payroll&text=130', true],
  ['m20-v5-rtl-he', 'workbench', 'v5=1&lang=he&opid=AccountsController.List&pop=currency', true],
  ['m21-v5-model-nested', 'workbench', 'v5=1&view=model&model=AccountBalance&side=models', true],
  ['m22-v5-response-dark', 'workbench', 'v5=1&opid=AccountsController.Get&run=send&match=fail&mview=result&theme=dark', true],
  ['m23-v5-deprecated', 'workbench', 'v5=1&opid=BalancesController.LegacyBalance', true],
  ['m24-v5-lookup-130-dark', 'workbench', 'v5=1&opid=AccountsController.Get&pop=id&text=130&theme=dark', true],
  ['m25-v5-language-sheet', 'workbench', 'v5=1&opid=AccountsController.List&pop=lang&lsearch=he&lactive=he-IL', true],
];

/**
 * The stable shell, checked: in Try it, Docs and a model page the column edges, the head
 * line and every pane's bottom-bar line must be identical. Returns the guides for the
 * alignment board, or throws with the views that differ.
 */
async function measureShell(browser) {
  const views = { try: 'auth=out&state=filled&run=preview&rtab=response', docs: 'auth=out&view=docs', model: 'auth=out&view=model&model=Payment&from=PaymentsController.Create' };
  const found = {};
  for (const [name, query] of Object.entries(views)) {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await tab.goto(`${pathToFileURL(join(root, 'workbench.html')).href}?${query}`);
    await tab.waitForTimeout(250);
    found[name] = await tab.evaluate(() => {
      const box = el => el.getBoundingClientRect();
      const ws = document.querySelector('.workspace');
      const [side, main, right] = ws.querySelectorAll(':scope > .sidebar, :scope > .pane');
      const head = el => Math.round(box(el.querySelector(':scope > .tabs, :scope > .ctx-bar, :scope > .aside-head, :scope > .resp-head')).bottom);
      const bar = el => Math.round(box(el.querySelector(':scope > .pane-bar, :scope > .actionbar')).top);
      return { cols: [Math.round(box(side).right), Math.round(box(right).left)], heads: [head(side), head(main), head(right)], bars: [bar(side), bar(main), bar(right)] };
    });
    await tab.close();
  }
  const sig = v => JSON.stringify(v);
  const first = found.try;
  const problems = Object.entries(found).filter(([, v]) => sig(v.cols) !== sig(first.cols) || new Set([...v.heads, ...first.heads]).size > 1 || new Set([...v.bars, ...first.bars]).size > 1);
  if (problems.length) throw new Error('Shell geometry differs: ' + JSON.stringify(found));
  console.log('layout', `columns ${first.cols.join(', ')} · head ${first.heads[0]} · bars ${first.bars[0]} in Try it, Docs and Model`);
  return `${first.cols.join(',')};${first.heads[0]},${first.bars[0]}`;
}

const filters = process.argv.slice(2);
const browser = await chromium.launch({ chromiumSandbox: false });
let failed = 0;
let guides = '';
try { guides = await measureShell(browser); } catch (error) { console.log('ERROR', error.message); failed++; }
for (const [name, page, query, mobile] of shots) {
  if (filters.length && !filters.some(f => f.startsWith('=') ? name === f.slice(1) : name.includes(f))) continue;
  const [width, height] = mobile ? [390, 844] : [1440, 900];
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dsf, isMobile: !!mobile, hasTouch: !!mobile });
  const errors = [];
  tab.on('pageerror', e => errors.push(e.message));
  await tab.goto(`${pathToFileURL(join(root, page + '.html')).href}?${query}${query.includes('set=align') ? `&guides=${guides}` : ''}`);
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(page === 'workbench' ? 350 : 900);
  // Boards and flows are taller than the viewport, so they're captured whole.
  await tab.screenshot({ path: join(out, `${name}.png`), animations: 'disabled', fullPage: page !== 'workbench' });
  await tab.close();
  if (errors.length) failed++;
  console.log(errors.length ? 'ERROR' : 'shot ', name, errors.join(' | '));
}
await browser.close();
process.exitCode = failed ? 1 : 0;

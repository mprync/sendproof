// v5 (?v5=1): the panes that change in v5, built from mocks/spec.js. Runs after the v4 pane
// builders and before the overlays, and replaces what they rendered:
//   Try it   the request pane with the v5 field anatomy, selects, radio groups and lookups,
//            and the deprecation notice; the result pane's head row and response viewer.
//   Docs     the deprecation notice (the attribute list itself comes from v5.js via S.tree).
//   Model    an enum's page lists "Possible enum values" with their descriptions.
// Parameters (v5 only):
//   opid=<operationId>   AccountsController.List (default) | AccountsController.Get |
//                        BalancesController.LegacyBalance | PaymentsController.Create
//   state=blank|filled|validation|generated   focus=<field> (hover|focus ring)   hover=<field>
//   fstate=disabled (every field disabled, for the boards)
//   run=none|send       rview=pretty|raw|table|schema   match=fail (the body breaks its schema)
//   wrap=1 (Raw view wraps)   narrow=1 (a narrow result pane)   pop=<name> (v5-overlays.js)
(function () {
  const { q, ico, kbd, aks, tab, copyBtn, t } = window.TB;
  if (!q.v5) return;
  const S = window.TB.schema;
  const V = window.TB.v5;
  const esc = S.esc;
  const { num, unit, decimal, date, weekday } = window.i18n;
  const BASE = 'http://127.0.0.1:5189';
  const component = (kind, x) => x?.$ref ? S.spec.components?.[kind]?.[x.$ref.split('/').pop()] || {} : x || {};
  if (q.narrow) document.querySelector('.workspace')?.style.setProperty('--main-fr', '1.9fr');

  /* ---------- Docs and model pages ---------- */
  if (q.view === 'docs') {
    const o = window.TB.currentOp(q);
    const old = document.querySelector('.doc-pane .deprecation');
    if (old && o.deprecated) old.outerHTML = V.deprecation(o, 'docs');
    // The prose repeats "Deprecated." from the description; the notice says it once.
    document.querySelectorAll('.doc-pane .prose p').forEach(p => { p.innerHTML = p.innerHTML.replace(/^<strong>Deprecated\.<\/strong>\s*/, ''); });
  }
  document.querySelectorAll('.stree').forEach(el => el.removeAttribute('role'));
  // Child attributes start open, so the list heads offer Collapse all.
  document.querySelectorAll('.doc-pane .card-head .btn, .doc-pane .media .btn').forEach(b => { if (b.textContent.includes(t('expandAll'))) b.innerHTML = b.innerHTML.replace(t('expandAll'), t('collapseAll')); });
  // Fix: the Docs response example picked the first captured object with the page's keys, so
  // List accounts showed a page of payments. Match list pages by their items' required keys too.
  if (q.view === 'docs') {
    const o = window.TB.currentOp(q);
    const ok = Object.entries(o.op.responses || {}).find(([c]) => /^2/.test(c));
    const schema = ok && component('responses', ok[1]).content?.['application/json']?.schema;
    const r = schema && S.resolve(schema);
    const items = r?.properties?.items && S.resolve(r.properties.items.items || {});
    if (items?.required) {
      const fits = v => v && Array.isArray(v.items) && v.items[0] && items.required.every(k => k in v.items[0]);
      const real = Object.values(window.TB_SAMPLES || {}).find(fits);
      const card = document.querySelectorAll('.aside-pane .sample-card')[1];
      const view = card?.querySelector('.code-view');
      if (real && view) view.outerHTML = S.jsonView(real, { label: t('docs.responseSample'), maxLines: 40 }).html;
    }
  }
  if (q.view === 'model') {
    const raw = S.schemas[q.model] || {};
    const card = document.querySelector('.doc-pane .enum-list')?.closest('.card');
    if (card && raw.enum) card.outerHTML = `<div class="attr-enum is-page">${(() => {
      const en = V.enumOf(raw);
      return en.described
        ? `<dl class="enum-dl is-page">${en.values.map(v => `<div><dt><code>${esc(v)}</code></dt>${en.desc[v] ? `<dd lang="en">${esc(en.desc[v])}</dd>` : `<dd class="is-quiet">${t('schema.noDesc')}</dd>`}</div>`).join('')}</dl>`
        : `<p class="attr-desc is-quiet">${t('model.valuesUndescribed')}</p><ul class="enum-inline is-page">${en.values.map(v => `<li><code>${esc(v)}</code></li>`).join('')}</ul>`;
    })()}</div>`;
    // Mock-only: bring a row of the list into view (?mscroll=<attribute path>).
    if (q.mscroll) requestAnimationFrame(() => { const el = document.getElementById('m-' + q.mscroll.replace(/\W/g, '-')); const sc = el?.closest('.pane-scroll'); if (el && sc) sc.scrollTop = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16; });
    const h2 = document.querySelector('.doc-pane h2');
    if (h2 && raw.enum) h2.firstChild.textContent = t('v5.enumValues') + ' ';
  }
  if (['docs', 'model', 'overview', 'signin'].includes(q.view) || q.boot) return;

  /* ---------- Try it: the operation ---------- */
  const o = S.operations.find(x => x.id === (q.opid || 'AccountsController.List')) || S.operations[0];
  const op = o.op;
  const st = q.state || 'filled';
  const signedOut = q.auth === 'out';
  const readOnly = o.method === 'get';
  const params = (op.parameters || []).map(p => component('parameters', p));
  const accounts = window.TB_SAMPLES?.accountsPage?.items || [];
  const acct = accounts[0] || {};
  const symbol = c => ({ EUR: '€', USD: '$', GBP: '£', CHF: 'F', SEK: 'kr', JPY: '¥', NOK: 'kr', DKK: 'kr', CAD: '$', AUD: '$', PLN: 'zł' }[c] || c[0]);
  const fieldState = name => q.fstate === 'disabled' ? 'disabled' : q.pop === name ? 'open' : q.focus === name ? 'focus' : q.hover === name ? 'hover' : 'rest';

  // Values per state. "filled" is what the owner's screenshot showed, set the v5 way.
  const values = {
    blank: {},
    filled: { status: 'Open', currency: 'EUR', id: true, accountId: true },
    validation: { status: 'Open', currency: 'EUR', page: '0', pageSize: '500', q: 'Amsterdam operating account opened by the Dutch entity for collections and payroll in euro and pounds', id: false },
    generated: { status: 'Frozen', type: 'Savings', currency: 'CHF', id: true, gen: true },
  }[st] || {};
  const errors = st === 'validation' ? {
    page: t('v5.err.min', { min: num(1) }), pageSize: t('v5.err.range', { min: num(1), max: num(100) }), q: t('v5.err.long', { n: num(100), now: num(values.q.length) }), id: t('v5.err.lookup'),
  } : {};

  function paramField(p) {
    const val = values[p.name];
    const f = V.fromParam(p, {});
    f.state = fieldState(p.name);
    f.error = errors[p.name];
    if (f.kind === 'lookup') {
      if (val) {
        f.picked = [symbol(acct.currency || 'EUR'), acct.name, acct.iban];
        f.status = t('v5.sends', { id: `<code>${esc(acct.id.slice(0, 8))}…${esc(acct.id.slice(-4))}</code>` });
      } else f.status = signedOut ? t('v5.lookup.signedOut') : t('v5.lookup.count', { n: num(accounts.length), who: 'Ada Admin' });
      if (values.gen) f.generated = t('v5.gen.lookup');
    } else if (val !== undefined) {
      f.value = val;
      if (f.kind === 'text') f.count = `${num(val.length)} / ${num(S.resolve(p.schema).maxLength)}`;
      if (f.kind === 'radio' || f.kind === 'select') f.status = f.optional ? t('v5.sendsValue', { v: `<code>${esc(p.name)}=${esc(val)}</code>` }) : '';
      if (values.gen && (f.kind === 'radio' || f.kind === 'select')) f.generated = t('v5.gen.enum');
    }
    if (q.hover === p.name && f.kind === 'radio') f.hoverOn = f.options[1]?.v;
    // Two short fields share a row; selects with descriptions keep the full width.
    f.half = ['page', 'pageSize', 'type', 'currency'].includes(p.name);
    return V.field(f);
  }

  /** Query parameters split into filters and paging, path parameters on their own. */
  function paramsBody() {
    const paging = ['page', 'pageSize', 'sort'];
    const groups = [
      [t('v5.sec.path'), params.filter(p => p.in === 'path')],
      [t('v5.sec.filter'), params.filter(p => p.in === 'query' && !paging.includes(p.name))],
      [t('v5.sec.paging'), params.filter(p => p.in === 'query' && paging.includes(p.name)).sort((a, b) => paging.indexOf(a.name) - paging.indexOf(b.name))],
    ].filter(([, list]) => list.length);
    return `<form class="form" novalidate onsubmit="return false">${groups.map(([name, list]) => `
      <fieldset><legend class="section-label">${name}<span class="rule" aria-hidden="true"></span></legend>
        <div class="fields f5s">${list.map(paramField).join('')}</div></fieldset>`).join('')}
    </form>`;
  }

  /** Create payment: the body as a form, with the same anatomy as parameters. */
  function createBody() {
    const body = S.schemas.CreatePaymentRequest;
    const P = body.properties;
    const md = s => S.md(s, { block: false });
    const valueDate = '2026-11-23';
    const filled = st !== 'blank';
    const fields = [
      { name: 'debitAccountId', kind: 'lookup', label: P.debitAccountId.title, type: 'uuid', desc: md(P.debitAccountId.description), placeholder: t('v5.chooseAn', { name: 'an account' }),
        picked: filled ? ['€', 'Operating EUR', 'IE29 AIBK 9311 5212 3456 78'] : undefined, status: filled ? t('v5.sends', { id: '<code>3f9c0000…a21e</code>' }) : t('v5.lookup.count', { n: num(12), who: 'Ada Admin' }), error: st === 'validation' ? t('v5.err.lookup') : undefined },
      { name: 'counterpartyId', kind: 'lookup', label: P.counterpartyId.title, type: 'uuid', desc: md(P.counterpartyId.description), placeholder: t('v5.chooseAn', { name: 'a counterparty' }),
        picked: filled ? ['N', 'Northwind Logistics GmbH', 'DE89 3704 0044 0532 0130 00'] : undefined, status: filled ? t('v5.sends', { id: '<code>5b7c0000…b123</code>' }) : t('v5.lookup.count', { n: num(24), who: 'Ada Admin' }) },
      { name: 'amount', kind: 'money', label: 'Amount', type: 'decimal', desc: md(P.amount.description), value: filled ? decimal(50000) : '', currency: 'EUR', half: true,
        status: t('v5.atLeast', { min: decimal(0.01) }) + ' · ' + t('v5.f.step') + ' ' + decimal(0.01), error: st === 'validation' ? t('v5.err.number') : undefined },
      { name: 'valueDate', kind: 'date', label: P.valueDate.title, type: 'date', desc: md(P.valueDate.description), value: filled ? date(valueDate) : '', trail: filled ? weekday(valueDate) : '', half: true,
        status: filled ? t('v5.inDays', { n: 2 }) : t('v5.businessDays'), state: fieldState('valueDate') },
      { name: 'priority', kind: 'radio', label: 'priority', type: 'enum', optional: true, desc: md(P.priority.description), value: filled ? 'Normal' : undefined,
        options: V.enumOf(P.priority).values.map(v => ({ v, d: V.enumOf(P.priority).desc[v] })), status: filled ? t('v5.sendsValue', { v: '<code>"Normal"</code>' }) : t('v5.notSent'), state: fieldState('priority') },
      { name: 'reference', kind: 'text', label: 'reference', type: 'string', optional: true, desc: md(P.reference.description), value: filled ? 'INV-2026-1184 / Q4 freight' : '',
        count: `${num(filled ? 26 : 0)} / ${num(35)}`, state: fieldState('reference') },
    ];
    return `<form class="form" novalidate onsubmit="return false"><fieldset aria-labelledby="body-legend">
      <div class="section-label"><span id="body-legend">${t('section.body')} <a class="schema-link" href="#">CreatePaymentRequest</a></span><span class="rule" aria-hidden="true"></span>
        <div class="segmented" role="group" aria-label="Body editor"><button type="button" aria-pressed="true">${t('form')}</button><button type="button" aria-pressed="false">${t('json')}</button></div></div>
      <div class="fields f5s">${fields.map(V.field).join('')}
        <div class="optional-props" role="group" aria-label="Add optional fields"><span class="lead-label">${t('add')}</span>
          ${[['remittanceLines', 'string[]'], ['chargeBearer', 'enum'], ['purposeCode', 'string'], ['externalId', 'string']].map(([n, ty]) => `<button type="button" class="prop-chip">${ico('plus', 'i i-sm')}<span class="ltr">${n}</span><span class="t">${ty}</span></button>`).join('')}</div>
      </div></fieldset></form>`;
  }

  const hasBody = !!op.requestBody;
  const tabs = [...(hasBody ? [['body', t('tab.body')]] : []), ...(params.some(p => p.in !== 'header') ? [['params', t('tab.params'), params.filter(p => p.in !== 'header').length]] : []), ['headers', t('tab.headers'), hasBody ? 5 : 1], ['auth', t('tab.auth')], ['code', t('tab.code')]];
  const tabKey = q.tab || tabs[0][0];
  const errCount = Object.keys(errors).filter(k => params.some(p => p.name === k)).length;
  const notice = o.deprecated ? V.deprecation(o, 'try')
    : signedOut && o.secured ? `<div class="op-notice auth" role="note">${ico('lock', 'i i-sm')}<span class="grow"><strong>${t('v5.needsSignin')}</strong> ${t('v5.needsSigninBody')}</span><button class="btn btn-sm">${ico('log-in', 'i i-sm')}${t('signIn')}</button></div>` : '';
  const statusBar = st === 'validation'
    ? `<span class="status" role="status"><button class="issues-btn" aria-haspopup="dialog" aria-expanded="false" aria-keyshortcuts="Alt+ArrowDown">${ico('alert', 'i i-sm')}${t('v5.issues', { n: errCount || 2 })} ${kbd('alt', '↓')}</button></span>`
    : st === 'generated' ? `<span class="status is-ok" role="status">${ico('wand', 'i i-sm')}<span>${t('v5.filled', { n: 4 })}</span><button class="btn btn-ghost btn-xs" aria-keyshortcuts="${aks('mod', 'Z')}">${t('v5.undo')} ${kbd('mod', 'Z')}</button></span>`
    : readOnly ? `<span class="status">${ico('eye', 'i i-sm')}<span>${t('v5.readOnly')}</span></span>`
    : `<span class="status">${ico('undo', 'i i-sm')}<span>${t('bar.rule')}</span></span>`;
  const sendBtn = `<button class="btn btn-run btn-send${readOnly ? ' btn-primary' : ''}" id="send-btn" aria-keyshortcuts="${aks(...(readOnly ? ['mod', 'enter'] : ['shift', 'mod', 'enter']))}">${ico('send', 'i i-sm')}${t('send')}${readOnly ? kbd('mod', 'enter') : kbd('shift', 'mod', 'enter')}</button>`;
  const previewBtn = readOnly ? '' : `<button class="btn btn-primary btn-run btn-preview" aria-keyshortcuts="${aks('mod', 'enter')}">${ico('flask', 'i i-sm')}${t('preview')}${kbd('mod', 'enter')}</button>`;
  const path = esc(o.path).replace(/\{(\w+)\}/g, (_, n) => `<span class="token">${ico('link', 'i i-sm')}${n}</span>`);
  const roles = o.roles.length ? o.roles.join(' or ') : 'cookieAuth';
  const codes = Object.keys(op.responses || {}).join(' · ');

  const request = `
  <main class="pane request" id="request" aria-labelledby="op-title">
    ${window.TB.ctxBar(q, 'op', 'try')}
    <div class="pane-scroll">
      <div class="op-head">
        <div class="op-title-row"><h1 class="op-title" id="op-title" lang="en">${esc(o.summary)}</h1></div>
        <p class="op-desc" lang="en">${S.md(S.firstSentence((op.description || '').replace(/^\s*\*\*Deprecated\.\*\*\s*/, '')), { block: false })}</p>
        <div class="op-meta"><span class="pill">${ico(signedOut ? 'lock' : 'shield', 'i i-sm')}<span class="ltr">${esc(roles)}</span></span><span class="pill ltr">${codes}</span></div>
        ${notice}
        <div class="urlbar"><span class="method m-${o.method}">${o.method.toUpperCase()}</span><span class="url"><span class="base">${BASE}</span>${path}</span>${copyBtn(t('pick.copy'), { size: 'btn-xs' })}</div>
      </div>
      <div class="tabs" role="tablist" aria-label="Request">
        ${tabs.map(([k, label, n], i) => tab(label, { selected: k === tabKey, count: n, keys: `Alt+${i + 1}`, flag: k === tabKey && errCount ? t('v5.issues', { n: errCount }) : undefined })).join('')}
        ${['body', 'params'].includes(tabKey) ? `<div class="end"><button class="btn btn-ghost btn-sm" id="autofill" aria-haspopup="menu" aria-keyshortcuts="${aks('shift', 'mod', 'F')}">${ico('wand', 'i i-sm')}<span class="lbl">${t('autofill')}</span>${ico('chevron-down', 'i i-sm')}</button></div>` : ''}
      </div>
      ${tabKey === 'body' ? createBody() : paramsBody()}
    </div>
    <div class="actionbar">${statusBar}${sendBtn}${previewBtn}</div>
  </main>`;
  document.querySelector('main.request')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: request.trim() }).content.firstElementChild);

  /* ---------- Try it: the result pane ---------- */
  const run = q.run || 'none';
  const replacePane = html => document.querySelector('section.pane.response')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: html.trim() }).content.firstElementChild);
  if (run === 'none') {
    // Before a run: the steps and this operation's documented responses, from the spec.
    const pane = document.querySelector('section.pane.response .expect');
    const rows = Object.entries(op.responses || {}).map(([code, r]) => {
      r = component('responses', r);
      const media = r.content && Object.values(r.content)[0]?.schema;
      const name = media && (S.refName(media) || S.typeLabel(media).text);
      return `<div class="expect-row"><span class="code ${/^2/.test(code) ? 'ok' : 'err'}">${code}</span><span lang="en">${S.md(S.firstSentence(r.description), { block: false })}</span><span class="spacer"></span>${name ? `<a class="type-link" href="#">${esc(name)}</a>` : `<span class="faint">${t('docs.noBody')}</span>`}</div>`;
    }).join('');
    if (pane) pane.innerHTML = `<div class="expect-h">Documented responses</div>${rows}`;
    if (readOnly) document.querySelectorAll('section.pane.response .steps li').forEach(li => { if (/Preview/.test(li.textContent)) li.remove(); });
    const body = document.querySelector('section.pane.response .state > p');
    if (body && readOnly) body.textContent = 'Run the request to see the status, body and timing. GET is read-only, so Send changes nothing.';
    return;
  }
  if (run !== 'send') return;
  const list = o.id === 'AccountsController.List';
  const fail = q.match === 'fail';
  const value = list ? window.TB_SAMPLES.accountsPage : fail ? window.TB_SAMPLES.accountMismatch : window.TB_SAMPLES.account;
  const model = list ? 'PagedListOfAccount' : 'Account';
  const rview = q.rview || 'pretty';
  const bytes = JSON.stringify(value).length;
  const issues = fail ? {
    entityCountry: t('v5.issue.length', { n: 2, got: '<code>"NLD"</code>', len: 3 }),
    bic: t('v5.issue.missing'),
  } : {};
  const extra = fail ? [{ name: 'legacyCode', value: value.legacyCode, issue: t('v5.issue.extra', { model: 'Account' }) }] : [];
  const issueCount = Object.keys(issues).length + extra.length;

  // Paths the body actually returned, for the Schema view's markers.
  const present = new Set();
  (function walk(v, path) {
    if (Array.isArray(v)) { if (v[0] !== undefined) walk(v[0], path + '[]'); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const p = path ? (path.endsWith('[]') ? `${path}.${k}` : `${path}.${k}`) : k; present.add(p); walk(x, p); }
  })(value, '');

  const match = fail
    ? `<button class="match5 is-fail" type="button" aria-haspopup="dialog" aria-expanded="${q.pop === 'match'}" id="match-btn">${ico('warn', 'i i-sm')}<span class="full">${t('v5.match.issues', { n: issueCount })}</span><span class="short" aria-hidden="true">${num(issueCount)}</span></button>`
    : `<button class="match5" type="button" aria-haspopup="dialog" aria-expanded="${q.pop === 'match'}" id="match-btn">${ico('circle-check', 'i i-sm')}<span class="full">${t('v5.match.ok')}</span><span class="short" aria-hidden="true">${t('v5.view.schema')}</span></button>`;
  const head = `<div class="resp-head">
      <span class="pill pill-ok">${ico('send', 'i i-sm')}${t('res.traced')}</span>
      <span class="status-code ok">${ico('check', 'i i-sm')}200 OK</span>
      <span class="metric"><bdi>${unit(list ? 18 : 12, 'millisecond')}</bdi><span class="size"> · <bdi>${unit(bytes / 1024, 'kilobyte', 1)}</bdi></span></span>
      ${match}<span class="spacer"></span>${copyBtn(t('copy.curl'), { keys: aks('shift', 'mod', 'C') })}
    </div>`;

  /* The four views. None of them wrap: long lines scroll sideways, numbers stay in the gutter. */
  function pretty() {
    const j = S.jsonView(value, { label: 'Response body, application/json' });
    if (!fail) return j.html;
    // Lines the schema check flagged carry a marker and a quiet reason at the end.
    const notes = { '"entityCountry"': t('v5.issue.lenShort', { n: 2 }), '"legacyCode"': t('v5.issue.extraShort') };
    return j.html.replace(/<div class="ln"([^>]*)>([\s\S]*?)<\/div>/g, (m, a, inner) => {
      const key = Object.keys(notes).find(k => inner.includes(esc(k)));
      if (key) return `<div class="ln is-issue"${a}>${inner.replace(/<\/span>\s*$/, '')}<span class="ln-note">${ico('warn', 'i i-sm')}${notes[key]}</span></span></div>`;
      if (/>1<\/span>/.test(inner) && /tok-p">\{</.test(inner)) return `<div class="ln is-issue"${a}>${inner.replace(/<\/span>\s*$/, '')}<span class="ln-note">${ico('warn', 'i i-sm')}${t('v5.issue.missingShort', { name: 'bic' })}</span></span></div>`;
      return m;
    });
  }
  function raw() {
    return `<div class="raw5${q.wrap ? ' is-wrap' : ''}" tabindex="0" role="region" aria-label="${t('v5.view.raw')}"><span class="no" aria-hidden="true">1</span><pre class="ltr">${esc(JSON.stringify(value))}</pre></div>
      <div class="tbl5-foot"><span>${t('v5.raw.foot', { size: `<bdi>${unit(bytes / 1024, 'kilobyte', 1)}</bdi>`, type: '<code>application/json; charset=utf-8</code>' })}</span><span class="spacer"></span><span>${q.wrap ? t('v5.raw.wrapped') : t('v5.raw.scroll')}</span></div>`;
  }
  function table() {
    const cell = v => v === null ? '<span class="null">null</span>'
      : typeof v === 'number' ? `<span class="n">${esc(v)}</span>`
      : typeof v === 'object' ? `<button class="obj" type="button">${Array.isArray(v) ? t('json.items', { n: v.length }) : t('json.keys', { n: Object.keys(v).length })}</button>`
      : esc(v);
    if (list) {
      const rows = value.items;
      // The lookup's label field (name) leads and stays visible while the rest scroll sideways.
      const cols = Object.keys(rows[0] || {}).sort((a, b) => (b === 'name') - (a === 'name'));
      const numeric = new Set(cols.filter(c => typeof rows[0][c] === 'number'));
      return `<div class="tbl5-wrap"><div class="tbl5" role="region" tabindex="0" aria-label="${t('v5.view.tableOf', { name: 'items' })}">
        <table><thead><tr><th scope="col" class="idx">#</th>${cols.map((c, i) => `<th scope="col" class="${numeric.has(c) ? 'num' : ''}${i ? '' : ' lead'}">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr><th scope="row" class="idx">${i + 1}</th>${cols.map((c, i) => `<td class="${numeric.has(c) ? 'num' : ''}${i ? '' : ' lead'}">${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
        <div class="tbl5-foot"><span>${t('v5.table.foot', { rows: num(rows.length), path: '<code>items</code>' })} · ${t('v5.table.page', { page: num(value.page), pages: num(value.totalPages), total: num(value.totalItems) })}</span><span class="spacer"></span>
          <button class="tbl5-more" type="button" aria-label="${t('v5.table.moreLabel', { n: num(cols.length) })}">${t('v5.table.more', { n: num(cols.length) })}${ico('arrow-right', 'i i-sm')}</button></div>`;
    }
    return `<div class="tbl5 is-kv" role="region" tabindex="0" aria-label="${t('v5.view.table')}"><table><thead><tr><th scope="col">${t('v5.table.field')}</th><th scope="col">${t('v5.table.value')}</th></tr></thead>
      <tbody>${Object.entries(value).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="${typeof v === 'number' ? 'num' : ''}">${cell(v)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function schema() {
    const legend = `<div class="legend5"><span>${V.mark('on')}${t('v5.legend.on')}</span><span>${V.mark('off')}${t('v5.legend.off')}</span>${fail ? `<span>${V.mark('issue')}${t('v5.legend.issue')}</span>` : ''}<span class="spacer"></span><a class="type-link" href="#">${esc(model)}${ico('arrow-right', 'i i-sm')}</a></div>`;
    return `${legend}${V.tree(model, { compact: true, present, issues, extra, id: 'rs', expanded: new Set(list ? ['items'] : []) })}`;
  }
  const views = [['pretty', t('v5.view.pretty')], ['raw', t('v5.view.raw')], ['table', t('v5.view.table')], ['schema', t('v5.view.schema')]];
  const toolbar = `<div class="viewer-bar vb5">
      <div class="segmented sm" role="radiogroup" aria-label="${t('v5.view.label')}">${views.map(([k, l]) => `<button role="radio" aria-checked="${k === rview}">${l}</button>`).join('')}</div>
      <span class="spacer"></span>
      ${rview === 'pretty' ? `<button class="btn btn-ghost btn-xs vb5-lbl" aria-keyshortcuts="Alt+Shift+ArrowUp" title="${t('collapseAll')}">${ico('chevrons-ud', 'i i-sm')}<span class="lbl">${t('collapseAll')}</span></button>` : ''}
      ${rview === 'raw' ? `<button class="btn btn-ghost btn-icon btn-xs" aria-pressed="${!!q.wrap}" aria-label="${t('v5.wrap')}" title="${t('v5.wrap')} (⌥Z)">${ico('wrap', 'i i-sm')}</button>` : ''}
      <button class="btn btn-ghost btn-icon btn-xs" aria-label="${t('v5.searchBody')}" title="${t('v5.searchBody')} (⌘F)" aria-keyshortcuts="${aks('mod', 'F')}">${ico('search', 'i i-sm')}</button>
      ${copyBtn(t('v5.copyBody'), { size: 'btn-xs', keys: aks('alt', 'mod', 'C') })}
    </div>`;
  const body = { pretty, raw, table, schema }[rview]();
  const nextSteps = list ? '' : `<div class="next-steps" role="group" aria-label="Use this result"><span class="faint">${t('v5.useIn', { name: '<code>id</code>' })}</span>
      <button class="chain"><span class="method m-get">GET</span><span lang="en">Get balance</span>${kbd('mod', 'G')}</button>
      <button class="chain"><span class="method m-put">PUT</span><span lang="en">Update account</span></button></div>`;
  const resultTabs = ['res.response', 'res.database', 'res.effects', 'res.logs', 'res.headers'];
  const counts = [undefined, 0, 0, 2, 8];
  const resultPane = `
  <section class="pane response" aria-label="Result">
    ${head}
    <div class="tabs" role="tablist" aria-label="Result">${resultTabs.map((k, i) => tab(t(k), { selected: i === 0, count: counts[i] })).join('')}</div>
    <div class="pane-scroll"><div class="result-body">
      ${nextSteps}
      <div class="viewer v5-viewer">${toolbar}<div class="vb5-body is-${rview}">${body}</div></div>
    </div></div>
    <div class="pane-bar"><span class="bar-text">${ico('send', 'i i-sm')}<span>${t('bar.lastRun', { what: t('bar.sendTraced'), time: '14:02:11' })}</span></span>
      <button class="btn btn-ghost btn-sm" aria-keyshortcuts="Meta+Y">${ico('history', 'i i-sm')}${t('history')}${kbd('mod', 'Y')}</button></div>
  </section>`;
  replacePane(resultPane);
  // Columns that scroll off to the side get an edge fade and the "15 columns, scroll" button;
  // scrolled, the sticky name column casts a shadow. ?tscroll=1 shows a scrolled table.
  const region = document.querySelector('.tbl5');
  if (region) {
    if (q.tscroll) { region.scrollLeft = (document.documentElement.dir === 'rtl' ? -1 : 1) * 520; region.scrollTop = 220; }
    const update = () => {
      const max = region.scrollWidth - region.clientWidth, x = Math.abs(region.scrollLeft);
      region.parentElement.classList.toggle('more-end', x < max - 1);
      region.parentElement.classList.toggle('is-scrolled', x > 0);
      document.querySelector('.tbl5-more')?.toggleAttribute('hidden', max <= 0);
    };
    region.addEventListener('scroll', update); update();
  }
})();

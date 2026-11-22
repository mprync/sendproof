// Request pane for the v3 mocks, rendered from a small field description the same way the
// product renders it from the OpenAPI schema.
//   op     create | get | list | update | login
//   tab    body | params | headers | auth | code
//   state  blank | filled | validation | running | generated
//   hstate (headers) filled | empty      copied=url|code|failed      focus=<field>
(function () {
  const { ico, kbd, aks, tab, copyBtn, copyTextBtn, state: stateBlock, t } = window.TB;
  const { decimal, money, date, weekday, datePattern } = window.i18n;
  /** Builds the pane for a set of URL-style parameters; the boards call it directly. */
  function build(q) {
  const op = q.op || 'create';
  const st = q.state || 'filled';
  const signedOut = q.auth === 'out';

  /* ---------- Field rendering ---------- */
  // Every field: label row / control / assist line. The assist line shows the hint, the
  // error, or "Generated" with Undo, always in the same one-line slot.
  function field(f, v) {
    const id = 'f-' + f.name;
    const err = v.error;
    const assistId = id + '-assist';
    const tipOpen = q.overlay === 'toggletip' && q.focus === f.name;
    const info = `<button type="button" class="info-btn" aria-label="About ${f.label}" aria-expanded="${tipOpen}" ${tipOpen ? 'aria-controls="tip"' : ''}>${ico('info', 'i')}</button>`;
    const label = `<span class="label"><label for="${id}" lang="en">${f.label}</label>${info}${f.optional ? `<span class="opt">${t('optional')}</span>` : ''}<span class="type">${f.type}</span></span>`;
    // The slot holds one thing: error icon, or the Generate button (visible on hover and focus).
    const showWand = v.focus || v.generated || (q.overlay === 'wand' && q.focus === f.name);
    const slot = err
      ? `<span class="slot err" aria-hidden="true">${ico('alert', 'i i-sm')}</span>`
      : showWand
        ? `<button type="button" class="slot wand${q.overlay === 'wand' && q.focus === f.name ? ' is-active' : ''}${v.generated ? ' gen' : ''}" aria-label="Generate a value for ${f.label}" aria-keyshortcuts="Alt+G" ${q.overlay === 'wand' && q.focus === f.name ? 'aria-expanded="true" aria-controls="gen-menu"' : 'aria-expanded="false"'} aria-haspopup="menu">${ico('wand', 'i i-sm')}</button>`
        : `<span class="slot" aria-hidden="true"></span>`;
    const aria = `id="${id}" aria-describedby="${assistId}" ${f.optional ? '' : 'aria-required="true"'} ${err ? 'aria-invalid="true"' : ''}`;
    const cls = `control${err ? ' is-invalid' : ''}${v.focus ? ' is-focus' : ''}${v.generated ? ' is-generated' : ''}`;
    let control;
    switch (f.kind) {
      case 'lookup':
        control = `<div class="${cls}" role="combobox" tabindex="0" aria-expanded="false" aria-haspopup="listbox" ${aria}>
          ${v.value ? `<span class="picked"><span class="chip-ico" aria-hidden="true">${v.value[0]}</span><span class="main" lang="en">${v.value[1]}</span><span class="sub">${v.value[2]}</span></span>`
                    : `<span class="placeholder grow">Choose ${f.noun}…</span>`}
          ${slot}<span class="lead">${ico('chevrons-ud', 'i i-sm')}</span></div>`;
        break;
      case 'money':
        control = `<div class="${cls} control-split">
          <span class="part"><input ${aria} class="num" inputmode="decimal" value="${v.value ?? ''}" placeholder="${decimal(0)}">${slot}</span>
          <span class="part" role="button" tabindex="0" aria-label="Currency: ${v.currency}. Change currency">${v.currency}${ico('chevron-down', 'i i-sm faint')}</span></div>`;
        break;
      case 'date':
        control = `<div class="${cls}"><span class="lead">${ico('calendar', 'i i-sm')}</span><input ${aria} value="${v.value ?? ''}" placeholder="${datePattern}" size="${Math.max((v.value || datePattern).length, 8)}">${v.rel ? `<span class="trail">${v.rel}</span>` : ''}${slot}</div>`;
        break;
      case 'enum':
        return `<div class="field${f.half ? ' half' : ''}" role="group" aria-labelledby="${id}-l">
          <span class="label"><span id="${id}-l" lang="en">${f.label}</span>${info}${f.optional ? `<span class="opt">${t('optional')}</span>` : ''}<span class="type">${f.type}</span></span>
          <div class="segmented lg" style="justify-self:start">${f.options.map(o => `<button type="button" aria-pressed="${o === v.value}" lang="en">${o}</button>`).join('')}</div>
          <div class="assist"><span class="msg" lang="en">${f.hint}</span></div></div>`;
      case 'list':
        return `<div class="field" role="group" aria-labelledby="${id}-l">
          <span class="label"><span id="${id}-l" lang="en">${f.label}</span>${info}<span class="opt">${t('optional')}</span><span class="type">${f.type}</span></span>
          <div class="list-input">
            ${(v.items || []).map((it, i) => `<div class="li"><span class="idx" aria-hidden="true">${i + 1}</span><span class="val" lang="en">${it}</span><button type="button" class="btn btn-ghost btn-icon btn-xs" aria-label="Remove line ${i + 1}">${ico('x', 'i i-sm')}</button></div>`).join('')}
            <button type="button" class="add">${ico('plus', 'i i-sm')}Add line${kbd('mod', 'enter')}</button>
          </div>
          <div class="assist"><span class="msg">${t('list.lines')}</span><span class="count">${(v.items || []).length} / 4</span></div></div>`;
      default:
        control = `<div class="${cls}">${f.icon ? `<span class="lead">${ico(f.icon, 'i i-sm')}</span>` : ''}<input ${aria} ${f.mono ? 'class="mono-val"' : ''} value="${v.value ?? ''}" placeholder="${f.placeholder || ''}" ${f.type === 'password' ? 'type="password"' : ''}>${slot}</div>`;
    }
    const count = f.max ? `<span class="count">${(v.value || '').length} / ${f.max}</span>` : '';
    let assist;
    if (err) assist = `<div class="assist is-error" id="${assistId}">${ico('alert', 'i i-sm')}<span class="msg">${err}</span>${count}</div>`;
    else if (v.generated) assist = `<div class="assist is-generated" id="${assistId}" aria-live="polite">${ico('wand', 'i i-sm')}<span class="msg">Generated: ${v.generated}</span><button type="button" class="undo" aria-keyshortcuts="${aks('mod', 'Z')}" title="Undo (${window.i18n.chord('mod', 'Z')})">Undo</button></div>`;
    else assist = `<div class="assist" id="${assistId}"><span class="msg">${v.hint ?? f.hint ?? ''}</span>${count}</div>`;
    return `<div class="field${f.half ? ' half' : ''}" data-field="${f.name}">${label}${control}${assist}</div>`;
  }

  /* ---------- Create order ---------- */
  // The internal names (debit, cp, amount, date, prio, ref, rem) are the form's slots: they key
  // the values below and the ?focus= and ?scrollto= parameters of the screenshot list.
  const createFields = [
    { name: 'debit', kind: 'lookup', label: 'Customer', noun: 'a customer', type: 'uuid' },
    { name: 'cp', kind: 'lookup', label: 'Variant', noun: 'a variant', type: 'uuid' },
    { name: 'amount', kind: 'money', label: 'Unit price', type: 'decimal', half: true },
    { name: 'date', kind: 'date', label: 'Deliver by', type: 'date', half: true },
    { name: 'prio', kind: 'enum', label: 'Shipping method', type: 'enum', optional: true, options: ['Standard', 'Express', 'Same day'], hint: 'Defaults to Standard when omitted.' },
    { name: 'ref', kind: 'text', label: 'Reference', type: 'string', optional: true, max: 35, hint: 'Shown on the invoice.' },
    { name: 'rem', kind: 'list', label: 'Delivery notes', type: 'string[]', optional: true },
  ];
  const lookupHint = (src, id) => `<span class="src">${ico('db', 'i i-sm')}<span>${t('from.get', { src: `<code>GET ${src}</code>`, id: `<code>${id}</code>` })}</span></span>`;
  const valueDate = '2026-11-23';
  const filled = {
    debit: { value: ['P', 'Priya Raman', 'priya.raman@example.com'], hint: lookupHint('/customers', '3f9c…a21e') },
    cp: { value: ['M', 'Merino Crew Sweater, Heather Grey / M', 'APP-MCS-HGR-M'], hint: lookupHint('/variants', '9a1f…c301') },
    amount: { value: decimal(79), currency: 'EUR', hint: t('available', { amount: money(79) }) },
    date: { value: date(valueDate), rel: weekday(valueDate), hint: t('in.days', { n: 3 }) },
    prio: { value: 'Standard' },
    ref: { value: 'PO-2026-1184 / Q4 desk setup' },
    rem: { items: ['Leave with the concierge, flat 4B'] },
  };
  const values = {
    filled,
    running: filled,
    blank: { debit: { hint: `<span class="src">${ico(signedOut ? 'lock' : 'db', 'i i-sm')}<span>${signedOut ? 'Sign in to choose from <code>GET /customers</code>' : 'Options from <code>GET /customers</code>, as Ada Admin sees them'}</span></span>` }, cp: { hint: `<span class="src">${ico('db', 'i i-sm')}<span>Options from <code>GET /variants</code></span></span>` }, amount: { currency: 'EUR', hint: 'At least 0.01. Sent as a JSON number.' }, date: { hint: 'No Sunday delivery for Standard.' }, prio: { value: 'Standard' }, ref: { hint: 'Shown on the invoice.' }, rem: { items: [] } },
    validation: {
      debit: { error: 'Choose a customer', focus: true },
      cp: { error: 'Choose a variant' },
      amount: { value: 'g', currency: 'EUR', error: 'Enter a number, like 79.90' },
      date: { value: '31/02/2026', error: '31 February 2026 doesn’t exist' },
      prio: { value: 'Standard' },
      ref: { value: 'PO-2026-1184 / Q4 desk setup / Harbour', error: 'Use 35 characters or fewer (38 now)' },
      rem: { items: [] },
    },
    // After "Fill required fields" (or one wand click per field): every value says where it came from.
    generated: {
      debit: { value: ['P', 'Priya Raman', 'priya.raman@example.com'], generated: 'a real customer Ada Admin can see' },
      cp: { value: ['W', 'Waxed Canvas Backpack 22L, Olive', 'OUT-WCB-OLI'], generated: 'a real variant, picked at random' },
      amount: { value: decimal(48.17), currency: 'EUR', generated: 'random, in range' },
      date: { value: date('2026-11-24'), rel: weekday('2026-11-24'), generated: 'a working day' },
      prio: { value: 'Standard' }, ref: {}, rem: { items: [] },
    },
  };
  // Field-level wand: one field just regenerated, another with its menu open.
  values.wand = { ...filled, date: { ...filled.date, value: date('2026-11-27'), rel: weekday('2026-11-27'), generated: 'a working day' }, amount: { ...filled.amount, focus: true } };
  values.toggletip = { ...filled };

  function createBody() {
    const key = q.overlay === 'wand' ? 'wand' : st;
    const v = values[key] || filled;
    return `
      <form class="form" novalidate onsubmit="return false">
        <fieldset aria-labelledby="body-legend">
          <div class="section-label"><span id="body-legend">${t('section.body')} <a class="schema-link" href="#" title="Open the CreateOrderRequest model">CreateOrderRequest</a></span><span class="rule" aria-hidden="true"></span>
            <div class="segmented" role="group" aria-label="Body editor" aria-keyshortcuts="${aks('mod', 'E')}"><button type="button" aria-pressed="true">${t('form')}</button><button type="button" aria-pressed="false">${t('json')}</button></div></div>
          <p class="form-note">${t('required.note')}</p>
          <div class="fields">
            ${createFields.map(f => field(f, v[f.name] || {})).join('')}
            <div class="optional-props" role="group" aria-label="Add optional fields">
              <span class="lead-label">${t('add')}</span>
              ${[['channel', 'enum'], ['couponCode', 'string'], ['externalId', 'string']].map(([n, ty]) => `<button type="button" class="prop-chip">${ico('plus', 'i i-sm')}<span class="ltr">${n}</span><span class="t">${ty}</span></button>`).join('')}
            </div>
          </div>
        </fieldset>
      </form>`;
  }

  /* ---------- Sign in with a password ---------- */
  function loginBody() {
    return `<form class="form" novalidate onsubmit="return false"><fieldset>
      <legend class="section-label">${t('section.body')} <a class="schema-link" href="#">LoginRequest</a><span class="rule" aria-hidden="true"></span></legend>
      <div class="fields">
        ${field({ name: 'email', label: 'Email', type: 'email', icon: 'at', placeholder: 'name@example.com', hint: 'A user in store-demo.db, e.g. ada.admin@acme.dev' }, {})}
        ${field({ name: 'password', label: 'Password', type: 'password', hint: 'Seeded users share the password in DemoData.cs' }, {})}
      </div></fieldset></form>`;
  }

  /* ---------- Params (Get order, List orders) ---------- */
  function paramsBody() {
    // The real parameters of List orders and Get order (see mocks/spec.js).
    const list = op === 'list';
    if (!list) return `<form class="form" novalidate onsubmit="return false">
      <fieldset><legend class="section-label">Path<span class="rule" aria-hidden="true"></span></legend><div class="fields">
        ${field({ name: 'pid', kind: 'lookup', label: 'id', noun: 'an order', type: 'uuid' }, { value: ['O', 'ORD-2026-000174 · Harbour Café Ltd', 'd67d058b-465d-470b-b5a0-8280020afe6e'], hint: lookupHint('/api/v2/orders', 'd67d…fe6e') })}
      </div></fieldset>
    </form>`;
    return `<form class="form" novalidate onsubmit="return false">
      <fieldset><legend class="section-label">Filter<span class="rule" aria-hidden="true"></span></legend><div class="fields">
        ${field({ name: 'status', label: 'status', type: 'OrderStatus', optional: true, mono: true, hint: 'Only orders in this status. Pending, Paid, Processing and 6 more' }, { value: 'Processing' })}
        ${field({ name: 'currency', label: 'currency', type: 'Currency', optional: true, mono: true, half: true, hint: 'ISO 4217, such as EUR' }, { value: '' })}
        ${field({ name: 'q', label: 'q', type: 'string · ≤ 100', optional: true, half: true, hint: 'Number, reference, external ID or customer' }, { value: '' })}
      </div></fieldset>
      <fieldset><legend class="section-label">Page and order<span class="rule" aria-hidden="true"></span></legend><div class="fields">
        ${field({ name: 'page', label: 'page', type: 'int32 · ≥ 1', optional: true, mono: true, half: true, hint: 'Defaults to 1' }, { value: '1' })}
        ${field({ name: 'pageSize', label: 'pageSize', type: 'int32 · 1–100', optional: true, mono: true, half: true, hint: 'Defaults to 25' }, { value: '100' })}
        ${field({ name: 'sort', label: 'sort', type: 'enum', optional: true, mono: true, hint: 'A field, with a leading minus for descending. Defaults to -createdAt' }, { value: '-deliverBy' })}
      </div></fieldset>
    </form>`;
  }

  /* ---------- Headers editor ---------- */
  function headersBody() {
    const row = ({ check = 'on', name, val, cls = '', acts = '' }) => `
      <div class="kv-row ${cls}" role="row">
        <div class="c check" role="gridcell">${check === 'locked'
          ? `<span class="checkbox locked" role="img" aria-label="Managed by Sendproof">${ico('lock', 'i')}</span>`
          : `<span class="checkbox ${check === 'on' ? 'on' : ''}" role="checkbox" aria-checked="${check === 'on'}" tabindex="0">${check === 'on' ? ico('check', 'i') : ''}</span>`}</div>
        <div class="c name-c" role="gridcell">${name}</div>
        <div class="c val-c" role="gridcell">${val}</div>
        <div class="c acts" role="gridcell">${acts}</div>
      </div>`;
    const empty = q.hstate === 'empty';
    return `<div class="form"><div>
      <div class="kv-toolbar"><span class="faint" style="font-size:var(--fs-md)">${empty ? '3 headers will be sent, all managed by Sendproof' : q.hstate === 'invalid' ? '5 headers will be sent · 1 needs a fix' : '5 headers will be sent'}</span><span class="spacer"></span>
        <div class="segmented" role="group" aria-label="Headers editor"><button aria-pressed="true">Table</button><button aria-pressed="false">Bulk edit</button></div></div>
      <div class="kv-table" role="grid" aria-label="Request headers">
        <div class="kv-row head" role="row"><div class="c" role="columnheader"><span class="sr-only">Send</span></div><div class="c" role="columnheader">Name</div><div class="c" role="columnheader">Value</div><div class="c" role="columnheader"><span class="sr-only">Actions</span></div></div>
        <div class="kv-row group" role="row"><span role="gridcell">Managed by Sendproof</span></div>
        ${row({ check: 'locked', cls: 'is-managed', name: '<span class="name">Content-Type</span>', val: '<span class="val">application/json</span>' })}
        ${row({ check: 'locked', cls: 'is-managed', name: '<span class="name">Cookie</span>', val: `<span class="val">${signedOut ? '<span class="placeholder">Not signed in</span>' : '.AspNetCore.Cookies=CfDJ8…'}</span>` })}
        ${row({ check: 'locked', cls: 'is-managed', name: '<span class="name">Idempotency-Key</span>', val: '<span class="val">0c5d9a2e-1f4b-4c39-8e0a-b7d2c61f5a08</span>', acts: `<button class="btn btn-ghost btn-icon btn-xs" aria-label="New key" aria-keyshortcuts="${aks('mod', 'I')}">${ico('refresh', 'i i-sm')}</button>` })}
        <div class="kv-row group" role="row"><span role="gridcell">Custom</span></div>
        ${empty ? `<div class="kv-row" role="row" style="display:block"><div role="gridcell">${stateBlock({
          icon: null, compact: true, title: 'No custom headers',
          body: 'Sendproof already sends the three above. Add your own for tracing, locale or tenant.',
          actions: [`<button class="btn btn-sm">${ico('plus', 'i i-sm')}Add header ${kbd('mod', 'enter')}</button>`, `<button class="btn btn-ghost btn-sm">${ico('list', 'i i-sm')}Apply a preset</button>`],
        })}</div></div>` : `
        ${row({ name: '<span class="name">Accept-Language</span>', val: '<span class="val">en-IE</span>' })}
        ${row({ name: '<span class="name">X-Correlation-ID</span>', val: '<span class="val"><span class="var-token">{{uuid}}</span></span>' })}
        ${q.hstate === 'invalid' ? `<div class="kv-row" role="row">
          <div class="c check" role="gridcell"><span class="checkbox on" role="checkbox" aria-checked="true" tabindex="0">${ico('check', 'i')}</span></div>
          <div class="c name-c is-invalid" role="gridcell"><span class="name" aria-invalid="true" aria-describedby="hdr-err">X Trace</span><span style="margin-inline-start:auto;color:var(--danger);display:flex">${ico('alert', 'i i-sm')}</span></div>
          <div class="c val-c" role="gridcell"><span class="val">on</span></div>
          <div class="c acts" role="gridcell"><button class="btn btn-ghost btn-icon btn-xs" aria-label="Remove X Trace">${ico('x', 'i i-sm')}</button></div></div>` : ''}`}
      </div>
      ${q.hstate === 'invalid' ? `<p class="kv-note is-error" id="hdr-err">${ico('alert', 'i i-sm')}Header names can’t contain spaces. Try <code>X-Trace</code>.</p>` : ''}
      <div class="optional-props" role="group" aria-label="Add documented headers" style="margin-block-start:0.875rem">
        <span class="lead-label">From the spec</span>
        <button type="button" class="prop-chip">${ico('plus', 'i i-sm')}<span class="ltr">Accept-Language</span><span class="t">optional</span></button>
        <button type="button" class="prop-chip">${ico('plus', 'i i-sm')}<span class="ltr">X-Correlation-ID</span><span class="t">uuid</span></button>
      </div>
    </div></div>`;
  }

  /* ---------- Auth: what this operation needs, from its security requirements ---------- */
  function authBody() {
    return `<div class="form">
      <section class="auth-req">
        <h3 class="section-label">Security requirements<span class="rule" aria-hidden="true"></span></h3>
        <div class="req-list">
          <div class="req"><span class="req-ico">${ico('lock', 'i i-sm')}</span><div class="grow"><div class="t">Cookie sign-in <span class="tag tag-mono">cookieAuth</span></div><div class="s">Sign in as any user in store-demo.db. Sendproof sends the cookie for you.</div></div>
            ${signedOut ? `<span class="tag tag-warn">Not signed in</span>` : `<span class="tag tag-ok">${ico('check', 'i')}Ada Admin</span>`}</div>
          <div class="req"><span class="req-ico">${ico('shield', 'i i-sm')}</span><div class="grow"><div class="t">Permission <span class="tag tag-mono">support</span></div><div class="s">Checked by the API after sign-in. Without it the call returns 403.</div></div>
            ${signedOut ? `<span class="tag">Unknown until signed in</span>` : `<span class="tag tag-ok">${ico('check', 'i')}Granted</span>`}</div>
        </div>
        ${signedOut ? `<div class="actions" style="display:flex;gap:0.5rem;margin-block-start:1rem"><button class="btn btn-primary">${ico('log-in', 'i i-sm')}Sign in ${kbd('shift', 'mod', 'U')}</button><button class="btn">Use a seeded account…</button></div>` : ''}
      </section>
    </div>`;
  }

  /* ---------- Code: always a snippet, with placeholders for missing values ---------- */
  function codeBody() {
    const incomplete = st === 'blank' || st === 'validation';
    const ph = (name, type) => `<span class="ph" title="Fill ${name} to replace this">&lt;${name}: ${type}&gt;</span>`;
    const s = x => `<span class="tok-s">${x}</span>`;
    const lines = incomplete ? [
      `curl -X POST 'http://127.0.0.1:5189/api/v2/orders' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Idempotency-Key: 0c5d9a2e-1f4b-4c39-8e0a-b7d2c61f5a08' \\`,
      `  -b '.AspNetCore.Cookies=${ph('cookie', 'sign in')}' \\`,
      `  -d '{`,
      `    "customerId": ${ph('customerId', 'uuid')},`,
      `    "variantId": ${ph('variantId', 'uuid')},`,
      `    "unitPrice": ${ph('unitPrice', 'decimal ≥ 0.01')},`,
      `    "currency": ${s('"EUR"')},`,
      `    "deliverBy": ${ph('deliverBy', 'date')},`,
      `    "shippingMethod": ${s('"Standard"')}`,
      `  }'`,
    ] : [
      `curl -X POST 'http://127.0.0.1:5189/api/v2/orders' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Idempotency-Key: 0c5d9a2e-1f4b-4c39-8e0a-b7d2c61f5a08' \\`,
      `  -b '.AspNetCore.Cookies=CfDJ8NrA…' \\`,
      `  -d '{`, `    "customerId": ${s('"3f9c0000-0000-4000-8000-00000000a21e"')},`, `    "variantId": ${s('"9a1f0000-0000-4000-8000-00000000c301"')},`,
      `    "unitPrice": <span class="tok-n">79.00</span>,`, `    "currency": ${s('"EUR"')},`, `    "deliverBy": ${s('"2026-11-23"')},`, `    "shippingMethod": ${s('"Standard"')}`, `  }'`,
    ];
    const failed = q.copied === 'failed';
    return `<div class="form">
      <div class="code-tools">
        <div class="segmented" role="group" aria-label="Language"><button aria-pressed="true">cURL</button><button aria-pressed="false"><span class="ltr">C# HttpClient</span></button><button aria-pressed="false">fetch</button><button aria-pressed="false">PowerShell</button></div>
        <span class="spacer"></span>
        <label class="switch-row"><span class="switch on" role="switch" aria-checked="true"></span>Include cookie</label>
      </div>
      ${incomplete ? `<div class="inline-note">${ico('info', 'i i-sm')}<span><strong>4 required values are missing.</strong> They’re shown as placeholders, so you can still copy the shape of the call.</span><button class="btn btn-ghost btn-xs">Fill required ${kbd('shift', 'mod', 'F')}</button></div>` : ''}
      <div class="viewer">
        <div class="viewer-bar"><span class="faint ltr" style="font-size:var(--fs-sm)">bash · ${incomplete ? 'with placeholders' : 'ready to run'}</span><span class="spacer"></span>
          ${copyTextBtn('Copy', { state: q.copied === 'code' ? 'copied' : 'idle', cls: 'btn-sm btn-ghost' })}</div>
        ${failed ? `<div class="inline-note danger flush" role="alert">${ico('alert', 'i i-sm')}<span><strong>Couldn’t copy.</strong> The browser blocked clipboard access. The snippet is selected: press ${kbd('mod', 'C')}.</span><button class="btn btn-ghost btn-icon btn-xs" aria-label="Dismiss">${ico('x', 'i i-sm')}</button></div>` : ''}
        <pre class="code-block ltr${failed ? ' is-selected' : ''}">${lines.join('\n')}</pre>
      </div>
    </div>`;
  }

  /* ---------- Operation header, tabs and action bar ---------- */
  const ops = {
    create: { group: 'Orders', title: 'Create order', method: 'post', id: 'OrdersController.Create', path: '/api/v2/orders',
      desc: 'Creates a pending order and reserves stock for its lines.', scope: 'support',
      tabs: [['body', 'tab.body'], ['headers', 'tab.headers', q.hstate === 'empty' ? 3 : 5], ['auth', 'tab.auth'], ['code', 'tab.code']] },
    get: { group: 'Orders', title: 'Get order', method: 'get', id: 'OrdersController.Get', path: '/api/v2/orders/<span class="token">' + ico('link', 'i i-sm') + 'id</span>',
      desc: 'Returns one order with its lines and delivery details.', scope: 'cookieAuth',
      tabs: [['params', 'tab.params', 1], ['headers', 'tab.headers', 3], ['auth', 'tab.auth'], ['code', 'tab.code']] },
    list: { group: 'Orders', title: 'List orders', method: 'get', id: 'OrdersController.List', path: '/api/v2/orders',
      desc: 'Lists orders the signed-in user can see, newest first.', scope: 'cookieAuth',
      tabs: [['params', 'tab.params', 13], ['headers', 'tab.headers', 3], ['auth', 'tab.auth'], ['code', 'tab.code']] },
    update: { group: 'Orders', title: 'Update order', method: 'put', id: 'OrdersController.Update', path: '/api/v2/orders/<span class="token">' + ico('link', 'i i-sm') + 'id</span>',
      desc: 'Replaces a pending order.', scope: 'support', deprecated: true,
      tabs: [['body', 'tab.body'], ['params', 'tab.params', 1], ['headers', 'tab.headers', 5], ['auth', 'tab.auth'], ['code', 'tab.code']] },
    login: { group: 'Authentication', title: 'Sign in with a password', method: 'post', id: 'AuthenticationEndpoints.Login', path: '/auth/login',
      desc: 'Signs in and sets the auth cookie for this browser.', public: true,
      tabs: [['body', 'tab.body'], ['headers', 'tab.headers', 1], ['code', 'tab.code']] },
  };
  const o = { ...ops[op] };
  // Titles, descriptions, roles and paths come from the spec snapshot (mocks/spec.js) when it
  // has the operation, so Try it, Docs and the sidebar always agree.
  const real = window.TB.currentOp && window.TB.currentOp(q);
  if (real && real.method === o.method) {
    const S = window.TB.schema;
    Object.assign(o, {
      group: real.tag, title: real.summary, id: real.id,
      desc: S.md(S.firstSentence(real.op.description), { block: false }) || o.desc,
      codes: Object.keys(real.op.responses || {}).join(' · '),
      path: S.esc(real.path).replace(/\{(\w+)\}/g, (_, n) => `<span class="token">${ico('link', 'i i-sm')}${n}</span>`),
      ...(o.public ? {} : { scope: real.roles.length ? real.roles.join(' or ') : 'cookieAuth' }),
      deprecated: real.deprecated || undefined,
    });
  }
  const tabKey = q.tab || o.tabs[0][0];
  const errCount = st === 'validation' ? 5 : 0;
  const readOnly = o.method === 'get';

  const notice = o.deprecated
    ? `<div class="op-notice warn" role="note">${ico('warn', 'i i-sm')}<span class="grow"><strong>Deprecated.</strong> <span lang="en">Use Get stock level or create a new order. Removed in v2.0.</span></span><button class="btn btn-ghost btn-xs">Open Get stock level</button></div>`
    : signedOut && !o.public
      ? `<div class="op-notice auth" role="note">${ico('lock', 'i i-sm')}<span class="grow"><strong>Needs sign-in.</strong> You’re signed out, so this call will return 401.</span><button class="btn btn-sm">${ico('log-in', 'i i-sm')}${t('signIn')}</button></div>`
      : '';

  const statusBar = st === 'validation'
    ? `<span class="status" role="status"><button class="issues-btn" aria-haspopup="dialog" aria-expanded="${q.overlay === 'issues'}" aria-controls="issues" aria-keyshortcuts="Alt+ArrowDown">${ico('alert', 'i i-sm')}5 fields need attention ${kbd('alt', '↓')}</button><span class="desktop-only">Nothing was sent</span></span>`
    : st === 'running' ? `<span class="status" role="status"><span class="spinner" aria-hidden="true" style="color:var(--accent-text)"></span><span>${t('bar.running')}</span></span>`
    : st === 'generated' ? `<span class="status is-ok" role="status">${ico('wand', 'i i-sm')}<span>Filled 4 fields</span><button class="btn btn-ghost btn-xs" aria-keyshortcuts="${aks('mod', 'Z')}">Undo ${kbd('mod', 'Z')}</button></span>`
    : readOnly ? `<span class="status">${ico('eye', 'i i-sm')}<span>GET is read-only: nothing to roll back, so there’s no Preview</span></span>`
    : `<span class="status">${ico('undo', 'i i-sm')}<span>${t('bar.rule')}</span></span>`;

  const sendBtn = `<button class="btn btn-run btn-send${readOnly ? ' btn-primary' : ''}" id="send-btn" aria-keyshortcuts="${aks(...(readOnly ? ['mod', 'enter'] : ['shift', 'mod', 'enter']))}" ${st === 'running' ? 'disabled' : ''}>${ico('send', 'i i-sm')}${t('send')}${readOnly ? kbd('mod', 'enter') : kbd('shift', 'mod', 'enter')}</button>`;
  const previewBtn = readOnly ? '' : `<button class="btn btn-primary btn-run btn-preview" aria-keyshortcuts="${aks('mod', 'enter')}" ${st === 'running' ? 'aria-busy="true"' : ''}>${st === 'running' ? '<span class="spinner" aria-hidden="true"></span>' : ico('flask', 'i i-sm')}${t('preview')}${kbd('mod', 'enter')}</button>`;

  // Autofill applies to every tab with inputs; its label hides in a narrow pane (icon + tooltip).
  const right = ['body', 'params'].includes(tabKey) && op !== 'login' ? `<div class="end">
      <button class="btn btn-ghost btn-sm" id="autofill" aria-label="${t('autofill')}" aria-haspopup="menu" aria-keyshortcuts="${aks('shift', 'mod', 'F')}">${ico('wand', 'i i-sm')}<span class="lbl">${t('autofill')}</span>${ico('chevron-down', 'i i-sm')}</button>
    </div>` : '';

  const body = { body: op === 'login' ? loginBody : createBody, params: paramsBody, headers: headersBody, auth: authBody, code: codeBody }[tabKey];

  return `
  <main class="pane request" id="request" aria-labelledby="op-title">
    ${window.TB.ctxBar ? window.TB.ctxBar(q, 'op', 'try') : ''}
    <div class="pane-scroll">
      <div class="op-head">
        <div class="op-title-row"><h1 class="op-title" id="op-title" lang="en">${o.title}</h1></div>
        <p class="op-desc" lang="en">${o.desc}</p>
        <div class="op-meta">
          ${o.public ? `<span class="pill">${ico('globe', 'i i-sm')}Public</span>` : `<span class="pill">${ico(signedOut ? 'lock' : 'shield', 'i i-sm')}<span class="ltr">${o.scope}</span></span>`}
          ${op === 'create' ? `<span class="pill">Idempotent</span><span class="pill">${o.codes || '201 · 400 · 401 · 403 · 409'}</span>` : ''}
        </div>
        ${notice}
        <div class="urlbar">
          <span class="method m-${o.method}">${o.method.toUpperCase()}</span>
          <span class="url"><span class="base">http://127.0.0.1:5189</span>${o.path}</span>
          ${copyBtn(t('pick.copy'), { state: q.copied === 'url' ? 'copied' : 'idle', size: 'btn-xs', keys: aks('shift', 'mod', 'U') })}
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="Request">
        ${o.tabs.map(([k, key, n], i) => tab(t(key), {
          selected: k === tabKey, count: n, keys: `Alt+${i + 1}`,
          flag: k === 'body' && errCount ? `${errCount} fields need attention` : undefined,
        })).join('')}
        ${right}
      </div>
      ${body()}
    </div>
    <div class="actionbar">${statusBar}${sendBtn}${previewBtn}</div>
    <div class="sr-only" aria-live="polite" id="announcer">${q.copied === 'url' ? 'URL copied' : q.copied === 'code' ? 'Snippet copied' : ''}</div>
  </main>`;
  }
  window.TB.buildRequest = build;
  const host = document.querySelector('[data-shell="request"]');
  const q0 = window.TB.q;
  if (host && !['docs', 'model', 'overview'].includes(q0.view)) host.outerHTML = build(q0);
})();

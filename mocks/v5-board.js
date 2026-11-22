// v5 state boards (controls.html?v5=1&set=…). Every cell is built by the functions that render
// the screens (TB.v5.field, TB.v5.listbox, TB.v5.lookupPop), so a board can't drift from them.
//   set=controls  radio group, select, ID lookup and text input in every state
//   set=anatomy   the field anatomy, every field type on it, and the owner's before/after
//   set=lookup    the ID lookup popover: loaded, loading, empty, error and signed out
(function () {
  const { q, ico, t } = window.TB;
  const S = window.TB.schema;
  const V = window.TB.v5;
  const { num, decimal, date, weekday } = window.i18n;
  const list = S.operations.find(o => o.id === 'CustomersController.List').op.parameters;
  const getId = S.operations.find(o => o.id === 'CustomersController.Get').op.parameters[0];
  const P = name => list.find(p => p.name === name);
  const acct = window.TB_SAMPLES.customersPage.items[0];
  const picked = [acct.name[0], acct.name, acct.email];

  /** A field from a parameter with state overrides; names are suffixed so ids stay unique. */
  let n = 0;
  const from = (p, over = {}) => { const f = V.fromParam(p, {}); return V.field({ ...f, name: `${f.name}-${++n}`, ...over }); };
  const status = o => from(P('status'), o);
  const type = o => from(P('segment'), o);
  const lookup = o => from(getId, { status: t('v5.lookup.count', { n: num(25), who: 'Ada Admin' }), ...o });
  const text = o => from(P('q'), o);
  const sent = v => t('v5.sendsValue', { v: `<code>${v}</code>` });

  const rows = [
    ['Rest', 'Optional and unset: nothing is sent', [status(), type(), lookup(), text()]],
    ['Hover', 'Pointer over the control', [status({ hoverOn: 'Suspended' }), type({ state: 'hover' }), lookup({ state: 'hover' }), text({ state: 'hover' })]],
    ['Focus', 'Keyboard focus: a 2 px ring, 3:1 against both themes', [status({ state: 'focus' }), type({ state: 'focus' }), lookup({ state: 'focus' }), text({ state: 'focus', status: '' })]],
    ['Selected', 'A value is set; optional fields offer Clear in the label row', [status({ value: 'Suspended', status: sent('status=Suspended') }), type({ value: 'Wholesale', status: sent('segment=Wholesale') }),
      lookup({ picked, status: t('v5.sends', { id: `<code>${acct.id.slice(0, 8)}…${acct.id.slice(-4)}</code>` }) }), text({ value: 'Dublin', count: `${num(6)} / ${num(100)}`, status: t('v5.upTo', { n: num(100) }) })]],
    ['Generated', 'From the wand or Autofill, with Undo', [status({ value: 'Closed', generated: t('v5.gen.enum') }), type({ value: 'Student', generated: t('v5.gen.enum') }), lookup({ picked, generated: t('v5.gen.lookup') }), text({ value: 'Harbour', generated: 'a word from the data' })]],
    ['Error', 'Required, or out of range: the status line turns into the message', [status({ optional: false, error: t('v5.err.choose') }), type({ optional: false, error: 'Choose a segment', placeholder: t('v5.choose') }),
      lookup({ error: t('v5.err.lookup') }), text({ value: 'Harbour Café Ltd, the café group that orders in bulk for its three Galway sites…', error: t('v5.err.long', { n: num(100), now: num(104) }), count: `${num(104)} / ${num(100)}` })]],
    ['Disabled', 'Read-only operation or a locked field: value visible, not editable', [status({ value: 'Active', state: 'disabled', status: '' }), type({ value: 'Business', state: 'disabled', status: '' }), lookup({ picked, state: 'disabled', status: '' }), text({ value: 'Dublin', state: 'disabled', status: '' })]],
  ];

  const typeF = { ...V.fromParam(P('segment'), {}), name: 'type-open', value: 'Wholesale' };
  const sortF = { ...V.fromParam(P('sort'), {}), name: 'sort-open' };
  const curF = { ...V.fromParam(P('currency'), {}), name: 'cur-open', value: 'EUR' };
  const open = [
    ['Select open', 'Listbox with the value’s description, a check on the chosen value and “Any” to clear', V.field({ ...typeF, state: 'open' }) + V.listbox(typeF, { active: 'Staff' })],
    ['Type-ahead', 'Typing “-s” on the closed or open select jumps to “-spend”', V.field({ ...sortF, state: 'open' }) + V.listbox(sortF, { active: '-spend', typed: '-s' })],
    ['Long list', 'More than 8 values: a search box that matches values and descriptions', V.field({ ...curF, state: 'open' }) + V.listbox(curF, { search: 'kr', active: 'SEK' })],
    ['ID lookup open', 'Options from the list endpoint; the source moves into the popover', V.field({ ...V.fromParam(getId, {}), name: 'id-open', state: 'open', picked }) + V.lookupPop('id-open', 'ok', acct.name)],
  ];

  // When an enum is a radio group, and when it's a select.
  const enumOf = (name, label, opt = {}) => {
    const s = S.schemas[name];
    const en = V.enumOf(s);
    return V.field({ name: `${name}-${++n}`, label, type: name, kind: V.useRadio(en.values) ? 'radio' : 'select', optional: true, options: en.values.map(v => ({ v, d: en.desc[v] })), desc: S.md(s.description, { block: false }), status: t('v5.notSent'), placeholder: t('v5.any'), ...opt });
  };
  const choose = [
    ['Up to 4 short values', 'A radio group: every choice visible, one click', enumOf('CustomerStatus', 'status', { value: 'Active', status: sent('status=Active') })],
    ['Values that don’t fit', 'Radio options wrap to a second line in a narrow pane, never truncate', `<div style="max-inline-size:17rem">${enumOf('ShippingMethod', 'shippingMethod', { value: 'Same day', status: sent('shippingMethod=Same day') })}</div>`],
    ['5 to 8 values', 'A select with descriptions', enumOf('CustomerSegment', 'segment')],
    ['More than 8 values', 'A select with search (OrderStatus, Currency)', enumOf('OrderStatus', 'status', { value: 'Processing', status: sent('status=Processing') })],
  ];

  const boards = {
    controls: () => `
      <div class="board-head"><h1>v5 form controls in every state</h1><p>Each cell is a whole field: label row, control, description and the reserved status line. The rows line up across columns because nothing changes height between states.</p></div>
      <div class="cb5" role="table" aria-label="Control states">
        <div class="cb5-row cb5-h" role="row"><span role="columnheader">State</span><span role="columnheader">Radio group · <code>status</code></span><span role="columnheader">Select · <code>type</code></span><span role="columnheader">ID lookup · <code>id</code></span><span role="columnheader">Text · <code>q</code></span></div>
        ${rows.map(([name, note, cells]) => `<div class="cb5-row" role="row"><div class="cb5-state" role="rowheader"><strong>${name}</strong><span>${note}</span></div>${cells.map(c => `<div class="cb5-cell" role="cell">${c}</div>`).join('')}</div>`).join('')}
      </div>
      <h2 class="cb5-h2">Open</h2>
      <div class="cb5-open">${open.map(([name, note, html]) => `<figure class="frame cb5-frame"><figcaption class="frame-cap"><strong>${name}</strong><span>· ${note}</span></figcaption><div class="cb5-pad">${html}</div></figure>`).join('')}</div>
      <h2 class="cb5-h2">Radio group or select</h2>
      <div class="cb5-open">${choose.map(([name, note, html]) => `<figure class="frame cb5-frame"><figcaption class="frame-cap"><strong>${name}</strong><span>· ${note}</span></figcaption><div class="cb5-pad">${html}</div></figure>`).join('')}</div>`,

    anatomy: () => {
      const parts = [['Label row', 'Name, the “i” toggletip, “optional”. At the end: Clear (optional fields with a value) and the type.'],
        ['Control', '36 px (44 px on touch). The select’s trigger is a joined segment behind a divider.'],
        ['Description', 'From the spec, flush with the control. As many lines as it needs; it never shares a line.'],
        ['Status line', 'One reserved line: constraints, what gets sent, or the error. The lookup source moved into the popover.']];
      const demo = V.field({ ...V.fromParam(getId, {}), name: 'demo', picked, status: t('v5.sends', { id: `<code>${acct.id.slice(0, 8)}…${acct.id.slice(-4)}</code>` }) });
      const body = S.schemas.CreateOrderRequest.properties;
      const md = s => S.md(s, { block: false });
      const every = [
        V.field({ name: 'a1', kind: 'text', label: 'reference', type: 'string', optional: true, desc: md(body.reference.description), value: 'PO-2026-1184 / Q4 desk setup', count: `${num(28)} / ${num(35)}` }),
        V.field({ name: 'a2', kind: 'number', label: 'pageSize', type: 'int32', optional: true, mono: true, half: true, desc: 'How many customers to return per page, from 1 to 100.', placeholder: '25', status: `${t('v5.between', { min: 1, max: 100 })} · ${t('v5.defaultIs', { v: '<code>25</code>' })}` }),
        V.field({ name: 'a3', kind: 'number', label: 'page', type: 'int32', optional: true, mono: true, half: true, desc: 'The 1-based page number.', placeholder: '1', status: `${t('v5.atLeast', { min: 1 })} · ${t('v5.defaultIs', { v: '<code>1</code>' })}` }),
        V.field({ name: 'a4', kind: 'money', label: 'Unit price', type: 'decimal', half: true, desc: md(body.unitPrice.description), value: decimal(79), currency: 'EUR', status: `${t('v5.atLeast', { min: decimal(0.01) })}` }),
        V.field({ name: 'a5', kind: 'date', label: 'Deliver by', type: 'date', half: true, desc: md(body.deliverBy.description), value: date('2026-11-23'), trail: weekday('2026-11-23'), status: t('v5.inDays', { n: 2 }) }),
        V.field({ name: 'a6', kind: 'radio', label: 'shippingMethod', type: 'enum', optional: true, desc: md(body.shippingMethod.description), value: 'Standard', options: V.enumOf(body.shippingMethod).values.map(v => ({ v })), status: sent('"Standard"') }),
        V.field({ name: 'a7', kind: 'select', label: 'currency', type: 'Currency', desc: md(body.currency.description), value: 'EUR', status: sent('"EUR"') }),
        V.field({ name: 'a8', kind: 'list', label: 'deliveryNotes', type: 'string[]', optional: true, desc: md(S.schemas.CreateOrderRequest.properties.deliveryNotes.description), items: ['Leave with the concierge, flat 4B'], status: 'Up to 4 lines of 140 characters', count: `${num(1)} / ${num(4)}` }),
        V.field({ name: 'a9', kind: 'password', label: 'password', type: 'password', desc: 'Seeded users share the password in <code>DemoData.cs</code>.', value: 'hunter2hunter2', status: '' }),
      ];
      return `
      <div class="board-head"><h1>v5 field anatomy</h1><p>One anatomy for every field type. Descriptions and status lines are separate lines, aligned to the control’s start edge, so text never runs together and icons never sit between sentences.</p></div>
      <div class="an5" style="grid-template-columns:minmax(0,46rem)">
        <figure class="frame"><figcaption class="frame-cap"><strong>The four parts</strong><span>· the source is in the lookup’s popover</span></figcaption>
          <div class="cb5-pad an5-map">${demo.replace('class="f5"', 'class="f5 an5-field"')}${parts.map(([h, d], i) => `<div class="an5-note" style="grid-row:${i + 1}"><strong>${h}</strong><span>${d}</span></div>`).join('')}</div></figure>
      </div>
      <h2 class="cb5-h2">Every field type, on one grid</h2>
      <figure class="frame"><figcaption class="frame-cap"><strong>Form</strong><span>· two fields in a row share a subgrid, so labels, controls, descriptions and status lines line up whatever the description’s length</span></figcaption>
        <div class="cb5-pad an5-form"><div class="fields f5s">${every.join('')}</div></div></figure>`;
    },

    lookup: () => {
      const f = st => V.field({ ...V.fromParam(getId, {}), name: `lk-${st}`, state: 'open', status: st === 'signedout' ? t('v5.lookup.signedOut') : '' }) + V.lookupPop(`lk-${st}`, st);
      const frames = [['Loaded', 'last response first, then every customer; paste or a random UUID at the end', 'ok'], ['Loading', 'skeleton rows in the same shape; paste works meanwhile', 'loading'],
        ['Empty', 'what happened and what to do', 'empty'], ['Error', 'the request that failed, Retry, and paste still works', 'error'], ['Signed out', 'why it’s empty and how to fix it', 'signedout']];
      return `
      <div class="board-head"><h1>v5 ID lookup: every state of the popover</h1><p>Options come from <code>GET /api/v2/customers?pageSize=100</code> (the parameter’s <code>x-lookup</code>). The source and its state live in the popover footer, so the field below the control only says what will be sent.</p></div>
      <div class="cb5-open is-3">${frames.map(([name, note, st]) => `<figure class="frame cb5-frame"><figcaption class="frame-cap"><strong>${name}</strong><span>· ${note}</span></figcaption><div class="cb5-pad">${f(st)}</div></figure>`).join('')}</div>`;
    },
  };

  document.getElementById('board').outerHTML = `<main class="board board5" aria-label="v5 board">${(boards[q.set] || boards.controls)()}</main>`;
})();

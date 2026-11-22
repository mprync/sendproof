// Overlays for the v3 mocks, chosen with ?overlay=. Each is anchored to the control that
// opens it, lists its shortcuts, and closes with Esc.
//   display | toggletip (focus=<field>) | wand (focus=<field>) | issues | send-tip | history
(function () {
  const { q, ico, kbd, t } = window.TB;
  const { decimal } = window.i18n;
  // Mock-only: bring a field into view before anchoring an overlay to it.
  if (q.scrollto) {
    const f = document.querySelector(`[data-field="${q.scrollto}"]`), sc = document.querySelector('.request .pane-scroll');
    // Desktop keeps the section heading in view; mobile brings the field near the top.
    const target = innerWidth > 900 ? document.querySelector('.request .form') : f;
    if (f && sc && target) sc.scrollTop = target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (innerWidth > 900 ? 0 : 16);
  }
  const kind = q.overlay;
  if (!kind) return;

  /** Places a popover below (or above) an anchor, in page coordinates. */
  function place(anchorSel, html, { above = false, align = 'start', gap = 6, arrow } = {}) {
    const anchor = document.querySelector(anchorSel);
    if (!anchor) return;
    document.body.insertAdjacentHTML('beforeend', html);
    const pop = document.body.lastElementChild;
    pop.style.position = 'fixed';
    const a = anchor.getBoundingClientRect(), w = pop.offsetWidth, vw = innerWidth;
    let left = align === 'end' ? a.right - w : align === 'center' ? a.left + a.width / 2 - w / 2 : a.left;
    left = Math.max(12, Math.min(left, vw - w - 12));
    pop.style.left = left + 'px';
    // Flip above the anchor when there isn't room below, like the product's positioning.
    if (!above && a.bottom + gap + pop.offsetHeight > innerHeight - 12 && a.top - gap - pop.offsetHeight > 12) { above = true; pop.classList.add('is-above'); }
    if (above) pop.style.bottom = (innerHeight - a.top + gap) + 'px';
    else pop.style.top = (a.bottom + gap) + 'px';
    if (arrow) pop.style.setProperty('--arrow', (a.left + a.width / 2 - left - 6) + 'px');
  }

  if (kind === 'display') place('#display-btn', `
    <div class="pop settings" role="dialog" aria-labelledby="disp-title">
      <div class="pop-head"><span id="disp-title">${t('display')}</span><span class="spacer"></span>${kbd('mod', ',')}</div>
      <div class="row">
        <div class="row-h">Density<span class="faint">Sizes only; layout stays the same</span></div>
        <div class="segmented" role="radiogroup" aria-label="Density"><button role="radio" aria-checked="false">Compact</button><button role="radio" aria-checked="true">Default</button><button role="radio" aria-checked="false">Comfortable</button></div>
        <p class="note">Default: 14 px text, 36 px controls. Compact: 13 px, 32 px. Comfortable: 15 px, 40 px.</p>
      </div>
      <div class="row">
        <div class="row-h">Theme</div>
        <div class="segmented" role="radiogroup" aria-label="Theme"><button role="radio" aria-checked="true">${ico('monitor', 'i i-sm')}System</button><button role="radio" aria-checked="false">${ico('sun', 'i i-sm')}Light</button><button role="radio" aria-checked="false">${ico('moon', 'i i-sm')}Dark</button></div>
      </div>
      <div class="row">
        <div class="row-h">Text size<span class="faint">100%</span></div>
        <p class="note">Follows your browser zoom and your system text size; every size is in rem. Zoom with ${kbd('mod', '+')} and ${kbd('mod', '−')}.</p>
      </div>
      <div class="row">
        <div class="row-h">Language<span class="faint">Numbers and dates follow it</span></div>
        <button class="btn btn-sm" style="justify-content:space-between"><span>${{ en: 'English (Ireland)', de: 'Deutsch (Deutschland)', ar: 'العربية' }[window.i18n.lang]} · <bdi>${decimal(1250)}</bdi> · <bdi>${window.i18n.date('2026-11-23')}</bdi></span>${ico('chevrons-ud', 'i i-sm')}</button>
      </div>
      ${window.i18n.lang === 'ar' ? `<div class="row">
        <div class="row-h">Digits</div>
        <div class="segmented" role="radiogroup" aria-label="Digits"><button role="radio" aria-checked="${window.i18n.digits === 'latn'}">Latin <bdi>123</bdi></button><button role="radio" aria-checked="${window.i18n.digits === 'arab'}">Arabic-Indic <bdi>١٢٣</bdi></button></div>
        <p class="note">Only Sendproof's own numbers and dates. Captured data is shown exactly as stored.</p>
      </div>` : ''}
    </div>`, { align: 'end' });

  if (kind === 'toggletip') place(`[data-field="${q.focus}"] .info-btn`, `
    <div class="pop toggletip" id="tip" role="dialog" aria-label="About Unit price">
      <div class="tt-body">
        <h3 lang="en">Unit price<span class="tag tag-warn">required</span></h3>
        <p lang="en">Price per unit in the order currency, with up to 2 decimals. Support agents can override the catalog price; stock is reserved when the order is created.</p>
        <dl class="facts">
          <dt>Type</dt><dd>number · decimal</dd>
          <dt>Minimum</dt><dd>0.01</dd>
          <dt>Currency</dt><dd class="plain">From <code>currency</code>: EUR or USD</dd>
          <dt>Example</dt><dd>79.00</dd>
          <dt>Sent as</dt><dd class="plain">A JSON number, e.g. <code>"unitPrice": 79.00</code></dd>
        </dl>
      </div>
      <div class="tt-foot"><a class="link" href="#">Open in Docs</a><span class="ltr faint">CreateOrderRequest.unitPrice</span><span class="spacer"></span>${kbd('Esc')}</div>
    </div>`, { gap: 10, arrow: true });

  if (kind === 'wand') {
    const row = (main, sub, k, active) => `<div class="opt-row${active ? ' is-active' : ''}" role="menuitem"><span class="stack"><span class="main num">${main}</span><span class="sub">${sub}</span></span>${k ? `<span class="end">${k}</span>` : ''}</div>`;
    place(`[data-field="${q.focus}"] .control`, `
      <div class="pop gen-menu" id="gen-menu" role="menu" aria-label="Generate a value for Unit price">
        <div class="pop-group">
          <div class="pop-label">Valid · within 0.01 and up to 2 decimals</div>
          ${row(decimal(48.17), 'Random', kbd('alt', 'G'), true)}
          ${row(decimal(0.01), 'Minimum allowed')}
          ${row(decimal(100), 'Round number')}
        </div>
        <div class="pop-group">
          <div class="pop-label">${ico('alert', 'i i-sm')}Invalid · to test the API’s errors</div>
          ${row(decimal(0), 'Below the minimum')}
          ${row('10.005', 'Too many decimals')}
          ${row('abc', 'Not a number')}
        </div>
        <div class="pop-foot"><span>${kbd('↑↓')} pick</span><span>${kbd('↵')} use</span><span class="spacer"></span><span>${kbd('Esc')}</span></div>
      </div>`, { align: 'start' });
  }

  if (kind === 'issues') {
    const issues = [
      ['Customer', 'Choose a customer'], ['Variant', 'Choose a variant'], ['Unit price', 'Enter a number, like 79.90'],
      ['Deliver by', '31 February 2026 doesn’t exist'], ['Reference', 'Use 35 characters or fewer (38 now)'],
    ];
    place('.issues-btn', `
      <div class="pop" id="issues" role="dialog" aria-labelledby="issues-title" style="inline-size:28rem">
        <div class="pop-head"><span id="issues-title">5 fields need attention</span><span class="spacer"></span><span class="faint" style="font-weight:400;font-size:var(--fs-sm)">Nothing was sent</span></div>
        <div class="pop-group">${issues.map(([n, why], i) => `<a class="issue-link${i ? '' : ' is-active'}" href="#"><span class="ico">${ico('alert', 'i i-sm')}</span><span class="name" lang="en">${n}</span><span class="why">${why}</span></a>`).join('')}</div>
        <div class="pop-foot"><span>${kbd('alt', '↓')} next</span><span>${kbd('alt', '↑')} previous</span><span class="spacer"></span><span>${kbd('Esc')}</span></div>
      </div>`, { above: true });
  }

  if (kind === 'send-tip') {
    document.querySelector('#send-btn')?.style.setProperty('background', 'var(--hover)');
    place('#send-btn', `
      <div class="tooltip" role="tooltip">
        <div class="row"><strong>Send and commit</strong><kbd class="kbd">${window.i18n.chordLong('shift', 'mod', 'enter')}</kbd></div>
        <div class="sub">Runs for real. Changes are saved and side effects run.</div>
      </div>`, { above: true, align: 'center', gap: 8 });
  }

  if (kind === 'history') place('#history-btn', `
    <div class="pop hist-pop" role="dialog" aria-label="History">
      <div class="pop-head">${t('history')}<span class="spacer"></span>${kbd('mod', 'Y')}</div>
      ${window.TB.state({ icon: 'history', compact: true, title: 'No requests yet',
        body: 'Every Preview and Send lands here with its inputs and result, so you can run it again or compare two runs.',
        why: 'History stays in this browser. It’s never sent to the API.' })}
    </div>`, { align: 'end' });

  // Carried over from v2: Autofill menu, ID lookup, shortcut sheet and command palette.
  if (kind === 'autofill') {
    const items = [
      ['wand', 'Fill required fields', 'Real records for IDs, random values within each schema', kbd('shift', 'mod', 'F'), true],
      ['list', 'Fill every field', 'Includes the 3 optional fields', kbd('alt', 'shift', 'mod', 'F')],
      ['history', 'Reuse last request', 'Create order · 2 min ago', kbd('mod', 'R')],
      ['refresh', 'New IDs and keys', 'Regenerates Idempotency-Key and externalId', kbd('mod', 'I')],
    ];
    place('#autofill', `
      <div class="pop" role="menu" aria-label="Autofill" style="inline-size:22rem">
        <div class="pop-group">${items.map(([i, title, sub, k, active]) => `<div class="opt-row${active ? ' is-active' : ''}" role="menuitem">${ico(i, 'i i-sm')}<span class="stack"><span class="main">${title}</span><span class="sub">${sub}</span></span><span class="end">${k}</span></div>`).join('')}</div>
        <div class="pop-group"><div class="opt-row" role="menuitem">${ico('trash', 'i i-sm')}<span class="stack"><span class="main" style="font-weight:400">Clear form</span></span><span class="end">${kbd('shift', 'mod', '⌫')}</span></div></div>
        <div class="pop-foot">${ico('db', 'i i-sm')}<span>IDs are real records Ada Admin can see, from the API’s own list endpoints.</span></div>
      </div>`, { align: 'end' });
  }

  if (kind === 'lookup') {
    const opt = (main, sub, active) => `<div class="opt-row${active ? ' is-active' : ''}" role="option" aria-selected="${!!active}"><span class="chip-ico" aria-hidden="true">${main[0]}</span><span class="stack"><span class="main">${main}</span><span class="sub ltr">${sub}</span></span></div>`;
    place('[data-field="pid"] .control', `
      <div class="pop" id="pid-list" role="listbox" aria-label="Orders" style="inline-size:var(--anchor-w)">
        <div class="pop-group"><div class="pop-label">${ico('history', 'i i-sm')}From your last request<span class="spacer"></span>Create order · 2 min ago</div>
          ${opt('Priya Raman · €142.20', '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13', true)}</div>
        <div class="pop-group"><div class="pop-label">${ico('db', 'i i-sm')}<code>GET /api/v2/orders</code><span class="spacer"></span>3 of 24</div>
          ${opt('Harbour Café Ltd · €318.00', '1b9a77c2-0d4e-4c11-9a6f-2e8d5c3b7a90')}${opt('Northfield Outfitters · £1,240.50', 'a4c0e5d1-7b2f-4f38-8e1c-9d6b0a2c4e57')}</div>
        <div class="pop-group"><div class="opt-row" role="option" aria-selected="false">${ico('copy', 'i i-sm')}<span class="stack"><span class="main" style="font-weight:400">Paste an ID</span></span><span class="end">${kbd('mod', 'V')}</span></div>
          <div class="opt-row" role="option" aria-selected="false">${ico('refresh', 'i i-sm')}<span class="stack"><span class="main" style="font-weight:400">Random UUID</span><span class="sub">Tests a 404</span></span><span class="end">${kbd('mod', 'I')}</span></div></div>
        <div class="pop-foot"><span>${kbd('↑↓')} move</span><span>${kbd('↵')} pick</span><span>${kbd('mod', 'enter')} pick and preview</span><span class="spacer"></span><span>${kbd('Esc')}</span></div>
      </div>`, { align: 'start' });
    const a = document.querySelector('[data-field="pid"] .control'), pop = document.getElementById('pid-list');
    if (a && pop) pop.style.inlineSize = a.getBoundingClientRect().width + 'px';
  }

  if (kind === 'shortcuts') {
    const L = window.i18n.chordLong;
    const groups = [
      ['General', [['Search or run a command', kbd('mod', 'K')], ['Keyboard shortcuts', kbd('?')], ['Display settings', kbd('mod', ',')], ['Toggle sidebar', kbd('mod', '\\')], ['Toggle theme', kbd('shift', 'mod', 'L')], ['History', kbd('mod', 'Y')], ['Switch user', kbd('shift', 'mod', 'U')]]],
      ['Navigate', [['Filter operations', kbd('/')], ['Next / previous operation', kbd('J') + '<span class="then">/</span>' + kbd('K')], ['Sidebar tabs', kbd('G') + '<span class="then">then</span>' + kbd('O') + '<span class="then">/</span>' + kbd('M')], ['Try it ⇄ Docs', kbd('D')], ['Request tabs', kbd('alt', '1–5')], ['Result tabs', kbd('shift', 'alt', '1–5')], ['Back to the previous model', kbd('alt', '←')]]],
      ['Request', [['Preview (rolls back)', kbd('mod', 'enter')], ['Send (commits)', kbd('shift', 'mod', 'enter')], ['Fill required fields', kbd('shift', 'mod', 'F')], ['Form ⇄ JSON', kbd('mod', 'E')], ['Next field with an error', kbd('alt', '↓')], ['Copy URL', kbd('alt', 'mod', 'U')]]],
      ['Fields', [['Generate a value', kbd('alt', 'G')], ['Generate menu', kbd('alt', 'shift', 'G')], ['About this field', kbd('alt', 'I')], ['Open a lookup', kbd('alt', '↓')], ['New ID or key in field', kbd('mod', 'I')], ['Undo generated values', kbd('mod', 'Z')]]],
      ['Headers & lists', [['Add a row', kbd('mod', 'enter')], ['Remove empty row', kbd('⌫')], ['Toggle row on or off', kbd('mod', '/')], ['Bulk edit', kbd('shift', 'mod', 'B')]]],
      ['Result', [['Copy as cURL', kbd('shift', 'mod', 'C')], ['Copy response body', kbd('alt', 'mod', 'C')], ['Open in a follow-up request', kbd('mod', 'G')], ['Next / previous change', kbd('N') + '<span class="then">/</span>' + kbd('P')], ['Cancel a running call', kbd('Esc')]]],
    ];
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sc-title">
        <div class="dialog-head"><h2 id="sc-title">Keyboard shortcuts</h2>
          <label class="input-sm">${ico('search', 'i i-sm')}<span class="sr-only">Search shortcuts</span><input placeholder="Search shortcuts"></label>
          <span class="spacer"></span><span class="faint desktop-only" style="font-size:var(--fs-sm)">Tooltips show the long form, like ${L('shift', 'mod', 'enter')}</span>
          <button class="btn btn-ghost btn-icon btn-sm" aria-label="Close">${ico('x', 'i i-sm')}</button></div>
        <div class="dialog-body">${groups.map(([g, rows]) => `<section class="sc-group" aria-label="${g}"><h3>${g}</h3>${rows.map(([label, k]) => `<div class="sc-row"><span>${label}</span><span class="sc-keys">${k}</span></div>`).join('')}</section>`).join('')}</div>
      </div></div>`);
  }

  if (kind === 'palette') {
    const row = (glyph, main, sub, k, active) => `<div class="opt-row${active ? ' is-active' : ''}" role="option" aria-selected="${!!active}">${glyph}<span class="stack"><span class="main" style="font-weight:${active ? 500 : 400}">${main}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>${k ? `<span class="end">${k}</span>` : ''}</div>`;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scrim palette-scrim"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="pop-search">${ico('search')}<input value="head" aria-label="Search operations and commands" role="combobox" aria-expanded="true" aria-controls="cmd-list"><span class="scope">Create order</span></div>
        <div class="pal-list" id="cmd-list" role="listbox" aria-label="Results">
          <div class="pop-label">Actions on this request</div>
          ${row(ico('plus', 'i i-sm'), 'Add <mark>head</mark>er', '', kbd('shift', 'mod', 'H'), true)}
          ${row(ico('list', 'i i-sm'), 'Go to <mark>Head</mark>ers tab', '', kbd('alt', '2'))}
          ${row(ico('list', 'i i-sm'), 'Bulk edit <mark>head</mark>ers', '', kbd('shift', 'mod', 'B'))}
          <div class="pop-label">Operations</div>
          ${row('<span class="method m-get">GET</span>', 'Get statement <mark>head</mark>er', 'Bank statements')}
          <div class="pop-label">Result</div>
          ${row(ico('eye', 'i i-sm'), 'Show response <mark>head</mark>ers', '', kbd('shift', 'alt', '5'))}
        </div>
        <div class="pop-foot"><span>${kbd('↑↓')} move</span><span>${kbd('↵')} run</span><span>${kbd('Tab')} narrow to scope</span><span class="spacer"></span><span>${kbd('?')} all shortcuts</span></div>
      </div>`);
  }
})();

// Shared chrome for the v3 mocks: icons, small builders (kbd, tab, copy button, state),
// the top bar and the sidebar. In the product all of it is generated from openapi.json.
//
// URL parameters (read once here, exposed as TB.q):
//   theme=dark  text=130 (root font size, %)  density=compact|comfortable  lang=en|de|ar
//   auth=out    view=try|docs|model|signin     op=create|get|list|update|login
//   side=operations|models  filter=nomatch|empty  model=Order|Product
(function () {
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const { t, chord } = window.i18n;

  if (q.theme) document.documentElement.dataset.theme = q.theme;
  if (q.density) document.documentElement.dataset.density = q.density;
  if (q.text) document.documentElement.style.fontSize = q.text + '%';

  /* ---------- Icons ---------- */
  const paths = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    'chevrons-ud': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    flask: '<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/>',
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 16h.01"/>',
    warn: '<path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    // The Sendproof mark (docs/images/logo): a faint preview dart behind the solid send dart.
    mark: '<g fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M1.5 5 7.57 8.15 9.11 12 7.57 15.85 1.5 19 4.3 12z" style="opacity:var(--mark-ghost,.4)"/><path d="M9 5 22.5 12 9 19 11.8 12z"/></g>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
    wand: '<path d="m15 4 1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z"/><path d="M4 20 13 11"/><path d="M6 4v2M5 5h2M19 15v2M18 16h2"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
    'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><path d="M7.5 7.5h.01"/>',
    'log-in': '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    'wifi-off': '<path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.6-1.9M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5"/><path d="M12 20h.01"/>',
    split: '<path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 14v7"/>',
    hash: '<path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18"/>',
    type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  };
  document.body.insertAdjacentHTML('afterbegin',
    '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
    Object.entries(paths).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') + '</svg>');

  // Icons whose meaning has a direction get .i-dir so they mirror in RTL.
  const directional = new Set(['chevron-right', 'chevron-left', 'arrow-left', 'arrow-right', 'send', 'log-in', 'undo']);
  const ico = (n, c = 'i') => `<svg class="${c}${directional.has(n) ? ' i-dir' : ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  /** One keycap for a whole chord: kbd('mod', 'enter') → [⌘↵]. */
  const kbd = (...keys) => `<kbd class="kbd" aria-hidden="true">${chord(...keys)}</kbd>`;
  /** aria-keyshortcuts value for the same chord. */
  const aks = (...keys) => keys.map(k => ({ mod: 'Meta', shift: 'Shift', alt: 'Alt', enter: 'Enter' }[k] || k)).join('+');

  /** The single tab component. count: number | '–' (not run) | undefined. flag: issue dot. */
  function tab(label, { selected = false, count, flag, icon, id, controls, keys } = {}) {
    const badge = count === undefined ? '' : count === '–'
      ? `<span class="n unknown" aria-hidden="true">–</span>`
      : `<span class="n">${typeof count === 'number' ? window.i18n.num(count) : count}</span>`;
    const desc = flag ? `<span class="sr-only">, ${flag}</span>` : count === '–' ? '<span class="sr-only">, not run yet</span>' : '';
    return `<button class="tab" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" ${id ? `id="${id}"` : ''} ${controls ? `aria-controls="${controls}"` : ''} ${keys ? `aria-keyshortcuts="${keys}"` : ''}>${icon ? ico(icon, 'i i-sm') : ''}${label}${badge}${flag ? '<span class="flag" aria-hidden="true"></span>' : ''}${desc}</button>`;
  }

  /** Icon copy button with reserved feedback. state: idle | copied | failed. */
  function copyBtn(label, { state = 'idle', size = 'btn-sm', keys } = {}) {
    return `<button class="btn btn-ghost btn-icon ${size} copy${state === 'copied' ? ' is-copied' : ''}" aria-label="${label}" ${keys ? `aria-keyshortcuts="${keys}"` : ''}>
      ${ico('copy', 'i i-sm i-idle')}${ico('check', 'i i-sm i-done')}
      ${state === 'copied' ? `<span class="copied-bubble" aria-hidden="true">${ico('check', 'i i-sm')}Copied</span>` : ''}
    </button>`;
  }
  /** Text copy button: "Copy" and "Copied" share one grid cell, so the width never changes. */
  function copyTextBtn(label, { state = 'idle', cls = 'btn-sm' } = {}) {
    return `<button class="btn ${cls} copy${state === 'copied' ? ' is-copied' : ''}">${ico('copy', 'i i-sm i-idle')}${ico('check', 'i i-sm i-done')}<span class="copy-label"><span>${label}</span><span>Copied</span></span></button>`;
  }

  /** Empty, error and explanation states share one anatomy. */
  function state({ icon = 'info', tone = '', title, body, why, actions = [], extra = '', center = false, compact = false, heading = 'h3' }) {
    return `<div class="state${center ? ' center' : ''}${compact ? ' compact' : ''}">
      ${icon ? `<span class="state-ico ${tone}" aria-hidden="true">${ico(icon)}</span>` : ''}
      <${heading}>${title}</${heading}>
      ${body ? `<p>${body}</p>` : ''}
      ${why ? `<div class="why">${ico('info', 'i i-sm')}<span>${why}</span></div>` : ''}
      ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
      ${extra}
    </div>`;
  }

  window.TB = { q, ico, kbd, aks, tab, copyBtn, copyTextBtn, state, t };

  /* ---------- Top bar ---------- */
  const signedOut = q.auth === 'out';
  const top = document.querySelector('[data-shell="topbar"]');
  if (top) top.outerHTML = `
  <header class="topbar">
    <button class="btn btn-ghost btn-icon mobile-only" aria-label="Open operations">${ico('menu')}</button>
    <div class="brand"><span class="brand-mark" aria-hidden="true">${ico('mark')}</span><span class="desktop-only">Sendproof</span></div>
    <span class="crumb-sep desktop-only" aria-hidden="true">/</span>
    <button class="api-switch" aria-haspopup="listbox"><span lang="en">Acme Store API</span> <span class="ver">v1.0.0</span>${ico('chevrons-ud', 'i i-sm')}</button>
    <button class="env desktop-only" aria-haspopup="listbox"><span class="dot" aria-hidden="true"></span><strong>${t('env')}</strong><span class="ltr">store-demo.db</span>${ico('chevron-down', 'i i-sm')}</button>
    <div class="spacer"></div>
    <button class="search-trigger" aria-label="${t('search')}" aria-keyshortcuts="${aks('mod', 'K')}">${ico('search', 'i i-sm')}<span class="grow">${t('search')}</span>${kbd('mod', 'K')}</button>
    <button class="btn btn-ghost btn-icon btn-sm desktop-only" id="display-btn" aria-label="${t('display')}" aria-haspopup="dialog" aria-keyshortcuts="${aks('mod', ',')}" ${q.overlay === 'display' ? 'aria-expanded="true" style="background:var(--hover);color:var(--text)"' : ''}>${ico('sliders', 'i i-sm')}</button>
    <button class="btn btn-ghost btn-icon btn-sm desktop-only" id="history-btn" aria-label="${t('history')}" aria-keyshortcuts="${aks('mod', 'Y')}" ${q.overlay === 'history' ? 'aria-expanded="true" style="background:var(--hover);color:var(--text)"' : ''}>${ico('history', 'i i-sm')}</button>
    <button class="btn btn-ghost btn-icon btn-sm desktop-only" aria-label="Keyboard shortcuts" aria-keyshortcuts="Shift+?">${ico('keyboard', 'i i-sm')}</button>
    ${signedOut
      ? `<button class="btn btn-primary btn-sm signin-cta" aria-keyshortcuts="${aks('shift', 'mod', 'U')}">${ico('log-in', 'i i-sm')}${t('signIn')}</button>`
      : `<button class="persona" aria-haspopup="menu" aria-label="Signed in as Ada Admin, role admin. Switch user"><span class="avatar" aria-hidden="true">AA</span><span class="name">Ada Admin</span><span class="role">admin</span>${ico('chevron-down', 'i i-sm')}</button>`}
  </header>`;


  // The API's name and version come from the spec's info, which loads after this file.
  document.addEventListener('DOMContentLoaded', () => {
    const v = window.TB_SPEC?.info?.version;
    const el = document.querySelector('.api-switch .ver');
    if (v && el) el.textContent = 'v' + v;
  });

  /* ---------- Mobile: one pane at a time ---------- */
  const ws = document.querySelector('.workspace');
  const mview = q.mview || 'request';
  if (ws) ws.dataset.view = mview;
  document.querySelectorAll('[data-switch]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.switch === mview));
    b.textContent = b.dataset.switch === 'request' ? t('m.request') : t('m.result');
  });
})();

// Sidebar for the v4 mocks, built from the OpenAPI document in mocks/spec.js.
//
// What changed from v3 (see README "Navigation and reference"):
//   - Every tag group is expanded by default. Groups collapse with their heading; the
//     product remembers the state per API (?collapsed=Accounts,Balances shows it).
//   - Signed out, a notice at the top says how many operations need sign-in and offers
//     Sign in, instead of a footer line. Locked rows carry a lock marker.
//   - The tab only changes when the user picks it. Opening a model from an operation keeps
//     the Operations tab and marks that operation as the current context (?from=<opId>).
//   - The footer is a bar with the same height and top border as the panes' bottom bars.
// Parameters: side=operations|models  filter=nomatch|empty  collapsed=<tags>  from=<opId>
//             drawer=1 (mobile drawer open)   lists=open (List pages starts collapsed)
(function () {
  const { ico, kbd, aks, tab, state, t } = window.TB;
  const S = window.TB.schema;

  /** The operation a screen shows: ?opid=<operationId>, or v3's short names (?op=create). */
  function currentOp(q) {
    const ops = S.operations;
    const byId = id => ops.find(o => o.id === id);
    if (q.opid && byId(q.opid)) return byId(q.opid);
    const short = {
      create: () => byId('PaymentsController.Create') || ops.find(o => o.method === 'post' && /payments$/.test(o.path)),
      get: () => byId('PaymentsController.Get') || ops.find(o => o.method === 'get' && /payments\/\{/.test(o.path)),
      list: () => byId('PaymentsController.List') || ops.find(o => o.method === 'get' && /payments$/.test(o.path)),
      login: () => ops.find(o => o.method === 'post' && /auth\/login$/.test(o.path)),
      update: () => ops.find(o => o.deprecated) || byId('PaymentsController.Create'),
    }[q.op || 'create'];
    return (short && short()) || ops[0];
  }
  window.TB.currentOp = currentOp;

  /** Tag groups in the document's tag order, then any tags only operations mention. */
  function groups() {
    const order = (S.spec.tags || []).map(tag => tag.name);
    const map = new Map(order.map(name => [name, []]));
    for (const o of S.operations) { if (!map.has(o.tag)) map.set(o.tag, []); map.get(o.tag).push(o); }
    return [...map].filter(([, items]) => items.length);
  }
  window.TB.groups = groups;

  /** Models grouped by what they are, so a long list stays scannable. */
  function modelGroups() {
    const names = Object.keys(S.schemas).sort((a, b) => a.localeCompare(b));
    const bucket = name => S.kindOf(name) === 'enum' ? 'models.enums'
      : /^PagedListOf/.test(name) ? 'models.lists'
      : /Problem|Error/.test(name) ? 'models.errors'
      : /(Request|Input|Command)$/.test(name) ? 'models.requests' : 'models.resources';
    const keys = ['models.resources', 'models.requests', 'models.lists', 'models.enums', 'models.errors'];
    return keys.map(key => [key, names.filter(n => bucket(n) === key)]).filter(([, list]) => list.length);
  }
  window.TB.modelGroups = modelGroups;

  const KIND = { object: ['{ }', 'kind.object'], enum: ['enum', 'kind.enum'], oneOf: ['1 of', 'kind.oneOf'], allOf: ['all', 'kind.allOf'], array: ['[ ]', 'kind.array'] };

  /** Builds the sidebar for a set of URL-style parameters; the boards call it directly. */
  function buildSidebar(q) {
    const signedOut = q.auth === 'out';
    const sideTab = q.side || 'operations';
    const current = currentOp(q);
    const inContext = ['model'].includes(q.view) && q.from;
    const collapsed = new Set((q.collapsed || '').split(',').filter(Boolean));
    const all = groups();
    const locked = S.operations.filter(o => o.secured).length;

    // Markers stack: deprecated and locked can both apply. Each has a tooltip and screen-reader text.
    const marker = o => {
      const out = [];
      if (o.deprecated) out.push(`<span title="${t('nav.deprecated')}">${ico('warn', 'i i-sm')}<span class="sr-only">${t('nav.deprecated')}</span></span>`);
      if (signedOut && o.secured) out.push(`<span class="lock" title="${t('nav.locked')}">${ico('lock', 'i i-sm')}<span class="sr-only">${t('nav.locked')}</span></span>`);
      else if (!signedOut && o.roles.length && !o.roles.includes('admin')) out.push(`<span title="${t('nav.roles', { roles: o.roles.join(' or ') })}">${ico('shield', 'i i-sm')}<span class="sr-only">${t('nav.roles', { roles: o.roles.join(' or ') })}</span></span>`);
      return out.length ? `<span class="trail">${out.join('')}</span>` : '';
    };

    function opsList() {
      if (q.filter === 'nomatch') return `<div class="nav">${state({
        icon: 'search', compact: true, title: 'No operations match “paymnet”',
        body: 'Search covers names, paths, tags and operation IDs.',
        actions: [`<button class="btn btn-sm">Clear filter ${kbd('Esc')}</button>`, `<button class="btn btn-ghost btn-sm">Try “payment”</button>`],
      })}</div>`;
      if (q.filter === 'empty') return `<div class="nav">${state({
        icon: 'list', compact: true, title: 'This API has no operations yet',
        body: 'Test Bench lists every path in <code>/openapi/v1.json</code>. Map an endpoint and reload.',
        actions: [`<button class="btn btn-sm">${ico('refresh', 'i i-sm')}Reload spec ${kbd('mod', 'R')}</button>`],
      })}</div>`;
      return `<div class="nav">${all.map(([name, items], gi) => {
        const open = !collapsed.has(name);
        const id = `grp-${gi}`;
        return `<div class="nav-group">
          <button class="nav-heading" aria-expanded="${open}" aria-controls="${id}">${ico(open ? 'chevron-down' : 'chevron-right', 'i i-sm')}<span lang="en">${name}</span><span class="count">${items.length}</span></button>
          <ul id="${id}"${open ? '' : ' hidden'}>${items.map(o => {
            const here = o.id === current.id && !['overview'].includes(q.view) && sideTab === 'operations';
            const attr = here ? (inContext ? 'class="nav-item is-context" aria-current="location"' : 'class="nav-item" aria-current="page"') : 'class="nav-item"';
            return `<li><a ${attr.replace('class="nav-item', `class="nav-item${o.deprecated ? ' is-deprecated' : ''}`)} href="#" title="${S.esc(o.summary)}">
              <span class="method m-${o.method}">${o.method === 'delete' ? 'DEL' : o.method.toUpperCase()}</span><span class="label-text" lang="en">${S.esc(o.summary)}</span>${marker(o)}
            </a></li>`;
          }).join('')}</ul>
        </div>`;
      }).join('')}</div>`;
    }

    function modelList() {
      if (q.filter === 'empty') return `<div class="nav">${state({
        icon: 'box', compact: true, title: 'No models in this spec',
        body: 'Models come from <code>components.schemas</code>. Request and response bodies that use inline schemas still show in each operation’s Docs.',
      })}</div>`;
      const currentModel = q.view === 'model' ? (q.model || 'Payment') : '';
      return `<div class="nav">${modelGroups().map(([key, names], gi) => `<div class="nav-group">
        ${(() => { const open = key !== 'models.lists' || q.lists === 'open'; return `<button class="nav-heading" aria-expanded="${open}" aria-controls="mgrp-${gi}">${ico(open ? 'chevron-down' : 'chevron-right', 'i i-sm')}<span>${t(key)}</span><span class="count">${names.length}</span></button>
        <ul id="mgrp-${gi}"${open ? '' : ' hidden'}>`; })()}${names.map(name => {
          const [glyph, kindKey] = KIND[S.kindOf(name)] || KIND.object;
          const kindName = S.kindOf(name);
          const n = kindName === 'enum' ? (S.schemas[name].enum || []).length : kindName === 'oneOf' ? S.variantsOf(S.schemas[name]).length : S.stats(name).count;
          return `<li><a class="nav-item" href="#" ${name === currentModel ? 'aria-current="page"' : ''}>
            <span class="model-ico" title="${t(kindKey)}">${glyph}<span class="sr-only">${t(kindKey)}</span></span><span class="label-text" lang="en">${name}</span><span class="trail num">${n}</span>
          </a></li>`;
        }).join('')}</ul></div>`).join('')}</div>`;
    }

    // Signed out: one clear notice at the top, in both tabs, with the way to sign in.
    const notice = signedOut ? `
      <section class="auth-notice" aria-labelledby="auth-notice-title">
        <div class="an-title">${ico('lock', 'i i-sm')}<h2 id="auth-notice-title">${t('auth.out.title')}</h2></div>
        <p>${t('auth.out.body', { n: locked, total: S.operations.length })}</p>
        <div class="an-actions">
          <button class="btn btn-primary btn-sm" aria-keyshortcuts="${aks('shift', 'mod', 'U')}">${ico('log-in', 'i i-sm')}${t('signIn')}${kbd('shift', 'mod', 'U')}</button>
          <button class="btn btn-sm" aria-haspopup="menu">${t('auth.out.seeded')}${ico('chevron-down', 'i i-sm')}</button>
        </div>
      </section>` : '';

    const allCollapsed = all.every(([name]) => collapsed.has(name));
    const foot = sideTab === 'models'
      ? `<span class="bar-text">${ico('box', 'i i-sm')}<span>${t('foot.models', { n: Object.keys(S.schemas).length })}</span></span>`
      : `<span class="bar-text">${ico('list', 'i i-sm')}<span>${t('foot.ops', { n: S.operations.length, g: all.length })}</span></span>
         <button class="btn btn-ghost btn-xs" aria-keyshortcuts="${aks('alt', 'mod', '[')}">${ico('chevrons-ud', 'i i-sm')}${allCollapsed ? t('foot.expandAll') : t('foot.collapseAll')}</button>`;

    return `
    <nav class="sidebar${q.drawer ? ' is-drawer' : ''}" aria-label="${t('browse')}">
      <div class="tabs" role="tablist" aria-label="${t('browse')}">
        ${tab(t('operations'), { selected: sideTab === 'operations', count: S.operations.length, keys: 'G O' })}
        ${tab(t('models'), { selected: sideTab === 'models', count: Object.keys(S.schemas).length, keys: 'G M' })}
      </div>
      ${notice}
      <div class="sidebar-search">
        <label class="input-sm${q.filter === 'nomatch' ? ' is-focus' : ''}">${ico('filter', 'i i-sm')}<span class="sr-only">${t(sideTab === 'models' ? 'filter.models' : 'filter.ops')}</span><input placeholder="${t(sideTab === 'models' ? 'filter.models' : 'filter.ops')}" value="${q.filter === 'nomatch' ? 'paymnet' : ''}">${q.filter === 'nomatch' ? `<button class="btn btn-ghost btn-icon btn-xs" aria-label="Clear filter">${ico('x', 'i i-sm')}</button>` : kbd('/')}</label>
      </div>
      ${sideTab === 'models' ? modelList() : opsList()}
      <div class="pane-bar side-bar">${foot}</div>
    </nav>${q.drawer ? '<div class="drawer-scrim" aria-hidden="true"></div>' : ''}`;
  }
  window.TB.buildSidebar = buildSidebar;

  /**
   * The head row of the main column, the same in Try it, Docs and Models: where you are
   * (breadcrumbs) on the start, how to switch or go back on the end. One tab tall, so it
   * lines up with the sidebar tabs and the right column's head.
   *   kind 'op':    Payments › Create payment            [Try it | Docs]
   *   kind 'model': Payments › Create payment › Payment  [← Back to Create payment ⌥←]   (opened from an operation)
   *                 Models › Resources › Payment                        (picked in the Models tab)
   * ?via=Payment adds an intermediate model (Payment › Counterparty).
   */
  function ctxBar(q, kind, view) {
    const S2 = window.TB.schema;
    const o = currentOp(q);
    const from = q.from && S2.operations.find(x => x.id === q.from);
    let items, end = '';
    if (kind === 'op') {
      items = [[o.tag], [o.summary, true]];
      end = `<div class="segmented view-switch" role="group" aria-label="${t('view.label')}">
        <button aria-pressed="${view === 'try'}" ${view === 'try' ? '' : 'aria-keyshortcuts="D"'}>${ico('flask', 'i i-sm')}${t('view.try')}</button>
        <button aria-pressed="${view === 'docs'}" ${view === 'docs' ? '' : 'aria-keyshortcuts="D"'}>${ico('book', 'i i-sm')}${t('view.docs')}</button></div>`;
    } else {
      const name = q.model || 'Payment';
      const via = (q.via || '').split(',').filter(Boolean).map(v => [v]);
      if (from) {
        items = [[from.tag], [from.summary], ...via, [name, true]];
        const back = via.length ? via[via.length - 1][0] : from.summary;
        // The one back control: it names where it goes and keeps that page's scroll position.
        end = `<button class="btn btn-ghost btn-xs back-btn" aria-keyshortcuts="Alt+ArrowLeft" title="${t('back.to', { name: back })} (${window.i18n.chordLong('alt', '←')})">${ico('arrow-left', 'i i-sm')}<span class="back-label" lang="en">${t('back.to', { name: S2.esc(back) })}</span>${kbd('alt', '←')}</button>`;
      } else {
        const group = (modelGroups().find(([, names]) => names.includes(name)) || ['models.resources'])[0];
        items = [[t('models')], [t(group)], ...via, [name, true]];
      }
    }
    const crumbs = items.map(([label, here]) => here
      ? `<li><span aria-current="page" lang="en">${S2.esc(label)}</span></li>`
      : `<li><a href="#" lang="en">${S2.esc(label)}</a></li>`).join('');
    return `<div class="ctx-bar"><nav class="crumbs" aria-label="${t('crumbs')}"><ol>${crumbs}</ol></nav><div class="end">${end}</div></div>`;
  }
  window.TB.ctxBar = ctxBar;
  const side = document.querySelector('[data-shell="sidebar"]');
  if (side) side.outerHTML = buildSidebar(window.TB.q);
})();

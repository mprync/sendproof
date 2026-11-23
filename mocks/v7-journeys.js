// v7 (?v7=1, with v5=1&v6=1): journeys. Plan: docs/plans/journeys.md.
// A journey is an Arazzo workflow over the store's OpenAPI document; the writes each step should
// make and the approved differences live in the companion expectations document.
// Without ?v7 nothing here runs, so every v3 to v6 screen renders exactly as before.
//
// Scenes (?jv=…), all on the "Order to shipment" journey of the Acme Store API:
//   spec      Specification mode: the operation screen as before, with the mode switch above it
//   overview  Journeys mode: the journeys sidebar, the journey's inputs and steps, its last runs
//   step      a Preview run at step 4 (Ship order): the rail, bound values, what it should write
//             (mode=send: the same step in a Send run, with Preview and Send per step)
//   result    step 4 after its Preview, compared with its expected writes
//   summary   the finished run: every step, timings, the approved differences used
//   refused   a Send run stopped at step 3 by an unexpected 409
//   empty     an API that publishes no journeys
//   loading   the journeys sidebar and overview while the Arazzo document loads
// Other parameters: theme=dark, text=130, lang=ar, mview=request|result and drawer=1 (phones).
(function () {
  const TB = window.TB;
  const { q, ico, kbd, aks, tab, copyBtn, state } = TB;
  if (!q.v7) return;
  document.documentElement.dataset.v7 = '';
  // v7.css loads only with ?v7=1 (parser-inserted, so the panes below are styled when measured).
  if (!document.querySelector('link[href="v7.css"]')) document.write('<link rel="stylesheet" href="v7.css">');
  const logo = window.SP?.logo || (() => '');
  const { num, lang } = window.i18n;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Workbench chrome is translated (en, ar); everything the API publishes (journey and step
  // names, table names, reasons in approved differences) stays as written and is marked lang="en".
  const L = (en, ar) => (lang === 'ar' && ar ? ar : en);
  const en = s => `<span lang="en">${s}</span>`;
  const ltr = s => `<bdi dir="ltr">${s}</bdi>`;

  document.querySelector('svg[style*="display:none"]')?.insertAdjacentHTML('beforeend', [
    ['route', '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/>'],
    ['circle-x', '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'],
    ['circle-dashed', '<path d="M10.1 3.2a9 9 0 0 1 3.8 0M17.6 4.9a9 9 0 0 1 2.7 2.7M20.8 10.1a9 9 0 0 1 0 3.8M19.1 17.6a9 9 0 0 1-2.7 2.7M13.9 20.8a9 9 0 0 1-3.8 0M6.4 19.1a9 9 0 0 1-2.7-2.7M3.2 13.9a9 9 0 0 1 0-3.8M4.9 6.4a9 9 0 0 1 2.7-2.7"/>'],
    ['play', '<path d="M7.5 4.8v14.4L19 12z"/>'],
    ['forward', '<path d="M4 5.5v13l7.5-6.5zM12.5 5.5v13L20 12z"/>'],
    ['bind', '<path d="M5 4v7a4 4 0 0 0 4 4h10"/><path d="m15 11 4 4-4 4"/>'],
    ['badge-check', '<path d="M12 2.8l2.3 1.7 2.8-.2.9 2.7 2.4 1.5-.9 2.7.9 2.7-2.4 1.5-.9 2.7-2.8-.2L12 21.2l-2.3-1.7-2.8.2-.9-2.7-2.4-1.5.9-2.7-.9-2.7 2.4-1.5.9-2.7 2.8.2z"/><path d="m9 12 2 2 4-4"/>'],
    ['download', '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'],
    ['terminal', '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>'],
    ['bot', '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4v4M9.5 13v1M14.5 13v1"/>'],
    ['file-code', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2"/>'],
    ['ne', '<path d="M5 9.5h14M5 14.5h14M15.5 5l-7 14"/>'],
    ['minus-circle', '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'],
    ['plus-circle', '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'],
    ['stop', '<rect x="6" y="6" width="12" height="12" rx="2"/>'],
    ['skip', '<circle cx="12" cy="12" r="9"/><path d="M9 8.5v7M10.5 12 15 8.5v7z"/>'],
  ].map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join(''));

  /* =====================================================================
     Data: the Acme Store API's journeys, and one run of "Order to shipment"
     ===================================================================== */
  const ORDER = { id: '5e3a91c0-7b2d-4f1e-8c6a-2d9f0b14c2d1', short: '5e3a91c0…c2d1', number: 'ORD-2026-000188' };
  const PAY = { id: 'b7c4e2a9-3f10-4d6b-a8e5-61c09d2741f0', short: 'b7c4e2a9…41f0', number: 'PAY-2026-000356' };
  const SHIP = { id: '0d6f2b18-94c7-4a3e-b25d-7e81c4f09e3a', short: '0d6f2b18…9e3a', tracking: 'JD014600006282' };
  const RUN = '7f3c';

  // Sidebar groups come from the Arazzo document's own order; the last group is inferred.
  // last: pass | fail | none | sendonly
  const GROUPS = [
    ['Checkout and fulfilment', [
      { id: 'orderToShipment', name: 'Order to shipment', steps: 5, last: 'fail' },
      { id: 'cancelBeforeShipping', name: 'Cancel before shipping', steps: 4, last: 'pass' },
      { id: 'shipUnpaidOrder', name: 'Ship an unpaid order', steps: 2, last: 'pass' },
    ]],
    ['After-sales', [
      { id: 'refundReturnedItem', name: 'Refund a returned item', steps: 4, last: 'pass', approved: 1 },
      { id: 'partialRefund', name: 'Partial refund', steps: 3, last: 'none' },
    ]],
    ['Reviews', [{ id: 'writeAndPublishReview', name: 'Publish a review', steps: 3, last: 'pass' }]],
    ['Carts', [{ id: 'priceCartWithCoupon', name: 'Price with a coupon', steps: 3, last: 'sendonly' }]],
    ['Inferred from links', [
      { id: 'startCartThenGet', name: 'Start cart → Get cart', steps: 2, last: 'none', inferred: true },
      { id: 'createCustomerThenGet', name: 'Create customer → Get customer', steps: 2, last: 'none', inferred: true },
    ], true],
  ];
  const TOTAL = GROUPS.reduce((a, [, items]) => a + items.length, 0);

  // bind: [field, from] where from is a step number, or 'in' for the journey's inputs.
  const STEPS = [
    { n: 1, id: 'createOrder', method: 'post', op: 'Create order', path: '/api/v2/orders', ok: 201, writes: [['5', 'rows'], ['1', 'email']], binds: [['customerId', 'in'], ['variantId', 'in'], ['quantity', 'in'], ['unitPrice', 'in'], ['shippingMethod', 'in']] },
    { n: 2, id: 'findPayment', method: 'get', op: 'List payments', path: '/api/v2/payments', ok: 200, reads: true, binds: [['orderId', 1]] },
    { n: 3, id: 'capturePayment', method: 'post', op: 'Capture payment', path: '/api/v2/payments/{id}/capture', ok: 200, writes: [['2', 'rows'], ['1', 'email']], binds: [['id', 2, 'paymentId'], ['amount', 1]] },
    { n: 4, id: 'shipOrder', method: 'post', op: 'Ship order', path: '/api/v2/orders/{orderId}/shipments', ok: 201, writes: [['4', 'rows'], ['2', 'documents'], ['1', 'email']], binds: [['orderId', 1], ['carrier', 'in']] },
    { n: 5, id: 'checkOrder', method: 'get', op: 'Get order', path: '/api/v2/orders/{id}', ok: 200, reads: true, binds: [['id', 1, 'orderId']], criteria: '$response.body#/status == "Shipped"' },
  ];

  // Run state per scene: done | current | fail | refused | pending | skipped, with the rail's sub line.
  const RUNS = {
    preview: [['done', '201 · 64 ms', 'ad'], ['done', '200 · 18 ms'], ['done', '200 · 71 ms'], ['current', ''], ['pending', '']],
    result: [['done', '201 · 64 ms', 'ad'], ['done', '200 · 18 ms'], ['done', '200 · 71 ms'], ['fail', '201 · 58 ms'], ['pending', '']],
    summary: [['done', '201 · 64 ms', 'ad'], ['done', '200 · 18 ms'], ['done', '200 · 71 ms'], ['fail', '201 · 58 ms'], ['done', '200 · 14 ms']],
    refused: [['done', '201 · 88 ms'], ['done', '200 · 21 ms'], ['refused', '409 · 34 ms'], ['skipped', ''], ['skipped', '']],
  };

  /* =====================================================================
     Small builders
     ===================================================================== */
  const METHOD = m => `<span class="method m-${m}">${m === 'delete' ? 'DEL' : m.toUpperCase()}</span>`;
  const OPB = { insert: ['ins', '+ INSERT'], update: ['upd', '~ UPDATE'], delete: ['del', '− DELETE'] };
  const opBadge = op => `<span class="op-badge op-${OPB[op][0]}">${OPB[op][1]}</span>`;
  const fromStep = (n, out) => `<span class="ref7">${ico('bind', 'i i-sm i-dir')}${L('step', 'الخطوة')} ${num(n)}${out ? ` · ${ltr(`<code>${out}</code>`)}` : ''}</span>`;
  const fromInput = name => `<span class="ref7 is-in">${ico('bind', 'i i-sm i-dir')}${L('input', 'مُدخل')} · ${ltr(`<code>${name}</code>`)}</span>`;
  const LAST = {
    pass: ['circle-check', 'ok', L('Last run passed', 'نجح آخر تشغيل')],
    fail: ['circle-x', 'danger', L('Last run failed', 'فشل آخر تشغيل')],
    none: ['circle-dashed', 'muted', L('Not run yet', 'لم يُشغَّل بعد')],
    sendonly: ['flask-off', 'warn', L('Send only: a step can’t Preview', 'إرسال فقط: إحدى الخطوات لا تقبل المعاينة')],
  };
  const lastIco = k => { const [i, tone, label] = LAST[k]; return `<span class="lr7 is-${tone}" title="${esc(label)}">${ico(i, 'i i-sm')}<span class="sr-only">${label}</span></span>`; };

  /** The journeys sidebar: groups like Operations, a step-count box, the last result at the end.
   *  The open journey unfolds into its steps during a run: that list is the progress rail. */
  function sidebar({ open = 'orderToShipment', run = null, empty = false, loading = false } = {}) {
    // Journeys is a mode (the switch in the top bar), so this sidebar has no tabs. Its head row
    // keeps the tab row's height, so the shell's head line holds in both modes, and names the
    // document the journeys come from.
    const src = empty
      ? `<span class="jh7-src is-none">${ico('braces', 'i i-sm')}<span>${L('No journeys defined', 'لا توجد رحلات معرَّفة')}</span></span>`
      : loading
        ? `<span class="jh7-src">${ico('file-code', 'i i-sm')}<span class="sk sk-line" style="inline-size:7.5rem"></span></span>`
        : `<a href="#" class="jh7-src" title="${L('Built from the journey classes at startup · open the generated Arazzo 1.1 document', 'مبنية من أصناف الرحلات عند التشغيل · افتح مستند Arazzo 1.1 المولَّد')}">${ico('braces', 'i i-sm')}<span>${L('From code', 'من الشيفرة')}</span><code dir="ltr">StoreApi.Journeys</code></a>`;
    const tabs = `${q.drawer ? `<div class="mode7-drawer">${modeSwitch('journeys')}</div>` : ''}<div class="jh7">${src}</div>`;
    const search = `<div class="sidebar-search"><label class="input-sm">${ico('filter', 'i i-sm')}<span class="sr-only">${L('Filter journeys', 'تصفية الرحلات')}</span><input placeholder="${L('Filter journeys', 'تصفية الرحلات')}" ${empty || loading ? 'disabled' : ''}>${kbd('/')}</label></div>`;
    let body;
    if (loading) {
      const sk = (w) => `<li><span class="nav-item j7-sk"><span class="sk j7-sk-box"></span><span class="sk sk-line" style="inline-size:${w}%"></span><span class="sk j7-sk-dot"></span></span></li>`;
      body = `<div class="nav" aria-busy="true" aria-label="${L('Loading journeys', 'جارٍ تحميل الرحلات')}">${[[3, [72, 58, 64]], [2, [66, 48]], [1, [78]], [2, [70, 60]]].map(([, ws]) => `<div class="nav-group"><span class="nav-heading j7-sk-h"><span class="sk sk-line" style="inline-size:46%"></span></span><ul>${ws.map(sk).join('')}</ul></div>`).join('')}</div>`;
    } else if (empty) {
      body = `<div class="nav">${state({ icon: 'route', compact: true, title: L('No journeys yet', 'لا توجد رحلات بعد'),
        body: L('This API defines no journeys, and its OpenAPI document has no links to infer one from.', 'لا تعرّف هذه الواجهة أي رحلات، ولا يحتوي مستند OpenAPI على روابط يُستنتج منها.') })}</div>`;
    } else {
      body = `<div class="nav">${GROUPS.map(([name, items, inferred], gi) => `<div class="nav-group${inferred ? ' j7-inferred' : ''}">
        <button class="nav-heading" aria-expanded="true" aria-controls="jgrp-${gi}">${ico('chevron-down', 'i i-sm')}<span lang="en">${inferred ? L('Inferred from links', 'مستنتجة من الروابط') : name}</span><span class="count">${num(items.length)}</span></button>
        <ul id="jgrp-${gi}">${items.map(j => {
          const here = j.id === open;
          const rail = here && run ? railList(run) : '';
          return `<li><a class="nav-item jn7${here ? ' is-here' : ''}${rail ? ' has-rail' : ''}" href="#" ${here ? 'aria-current="page"' : ''} ${rail ? 'aria-expanded="true"' : ''} title="${esc(j.name)}">
            <span class="jn7-n" title="${L(`${j.steps} steps`, `${j.steps} خطوات`)}">${num(j.steps)}</span><span class="label-text" lang="en">${esc(j.name)}</span>
            <span class="trail">${lastIco(j.last)}</span></a>${rail}</li>`;
        }).join('')}</ul></div>`).join('')}</div>`;
    }
    // Run all previews every journey, one after another: the workbench's version of the CI run.
    const runAll = `<button class="btn btn-sm run7-btn" type="button" title="${L('Preview every journey · Send-only ones are skipped', 'عاين كل الرحلات · تُتخطّى رحلات الإرسال فقط')}" ${loading || empty ? 'disabled' : ''}>${ico('play', 'i i-sm i-dir')}${L('Run all', 'شغّل الكل')}</button>`;
    const foot = loading || empty
      ? runAll
      : `${runAll}<button class="btn btn-ghost btn-xs" aria-keyshortcuts="${aks('alt', 'mod', '[')}">${ico('chevrons-ud', 'i i-sm')}${TB.t('foot.collapseAll')}</button>`;
    return `<nav class="sidebar j7-side${q.drawer ? ' is-drawer' : ''}" aria-label="${TB.t('browse')}">${tabs}${search}${body}<div class="pane-bar side-bar j7-bar">${foot}</div></nav>${q.drawer ? '<div class="drawer-scrim" aria-hidden="true"></div>' : ''}`;
  }

  /** The mode switch: Specification (operations and models, from the OpenAPI document) or
   *  Journeys (workflows, from the Arazzo document). Two modes, so both stay visible: one click,
   *  and the current one is never hidden behind a menu. Each mode reopens where it was left. */
  function modeSwitch(current) {
    const item = (id, icon, label, keys) => `<a href="#" class="mode7-i"${id === current ? ' aria-current="page"' : ''} aria-keyshortcuts="${keys}" title="${label} · ${keys}">${ico(icon, 'i i-sm')}<span>${label}</span></a>`;
    return `<nav class="mode7" aria-label="${L('Mode', 'الوضع')}">${item('spec', 'braces', L('Specification', 'المواصفة'), 'G S')}${item('journeys', 'route', L('Journeys', 'الرحلات'), 'G J')}</nav>`;
  }

  /** The progress rail: one row per step, a connector between nodes, the state in the node. */
  function railList(run) {
    const NODE = { done: ico('check', 'i i-sm'), fail: ico('x', 'i i-sm'), refused: ico('x', 'i i-sm'), skipped: ico('minus', 'i i-sm') };
    const SUB = {
      current: L('Ready to Preview', 'جاهزة للمعاينة'), pending: L('Not run yet', 'لم تُشغَّل بعد'), skipped: L('Not run · run stopped', 'لم تُشغَّل · توقّف التشغيل'),
    };
    const SR = { done: L('passed', 'نجحت'), fail: L('failed', 'فشلت'), refused: L('refused', 'رُفضت'), current: L('current step', 'الخطوة الحالية'), pending: L('not run yet', 'لم تُشغَّل بعد'), skipped: L('not run', 'لم تُشغَّل') };
    return `<ol class="rail7" aria-label="${L('Steps', 'الخطوات')}">${STEPS.slice(0, run.length).map((st, i) => {
      const [k, sub, note] = run[i];
      const extra = k === 'fail' ? ` · <span class="r7-bad">${L('2 problems', 'مشكلتان')}</span>` : k === 'refused' ? ` · <span class="r7-bad">${L('refused', 'مرفوضة')}</span>` : note === 'ad' ? ` · <span class="r7-ad">${L('1 approved', '1 معتمد')}</span>` : '';
      return `<li class="r7 is-${k}"><a href="#" class="r7-link" ${k === 'current' || (q.jv === 'result' && i === 3) || (q.jv === 'refused' && i === 2) ? 'aria-current="step"' : ''}>
        <span class="r7-node" aria-hidden="true">${NODE[k] || num(st.n)}</span>
        <span class="r7-text"><span class="r7-name" lang="en">${st.op}</span><span class="r7-sub">${sub ? ltr(sub) : SUB[k]}${extra}</span></span>
        <span class="sr-only">, ${SR[k]}</span></a></li>`;
    }).join('')}</ol>`;
  }

  /** The step strip under the main head row: which step, the run's mode, a segmented bar. */
  function stepStrip(n, run, mode) {
    const seg = run.map(([k], i) => `<span class="sh7-seg is-${k}" title="${L('Step', 'الخطوة')} ${num(i + 1)}"></span>`).join('');
    const done = run.filter(([k]) => k === 'done').length;
    const pill = mode === 'send'
      ? `<span class="pill j7-pill-send">${ico('send', 'i i-sm i-dir')}${L('Send run', 'تشغيل بالإرسال')}</span>`
      : `<span class="pill pill-accent">${ico('flask', 'i i-sm')}${L('Preview run', 'تشغيل بالمعاينة')}</span>`;
    const note = mode === 'send'
      ? `<span class="sh7-note">${ico('db', 'i i-sm')}<span>${L('Each step commits to', 'كل خطوة تحفظ في')} ${ltr('<code>store-demo.db</code>')}</span></span>`
      : `<span class="sh7-note">${ico('clock', 'i i-sm')}<span>${L('Session held · rolls back when the run ends', 'الجلسة محجوزة · يُتراجع عنها عند انتهاء التشغيل')}</span></span>`;
    return `<div class="sh7"><div class="sh7-top"><strong class="sh7-step">${L(`Step ${n} of ${STEPS.length}`, `الخطوة ${num(n)} من ${num(STEPS.length)}`)}</strong>${pill}${note}</div>
      <div class="sh7-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${STEPS.length}" aria-valuenow="${done}" aria-label="${L(`${done} of ${STEPS.length} steps done`, `اكتملت ${num(done)} من ${num(STEPS.length)} خطوات`)}">${seg}</div></div>`;
  }

  const ctx = (items, end = '') => `<div class="ctx-bar"><nav class="crumbs" aria-label="${TB.t('crumbs')}"><ol>${items.map(([label, here, isEn = true]) => here
    ? `<li><span aria-current="page"${isEn ? ' lang="en"' : ''}>${label}</span></li>`
    : `<li><a href="#"${isEn ? ' lang="en"' : ''}>${label}</a></li>`).join('')}</ol></nav><div class="end">${end}</div></div>`;
  const stepNav = n => `<div class="j7-stepnav"><button class="btn btn-ghost btn-icon btn-sm" aria-label="${L('Previous step', 'الخطوة السابقة')}" title="${L('Previous step', 'الخطوة السابقة')} ([)" ${n === 1 ? 'disabled' : ''}>${ico('chevron-left', 'i i-sm i-dir')}</button><button class="btn btn-ghost btn-icon btn-sm" aria-label="${L('Next step', 'الخطوة التالية')}" title="${L('Next step', 'الخطوة التالية')} (])">${ico('chevron-right', 'i i-sm i-dir')}</button></div>`;
  // In a journey step, Expected leads and keeps its count; the other tabs give up their counts
  // (they're inside each tab) so all six fit the result pane at its default width.
  const resultTabs = (sel, count, flag) => `<div class="tabs scrolls j7-rtabs" role="tablist" aria-label="${L('Result', 'النتيجة')}">${[L('Expected', 'المتوقَّع'), TB.t('res.response'), TB.t('res.database'), TB.t('res.effects'), TB.t('res.logs'), TB.t('res.headers')].map((label, i) => tab(label, { selected: i === sel, count: i === 0 ? count : undefined, flag: i === 0 ? flag : undefined })).join('')}</div>`;
  const resultBar = (text, icon = 'undo') => `<div class="pane-bar result-bar"><span class="bar-text">${ico(icon, 'i i-sm i-dir')}<span>${text}</span></span><button class="btn btn-ghost btn-sm" aria-keyshortcuts="Meta+Y">${ico('history', 'i i-sm')}${TB.t('history')}${kbd('mod', 'Y')}</button></div>`;
  const sectionLabel = (label, end = '') => `<h2 class="section-label j7-sl"><span>${label}</span><span class="rule" aria-hidden="true"></span>${end}</h2>`;

  /** A bound field gets a chip in its label row that says where the value came from. */
  function bindChip(html, field, chip) {
    return html.replace(new RegExp(`(<div class="f5[^"]*" data-field="${field}"[^>]*><div class="f5-label">[\\s\\S]*?)(<span class="f5-end">)`), `$1${chip}$2`)
      .replace(`data-field="${field}"`, `data-field="${field}" data-bound`);
  }

  /* =====================================================================
     Expected writes (before a step runs) and the comparison (after)
     ===================================================================== */
  // Step 4's expectations, from ShipOrderWrites.cs (built into the expectations document).
  const EXPECT4 = [
    { store: 'sqlite', op: 'update', t: 'Orders', key: ['Id', fromStep(1, 'orderId')], f: [['Status', 'Paid → Shipped'], ['ShippedAt', L('any date-time', 'أي تاريخ ووقت')], ['ShippedBy', `${ltr('<span class="j6-s">"ada.admin@acme.dev"</span>')} <span class="faint">${L('the persona', 'الشخصية')}</span>`]] },
    { store: 'sqlite', op: 'insert', t: 'Shipments', f: [['OrderId', fromStep(1, 'orderId')], ['Carrier', '"DHL"'], ['ServiceLevel', fromInput('shippingMethod')], ['TrackingNumber', `${L('matches', 'يطابق')} ${ltr('<code>^JD\\d{12}$</code>')}`]] },
    { store: 'sqlite', op: 'insert', t: 'InventoryMovements', f: [['VariantId', fromInput('variantId')], ['Reason', '"Shipped"'], ['Quantity', ltr('−2')]] },
    { store: 'sqlite', op: 'delete', t: 'StockReservations', key: ['OrderId', fromStep(1, 'orderId')] },
    { store: 'mongodb', op: 'update', t: 'orders', key: ['orderId', fromStep(1, 'orderId')], f: [['status', 'Paid → Shipped']] },
    { store: 'mongodb', op: 'insert', t: 'order_events', f: [['type', '"order.shipped"'], ['orderId', fromStep(1, 'orderId')]] },
  ];
  function expectList() {
    const row = e => `<li class="ex7">
      <div class="ex7-head">${opBadge(e.op)}<span class="ex7-t" dir="ltr">${e.t}</span>${e.key ? `<span class="ex7-key"><code dir="ltr">${e.key[0]}</code> = ${e.key[1]}</span>` : ''}</div>
      ${e.f ? `<dl class="ex7-f">${e.f.map(([k, v]) => `<div><dt dir="ltr">${k}</dt><dd>${v.startsWith('"') ? ltr(`<span class="j6-s">${esc(v)}</span>`) : v}</dd></div>`).join('')}</dl>` : ''}</li>`;
    const grp = (id, db, items) => `<section class="sg6 ex7-g"><header class="sg6-head">${logo(id, 'lg-20')}<h3>${id === 'sqlite' ? 'SQLite' : 'MongoDB'}</h3><code dir="ltr">${db}</code><span class="spacer"></span><span class="sg6-count">${L(`${items.length} ${id === 'sqlite' ? 'rows' : 'documents'}`, `${num(items.length)} ${id === 'sqlite' ? 'صفوف' : 'مستندات'}`)}</span></header><ul class="ex7-list">${items.map(row).join('')}</ul></section>`;
    return `<div class="j7-intro"><h3>${L('What step 4 should do', 'ما يجب أن تفعله الخطوة 4')}</h3><p>${L('After the Preview, Sendproof compares what the step wrote with this list. A difference passes only when an approved-difference record covers it.', 'بعد المعاينة يقارن Sendproof ما كتبته الخطوة بهذه القائمة. لا يُقبل أي فرق إلا إذا غطّاه سجل فرق معتمد.')}</p></div>
      <div class="crit7"><span class="crit7-l">${L('Succeeds when', 'تنجح عندما')}</span><code dir="ltr">$statusCode == 201</code><span class="crit7-src">${ltr('<code>SucceedsWith(201)</code>')}</span></div>
      ${grp('sqlite', 'store-demo.db', EXPECT4.filter(e => e.store === 'sqlite'))}
      ${grp('mongodb', 'store', EXPECT4.filter(e => e.store === 'mongodb'))}
      <section class="sg6 ex7-g"><header class="sg6-head"><span class="lg-ico">${ico('mail', 'i i-sm')}</span><h3>${TB.t('res.effects')}</h3><span class="spacer"></span><span class="sg6-count">${L('1 email', '1 بريد')}</span></header>
        <ul class="ex7-list"><li class="ex7"><div class="ex7-head"><span class="op-badge">EMAIL</span><span class="ex7-key">${L('to', 'إلى')} ${fromInput('customerEmail')} · ${L('subject matches', 'الموضوع يطابق')} ${ltr('<code>shipped</code>')}</span></div></li></ul></section>
      <p class="cov6 j7-foot">${ico('file-code', 'i i-sm')}<span>${L('From', 'من')} ${ltr('<code>ShipOrderWrites.cs</code>')}. ${L('Unlisted changes fail the step; ignored:', 'التغييرات غير المدرجة تُفشل الخطوة؛ المتجاهَل:')} ${ltr('<code>__EFMigrationsHistory</code>')}.</span></p>`;
  }

  const FIND = {
    match: ['check', 'ok', L('Match', 'مطابق')], differs: ['ne', 'bad', L('Differs', 'مختلف')], missing: ['minus-circle', 'bad', L('Missing', 'مفقود')],
    extra: ['plus-circle', 'bad', L('Extra', 'زائد')], approved: ['badge-check', 'ad', L('Approved', 'معتمد')], unchecked: ['circle-dashed', 'muted', L('Not checked', 'لم يُفحص')],
  };
  const fTag = k => `<span class="fd7 is-${FIND[k][1]}">${ico(FIND[k][0], 'i i-sm')}${FIND[k][2]}</span>`;
  const adChip = id => `<a href="#ad-${id}" class="adc7">${ico('badge-check', 'i i-sm')}${ltr(id)}</a>`;

  /** One expected write and what was written, field by field. rows: [state, field, expected, actual, note]. */
  function cmpCard({ kind, store, op, t, key, rows = [], body = '', foot = true }) {
    return `<article class="cf7 is-${kind}">
      <header class="cf7-head">${logo(store, 'lg-16')}<span class="cf7-t" dir="ltr">${t}</span>${opBadge(op)}${key ? `<span class="faint tc-key"><span class="k">${key[0]}</span> ${ltr(key[1])}</span>` : ''}<span class="spacer"></span>${fTag(kind)}</header>
      ${rows.length ? `<div class="cf7-grid" role="table" aria-label="${esc(t)}">
        <div class="cf7-row is-th" role="row"><span role="columnheader" class="mk"><span class="sr-only">${L('Result', 'النتيجة')}</span></span><span role="columnheader">${L('Field', 'الحقل')}</span><span role="columnheader">${L('Expected', 'المتوقَّع')}</span><span role="columnheader">${L('Written', 'المكتوب')}</span></div>
        ${rows.map(([st, k, e, a, note]) => `<div class="cf7-row is-${st}" role="row"><span class="mk" role="cell">${st === 'bad' ? ico('ne', 'i i-sm') : st === 'ad' ? ico('badge-check', 'i i-sm') : ico('check', 'i i-sm')}<span class="sr-only">${st === 'bad' ? FIND.differs[2] : st === 'ad' ? FIND.approved[2] : FIND.match[2]}</span></span><code class="k" role="cell" dir="ltr">${k}</code><span class="e" role="cell">${e}</span><span class="a" role="cell">${a}${note ? `<span class="cf7-note">${note}</span>` : ''}</span></div>`).join('')}
      </div>` : ''}
      ${body}
      ${foot ? `<footer class="cf7-foot"><button class="btn btn-sm" type="button">${ico('badge-check', 'i i-sm')}${L('Draft approved difference', 'صُغ فرقًا معتمدًا')}</button><button class="btn btn-ghost btn-sm" type="button">${ico('db', 'i i-sm')}${L('Show in Database', 'اعرض في قاعدة البيانات')}</button></footer>` : ''}
    </article>`;
  }
  const v = s => ltr(`<span class="j7-v">${s}</span>`);
  const shipCard = () => cmpCard({
    kind: 'differs', store: 'sqlite', op: 'insert', t: 'Shipments', key: ['Id', SHIP.short],
    rows: [
      ['bad', 'ServiceLevel', `${v('Express')}<span class="src7">${fromInput('shippingMethod')}</span>`, v('Standard')],
      ['ad', 'Carrier', v('DHL'), v('DHL Express'), adChip('AD-0011')],
      ['ok', 'OrderId', `${v(ORDER.short)}<span class="src7">${fromStep(1, 'orderId')}</span>`, v(ORDER.short)],
      ['ok', 'TrackingNumber', `${L('matches', 'يطابق')} ${ltr('<code>^JD\\d{12}$</code>')}`, v(SHIP.tracking)],
    ],
  });
  const missCard = () => cmpCard({
    kind: 'missing', store: 'sqlite', op: 'delete', t: 'StockReservations', key: ['OrderId', ORDER.short],
    body: `<div class="cf7-miss"><div><span class="cf7-lbl">${L('Expected', 'المتوقَّع')}</span><p>${L('Delete the row whose', 'حذف الصف الذي')} <code dir="ltr">OrderId</code> ${L('is', 'قيمته')} ${v(ORDER.short)}</p><p>${fromStep(1, 'orderId')}</p></div>
      <div class="is-none"><span class="cf7-lbl">${L('Written', 'المكتوب')}</span><p><strong>${L('No matching change', 'لا يوجد تغيير مطابق')}</strong></p><p>${L('Nothing in', 'لم يتغيّر شيء في')} <code dir="ltr">StockReservations</code> ${L('changed in this step.', 'في هذه الخطوة.')}</p></div></div>`,
  });
  const AD = {
    'AD-0011': { step: 4, title: ['Shipments', 'Carrier', 'DHL', 'DHL Express'], reason: 'The carrier catalog renamed DHL to DHL Express in 2.1. Expectations still say DHL until they’re re-recorded.', by: 'Sam Support', on: '12 Nov 2026', exp: '31 Dec 2026', left: 39, link: '#412' },
    'AD-0007': { step: 1, extra: true, title: ['AuditEvents', null, null, '+ 1 row'], reason: 'Since 2.1, Create order writes an AuditEvents row. It joins the expectations in the next release.', by: 'Sam Support', on: '3 Nov 2026', exp: '31 Dec 2026', left: 39, link: '#398' },
    'AD-0004': { step: 3, title: ['Payments', 'ProviderReference', 'pi_…', 'ch_…'], reason: 'The payment sandbox briefly returned charge IDs instead of intent IDs.', by: 'Ada Admin', on: '28 Oct 2026', exp: '30 Nov 2026', left: 8, link: '#371' },
  };
  function adCard(id, { unused = false } = {}) {
    const a = AD[id];
    const [tbl, fld, from, to] = a.title;
    const what = a.extra ? `${ltr(`<code>${tbl}</code>`)} · ${L('extra row', 'صف زائد')}` : `${ltr(`<code>${tbl}.${fld}</code>`)} · ${v(from)} → ${v(to)}`;
    return `<article class="ad7${unused ? ' is-unused' : ''}" id="ad-${id}">
      <header class="ad7-head">${adChip(id)}<span class="ad7-what">${what}</span><span class="spacer"></span><span class="ad7-step">${L('Step', 'الخطوة')} ${num(a.step)}</span></header>
      <p class="ad7-reason" lang="en">${esc(a.reason)}</p>
      <p class="ad7-meta"><span title="${a.on}">${L(`Approved by ${a.by}`, `اعتمده ${a.by}`)}</span><span class="sep" aria-hidden="true">·</span><span class="${a.left < 10 ? 'is-soon' : ''}" title="${a.exp}">${L(`Expires in ${a.left} days`, `ينتهي بعد ${num(a.left)} يومًا`)}</span><span class="sep" aria-hidden="true">·</span><a href="#" dir="ltr">${a.link}</a></p>
      ${unused ? `<p class="ad7-unused">${ico('info', 'i i-sm')}<span>${L('Nothing in this run needed it. If that holds, remove it from', 'لم يحتج إليه شيء في هذا التشغيل. إن استمر ذلك فاحذفه من')} ${ltr('<code>StoreApprovedDifferences.cs</code>')}.</span></p>` : ''}
    </article>`;
  }
  const matched = () => {
    const rows = [
      [logo('sqlite', 'lg-14'), opBadge('update'), 'Orders', `Status ${v('Paid')} → ${v('Shipped')}`],
      [logo('sqlite', 'lg-14'), opBadge('insert'), 'InventoryMovements', `Quantity ${v('−2')} · Reason ${v('Shipped')}`],
      [logo('mongodb', 'lg-14'), opBadge('update'), 'orders', `status ${v('Paid')} → ${v('Shipped')}`],
      [logo('mongodb', 'lg-14'), opBadge('insert'), 'order_events', `type ${v('order.shipped')}`],
      [`<span class="lg-ico">${ico('mail', 'i i-sm')}</span>`, '<span class="op-badge">EMAIL</span>', 'OrderShippedNotification', v('priya.raman@example.com')],
    ];
    return `<ul class="mt7">${rows.map(([mark, badge, t, d]) => `<li><span class="mt7-ok">${ico('check', 'i i-sm')}<span class="sr-only">${FIND.match[2]}</span></span>${mark}<span class="mt7-t" dir="ltr">${t}</span>${badge}<span class="mt7-d">${d}</span></li>`).join('')}
      <li class="is-crit"><span class="mt7-ok">${ico('check', 'i i-sm')}</span><span class="crit7-l">${L('Succeeds when', 'تنجح عندما')}</span><code dir="ltr">$statusCode == 201</code><span class="mt7-d">${v('201')}</span></li></ul>`;
  };
  function compare() {
    return `<div class="vd7 is-fail" role="status"><span class="vd7-ico">${ico('circle-x')}</span><div class="vd7-text"><h3>${L('Step 4 failed', 'فشلت الخطوة 4')}</h3>
        <p>${L('The shipment was written with the wrong service level, and the stock reservation wasn’t deleted.', 'كُتبت الشحنة بمستوى خدمة خاطئ، ولم يُحذف حجز المخزون.')}</p></div></div>
      <div class="tl7"><div class="segmented sm" role="radiogroup" aria-label="${L('Show', 'اعرض')}">
        <button role="radio" aria-checked="true">${L('All', 'الكل')}<span class="tl7-n">${num(8)}</span></button>
        <button role="radio" aria-checked="false"><span class="tl7-dot is-bad" aria-hidden="true"></span>${L('Problems', 'المشكلات')}<span class="tl7-n">${num(2)}</span></button>
        <button role="radio" aria-checked="false"><span class="tl7-dot is-ad" aria-hidden="true"></span>${L('Approved', 'معتمد')}<span class="tl7-n">${num(1)}</span></button>
        <button role="radio" aria-checked="false"><span class="tl7-dot is-ok" aria-hidden="true"></span>${L('Match', 'مطابق')}<span class="tl7-n">${num(5)}</span></button></div>
        <span class="spacer"></span><span class="tl7-src">${L('7 expected · 5 written', '7 متوقَّعة · 5 مكتوبة')}</span></div>
      ${sectionLabel(L('Problems', 'المشكلات'))}
      ${shipCard()}${missCard()}
      ${sectionLabel(L('Approved differences', 'الفروق المعتمدة'))}
      ${adCard('AD-0011')}
      ${sectionLabel(L('Matched', 'المطابقة'))}
      ${matched()}`;
  }

  // The board (journeys.html) builds from the same pieces, so it can't drift from the screens.
  window.SP7 = { cmpCard, shipCard, missCard, adCard, fTag, matched, railList, sidebar, STEPS, L, v, ltr, opBadge, fromStep };

  /* =====================================================================
     Panes
     ===================================================================== */
  const main = document.querySelector('main.request');
  const aside = document.querySelector('section.pane.response');
  const side = document.querySelector('nav.sidebar');
  const set = (el, html) => { if (el) el.innerHTML = html; };
  const scene = q.jv || 'overview';
  document.title = 'Sendproof · v7 journeys mock';
  // The phone's pane switch names what each side holds in a journey.
  const SW = { overview: [L('Journey', 'الرحلة'), L('Runs', 'التشغيلات')], summary: [L('Summary', 'الملخص'), L('Differences', 'الفروق')], empty: [L('Journeys', 'الرحلات'), L('Runs', 'التشغيلات')], loading: [L('Journey', 'الرحلة'), L('Runs', 'التشغيلات')] }[scene] || [L('Step', 'الخطوة'), L('Result', 'النتيجة')];
  if (scene !== 'spec') document.querySelectorAll('[data-switch]').forEach(b => { b.textContent = b.dataset.switch === 'request' ? SW[0] : SW[1]; });
  // The mode switch sits in the top bar after the environment, on every v7 screen. jv=spec shows
  // Specification mode: the operation screen exactly as before, with the switch above it.
  document.querySelector('.topbar .env')?.insertAdjacentHTML('afterend', `<span class="mode7-wrap desktop-only">${modeSwitch(scene === 'spec' ? 'spec' : 'journeys')}</span>`);
  if (scene === 'spec') {
    if (q.drawer) side?.insertAdjacentHTML('afterbegin', `<div class="mode7-drawer">${modeSwitch('spec')}</div>`);
    return;
  }
  if (!main || !aside || !side) return;

  const runFor = { step: RUNS.preview, result: RUNS.result, summary: RUNS.summary, refused: RUNS.refused }[scene] || null;
  side.outerHTML = sidebar({ run: runFor, empty: scene === 'empty', loading: scene === 'loading' });

  /* ---------- Overview ---------- */
  const V = TB.v5;
  function inputsForm(compact) {
    const used = (...ns) => L(ns.length === 1 ? `Used in step ${ns[0]}` : `Used in steps ${ns.join(' and ')}`, ns.length === 1 ? `تُستخدم في الخطوة ${num(ns[0])}` : `تُستخدم في الخطوتين ${ns.map(num).join(' و')}`);
    const f = [
      { name: 'customerId', kind: 'lookup', label: 'customerId', type: 'uuid', desc: 'The customer placing the order.', picked: ['C', 'Priya Raman', 'priya.raman@example.com · EUR'], status: used(1) },
      { name: 'variantId', kind: 'lookup', label: 'variantId', type: 'uuid', desc: 'The variant to order. It must be active and in stock.', picked: ['V', 'Merino Crew Sweater, Heather Grey / M', 'APP-MCS-HGR-M · 41 in stock'], status: used(1, 4) },
      { name: 'quantity', kind: 'number', label: 'quantity', type: 'int32', desc: 'How many units.', value: '2', mono: true, half: true, status: used(1) },
      { name: 'unitPrice', kind: 'money', label: 'unitPrice', type: 'decimal', desc: 'The price per unit.', value: '71.10', currency: 'EUR', half: true, status: used(1) },
      { name: 'shippingMethod', kind: 'radio', label: 'shippingMethod', type: 'ShippingMethod', desc: 'How the order is delivered.', value: 'Express', options: [{ v: 'Standard' }, { v: 'Express' }, { v: 'Same day' }], status: used(1, 4) },
      { name: 'carrier', kind: 'select', label: 'carrier', type: 'string', desc: 'The carrier that collects the parcel.', value: 'DHL Express', options: [{ v: 'DHL Express' }], status: used(4) },
    ];
    return `<div class="fields f5s${compact ? ' j7-compact' : ''}">${f.map(x => V.field({ state: 'rest', ...x })).join('')}</div>`;
  }
  function stepsList() {
    const what = st => st.reads ? `<span class="js7-reads">${L('reads only', 'قراءة فقط')}</span>`
      : `<span class="js7-writes">${st.writes.map(([n, k]) => L(`${n} ${k === 'rows' ? (n === '1' ? 'row' : 'rows') : k === 'documents' ? 'documents' : 'email'}`, `${num(+n)} ${k === 'rows' ? 'صفوف' : k === 'documents' ? 'مستندات' : 'بريد'}`)).join(' · ')}</span>`;
    // Values from earlier steps are named (they're what makes it a journey); values from the
    // journey's inputs are counted, so a step with five inputs doesn't read as five arrows.
    const binds = st => {
      const fromSteps = st.binds.filter(([, from]) => from !== 'in');
      const inputs = st.binds.filter(([, from]) => from === 'in');
      return [...fromSteps.map(([f, from, out]) => `<span class="js7-b" title="$steps.${STEPS[from - 1].id}.outputs.${out || f}">${ico('bind', 'i i-sm i-dir')}<code dir="ltr">${f}</code><span class="js7-from">${L('from step', 'من الخطوة')} ${num(from)}</span></span>`),
        inputs.length ? `<span class="js7-b is-in" title="${inputs.map(([f]) => f).join(', ')}">${inputs.length === 1 ? `<code dir="ltr">${inputs[0][0]}</code><span class="js7-from">${L('from inputs', 'من المدخلات')}</span>` : L(`${inputs.length} values from inputs`, `${num(inputs.length)} قيم من المدخلات`)}</span>` : ''].join('');
    };
    return `<ol class="js7">${STEPS.map(st => `<li class="js7-step">
      <span class="js7-node" aria-hidden="true">${num(st.n)}</span>
      <div class="js7-main">
        <div class="js7-l1"><a href="#" class="js7-op" lang="en">${st.op}</a><span class="js7-sum"><code dir="ltr">${st.ok}</code>${what(st)}</span></div>
        <div class="js7-l2">${METHOD(st.method)}<code class="js7-path" dir="ltr">${esc(st.path)}</code></div>
        <div class="js7-l3">${binds(st)}${st.criteria ? `<span class="js7-b is-crit" title="${esc(st.criteria)}">${ico('check', 'i i-sm')}${L('expects status Shipped', 'يتوقّع الحالة Shipped')}</span>` : ''}</div>
      </div>
    </li>`).join('')}</ol>`;
  }
  function overviewMain() {
    return `${ctx([[L('Journeys', 'الرحلات'), false, false], ['Order to shipment', true]], `<div class="segmented view-switch" role="group" aria-label="${L('View', 'العرض')}"><button aria-pressed="true">${ico('route', 'i i-sm')}${L('Overview', 'نظرة عامة')}</button><button aria-pressed="false">${ico('code', 'i i-sm')}Arazzo</button></div>`)}
      <div class="pane-scroll"><div class="op-head j7-head">
        <div class="op-title-row"><h1 class="op-title" lang="en">Order to shipment</h1></div>
        <p class="op-desc" lang="en">Places an order for a customer, finds its payment, captures it, ships the parcel and checks that the order reads Shipped.</p>
        <div class="op-meta"><span class="pill">${ico('shield', 'i i-sm')}<span class="ltr">admin or support</span></span><span class="pill j7-stores">${logo('sqlite', 'lg-14')}SQLite${logo('mongodb', 'lg-14')}MongoDB</span><a href="#" class="pill j7-src-pill" title="${L('Defined in Journeys/OrderToShipmentJourney.cs', 'معرَّفة في Journeys/OrderToShipmentJourney.cs')}">${ico('braces', 'i i-sm')}${ltr('OrderToShipmentJourney')}</a></div>
      </div>
      <div class="form j7-body">
        ${sectionLabel(L('Steps', 'الخطوات'))}
        ${stepsList()}
        ${sectionLabel(L('Inputs', 'المدخلات'), `<span class="j7-sl-end">${L('From', 'من')} ${ltr('<code>OrderToShipmentInputs</code>')}</span>`)}
        ${inputsForm()}
        ${sectionLabel(L('Ends with', 'تنتهي بـ'))}
        <div class="j7-ends"><p>${L('Step 5 reads the order back and expects', 'تقرأ الخطوة 5 الطلب وتتوقّع')} <code dir="ltr">$response.body#/status == "Shipped"</code>.</p>
          <dl class="j7-outs"><div><dt>${L('Outputs', 'المخرجات')}</dt><dd>${['orderId', 'orderNumber', 'shipmentId', 'trackingNumber'].map(o => `<code dir="ltr">${o}</code>`).join('')}</dd></div></dl></div>
      </div></div>
      <div class="actionbar"><span class="status">${ico('undo', 'i i-sm i-dir')}<span>${L('Preview rolls back', 'المعاينة تتراجع')}</span></span>
        <button class="btn btn-run btn-send" type="button" aria-keyshortcuts="${aks('shift', 'mod', 'enter')}">${ico('send', 'i i-sm i-dir')}${L('Send run', 'تشغيل بالإرسال')}${kbd('shift', 'mod', 'enter')}</button>
        <button class="btn btn-primary btn-run btn-preview" type="button" aria-keyshortcuts="${aks('mod', 'enter')}">${ico('play', 'i i-sm i-dir')}${L('Preview run', 'تشغيل بالمعاينة')}${kbd('mod', 'enter')}</button></div>`;
  }
  function overviewAside() {
    const r = RUNS.summary;
    const rows = STEPS.map((st, i) => {
      const [k, sub] = r[i];
      return `<li class="lr7-row is-${k}"><span class="lr7-n">${num(st.n)}</span><span class="lr7-op" lang="en">${st.op}</span><span class="lr7-res">${k === 'fail' ? `<span class="fd7 is-bad">${ico('circle-x', 'i i-sm')}${L('2 problems', 'مشكلتان')}</span>` : `${i === 0 ? `<span class="fd7 is-ad" title="AD-0007">${ico('badge-check', 'i i-sm')}1</span>` : ''}<span class="fd7 is-ok">${ico('check', 'i i-sm')}${L('Passed', 'نجحت')}</span>`}</span><span class="lr7-t">${ltr(sub.split(' · ')[1])}</span></li>`;
    }).join('');
    const hist = [
      [L('Today, 14:02', 'اليوم، 14:02'), 'Ada Admin', 'preview', 'fail', L('Failed at step 4', 'فشل في الخطوة 4'), '412 ms', true],
      [L('Today, 11:40', 'اليوم، 11:40'), 'checkout-qa', 'preview', 'fail', L('Failed at step 4', 'فشل في الخطوة 4'), '398 ms', false, true],
      [L('20 Nov, 16:15', '20 نوفمبر، 16:15'), 'Ada Admin', 'send', 'pass', L('Passed · 1 approved', 'نجح · 1 معتمد'), '1.2 s'],
      [L('18 Nov, 09:30', '18 نوفمبر، 09:30'), 'checkout-qa', 'preview', 'pass', L('Passed · 1 approved', 'نجح · 1 معتمد'), '405 ms', false, true],
    ];
    return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${L('Last run', 'آخر تشغيل')}</strong><span class="status-code danger">${ico('circle-x', 'i i-sm')}${L('Failed at step 4', 'فشل في الخطوة 4')}</span><span class="metric">${ltr('412 ms')}</span><span class="spacer"></span><button class="btn btn-sm" type="button">${L('Open run', 'افتح التشغيل')}${ico('arrow-right', 'i i-sm i-dir')}</button></div>
      <div class="pane-scroll"><div class="result-body j7-last">
        <p class="j7-meta">${ico('flask', 'i i-sm')}<span>${L('Preview run · Ada Admin · today, 14:02:07 · rolled back', 'تشغيل بالمعاينة · Ada Admin · اليوم، 14:02:07 · تم التراجع')}</span></p>
        <ol class="lr7-list">${rows}</ol>
        <div class="j7-probs"><h3>${L('Problems in step 4', 'مشكلات الخطوة 4')}</h3><ul>
          <li>${fTag('differs')}<span>${ltr('<code>Shipments.ServiceLevel</code>')}: ${L('expected', 'المتوقَّع')} ${v('Express')}, ${L('written', 'المكتوب')} ${v('Standard')}</span></li>
          <li>${fTag('missing')}<span>${ltr('<code>StockReservations</code>')}: ${L('expected a delete, nothing changed', 'متوقَّع حذف، ولم يتغيّر شيء')}</span></li></ul></div>
        ${sectionLabel(L('Earlier runs', 'تشغيلات سابقة'))}
        <ul class="hr7">${hist.slice(1).map(([when, who, mode, k, label, t, , agent]) => `<li><span class="hr7-ico is-${k === 'pass' ? 'ok' : 'danger'}">${ico(k === 'pass' ? 'circle-check' : 'circle-x', 'i i-sm')}</span><span class="hr7-l"><span class="hr7-a">${label}</span><span class="hr7-b">${mode === 'send' ? `${ico('send', 'i i-sm i-dir')}${L('Send', 'إرسال')}` : `${ico('flask', 'i i-sm')}${L('Preview', 'معاينة')}`} · ${agent ? `${ico('bot', 'i i-sm')}<span lang="en">${who}</span> ${L('via MCP', 'عبر MCP')}` : `<span lang="en">${who}</span>`} · ${when}</span></span><span class="hr7-t">${ltr(t)}</span></li>`).join('')}</ul>
      </div></div>${resultBar(L('Runs are kept in this browser · 4 of 20', 'تُحفظ التشغيلات في هذا المتصفح · 4 من 20'), 'clock')}`;
  }

  /* ---------- Step (before and after it runs) ---------- */
  function stepForm() {
    let html = `<form class="form" novalidate onsubmit="return false"><fieldset><legend class="section-label">Path <span class="rule" aria-hidden="true"></span></legend><div class="fields f5s">${V.field({ name: 'orderId', kind: 'lookup', label: 'orderId', type: 'uuid', desc: 'The order to ship.', picked: ['O', ORDER.number, '€142.20 · Priya Raman · Paid'], status: `${L('Sends', 'تُرسل')} ${ltr(`<code>${ORDER.short}</code>`)} · ${ltr('<code>$steps.createOrder.outputs.orderId</code>')}` })}</div></fieldset>
      <fieldset><legend class="section-label">Body <span class="rule" aria-hidden="true"></span></legend><div class="fields f5s">
        ${V.field({ name: 'carrier', kind: 'select', label: 'carrier', type: 'string', desc: 'The carrier that collects the parcel.', value: 'DHL Express', options: [{ v: 'DHL Express' }], status: ltr('<code>$inputs.carrier</code>') })}
        ${V.field({ name: 'notifyCustomer', kind: 'radio', label: 'notifyCustomer', type: 'boolean', optional: true, desc: 'Whether the customer gets the shipping email.', value: 'true', options: [{ v: 'true' }, { v: 'false' }], status: L('Set by the journey', 'حدّدته الرحلة') })}
        ${V.field({ name: 'items', kind: 'text', label: 'items', type: 'array of objects', optional: true, desc: 'The order lines to put in the parcel. Leave out to ship everything that is left.', value: '', placeholder: L('Ships every line that’s left', 'تُشحن كل البنود المتبقية'), status: L('Not sent', 'لا تُرسل') })}
      </div></fieldset></form>`;
    html = bindChip(html, 'orderId', `<span class="bind7">${ico('bind', 'i i-sm i-dir')}${L('From step 1', 'من الخطوة 1')} · ${ltr('<code>orderId</code>')}</span>`);
    html = bindChip(html, 'carrier', `<span class="bind7 is-in">${ico('bind', 'i i-sm i-dir')}${L('Journey input', 'مُدخل الرحلة')}</span>`);
    html = bindChip(html, 'notifyCustomer', `<span class="bind7 is-fixed">${L('Fixed', 'ثابت')}</span>`);
    return html;
  }
  function stepMain(mode, after) {
    const reqTabs = `<div class="tabs" role="tablist" aria-label="Request">${tab('Body')}${tab('Params', { selected: true, count: 1 })}${tab('Headers', { count: 5 })}${tab('Auth')}${tab('Code')}</div>`;
    const status = after
      ? `<span class="status is-bad7">${ico('circle-x', 'i i-sm')}<span>${L('Step 4 failed', 'فشلت الخطوة 4')}</span></span>`
      : mode === 'send'
        ? `<span class="status">${ico('db', 'i i-sm')}<span>${L('Commits for real', 'يحفظ فعليًا')}</span></span>`
        : `<span class="status">${ico('bind', 'i i-sm i-dir')}<span>${L('From earlier steps', 'من الخطوات السابقة')}</span></span>`;
    const buttons = mode === 'send'
      ? `<button class="btn btn-run btn-send" type="button" aria-keyshortcuts="${aks('mod', 'enter')}">${ico('flask', 'i i-sm')}${L('Preview step 4', 'عاين الخطوة 4')}${kbd('mod', 'enter')}</button>
         <button class="btn btn-primary btn-run" type="button" aria-keyshortcuts="${aks('shift', 'mod', 'enter')}">${ico('send', 'i i-sm i-dir')}${L('Send step 4', 'أرسل الخطوة 4')}${kbd('shift', 'mod', 'enter')}</button>`
      : `<button class="btn btn-run btn-send" type="button" aria-keyshortcuts="${aks('alt', 'mod', 'enter')}">${ico('forward', 'i i-sm i-dir')}${L('Run to end', 'شغّل حتى النهاية')}${kbd('alt', 'mod', 'enter')}</button>
         <button class="btn btn-primary btn-run btn-preview" type="button" aria-keyshortcuts="${aks('mod', 'enter')}">${ico('flask', 'i i-sm')}${after ? L('Preview step 5', 'عاين الخطوة 5') : L('Preview step 4', 'عاين الخطوة 4')}${kbd('mod', 'enter')}</button>`;
    const run = after ? RUNS.result : mode === 'send' ? RUNS.preview : RUNS.preview;
    return `${ctx([['Order to shipment'], [`${num(4)} · Ship order`, true]], stepNav(4))}
      ${stepStrip(4, run, mode)}
      <div class="pane-scroll"><div class="op-head">
        <div class="op-title-row"><h1 class="op-title" lang="en">Ship order</h1></div>
        <p class="op-desc" lang="en">Books a carrier, creates the parcel and takes its units out of stock.</p>
        <div class="urlbar"><span class="method m-post">POST</span><span class="url"><span class="base">http://127.0.0.1:5189</span>/api/v2/orders/<span class="token is-bound7" title="${ORDER.id}">${ico('bind', 'i i-sm')}orderId</span>/shipments</span>${copyBtn('Copy URL', { size: 'btn-xs' })}</div>
      </div>${reqTabs}${stepForm()}</div>
      <div class="actionbar">${status}${buttons}</div>`;
  }
  function stepAside(after) {
    if (!after) {
      return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${L('Step 4', 'الخطوة 4')}</strong><span class="metric">${L('Not run yet', 'لم تُشغَّل بعد')}</span><span class="spacer"></span></div>
        ${resultTabs(0, 7)}
        <div class="pane-scroll" role="tabpanel"><div class="result-body">${expectList()}</div></div>${resultBar(L('Step 3 previewed at 14:02:08 · session held', 'عوينت الخطوة 3 الساعة 14:02:08 · الجلسة محجوزة'), 'clock')}`;
    }
    return `<div class="resp-head" role="status"><span class="pill pill-accent">${ico('flask', 'i i-sm')}${TB.t('res.preview')}</span><span class="status-code ok">${ico('check', 'i i-sm')}${ltr('201 Created')}</span><span class="metric">${ltr('58 ms · 2.1 kB')}</span><span class="spacer"></span>${copyBtn(TB.t('copy.curl'), { keys: aks('shift', 'mod', 'C') })}<button class="btn btn-ghost btn-icon btn-sm j7-rerun" type="button" aria-label="${L('Re-run step 4 in the session', 'أعد تشغيل الخطوة 4 في الجلسة')}" title="${L('Re-run step 4 in the session', 'أعد تشغيل الخطوة 4 في الجلسة')}">${ico('refresh', 'i i-sm')}</button></div>
      ${resultTabs(0, 7, L('2 problems', 'مشكلتان'))}
      <div class="pane-scroll" role="tabpanel"><div class="result-body j7-cmp">${compare()}</div></div>${resultBar(L(`Previewed in the session at 14:02:09 · run ${RUN}`, `عوينت في الجلسة الساعة 14:02:09 · التشغيل ${RUN}`))}`;
  }

  /* ---------- Run summary ---------- */
  function summaryMain() {
    const r = RUNS.summary;
    // One row per step, one line each: the step, its findings as counts, where it sat in the
    // run's 412 ms, and its time. The failed step opens in place to say what went wrong.
    const RUN_MS = 412;
    const AT = [38, 110, 136, 215, 338]; // each step's start, in ms from the run's start
    const ok = n => `<span class="fd7 is-ok" title="${L(`${n} matched`, `${num(n)} مطابقة`)}">${ico('check', 'i i-sm')}${num(n)}</span>`;
    const ad = n => `<span class="fd7 is-ad" title="${L(`${n} covered by an approved difference`, `${num(n)} يغطيه فرق معتمد`)}">${ico('badge-check', 'i i-sm')}${num(n)}</span>`;
    const bad = n => `<span class="fd7 is-bad" title="${L(`${n} problems`, `${num(n)} مشكلات`)}">${ico('circle-x', 'i i-sm')}${num(n)}</span>`;
    const CHIPS = [ok(5) + ad(1), `<span class="fd7 is-muted" title="${L('Reads only: nothing to compare', 'قراءة فقط: لا شيء للمقارنة')}">${ico('eye', 'i i-sm')}${L('Reads', 'قراءة')}</span>`, ok(3), bad(2) + ad(1) + ok(5), ok(1)];
    const detail = `<div class="sm8-detail" id="sm8-d4">
        <ul>
          <li>${fTag('differs')}<code dir="ltr">Shipments.ServiceLevel</code><span class="sm8-dv">${ltr(`${v('Express')}<span class="sm8-arr" aria-hidden="true">→</span>${v('Standard')}`)}</span></li>
          <li>${fTag('missing')}<code dir="ltr">StockReservations</code><span class="sm8-dv">${L('Row not deleted', 'لم يُحذف الصف')}</span></li>
          <li>${fTag('approved')}<code dir="ltr">Shipments.Carrier</code><span class="sm8-dv">${ltr(`${v('DHL')}<span class="sm8-arr" aria-hidden="true">→</span>${v('DHL Express')}<span class="sm8-by">AD-0011</span>`)}</span></li>
        </ul>
        <a href="#" class="btn btn-sm sm8-open">${L('Open step 4', 'افتح الخطوة 4')}${ico('arrow-right', 'i i-sm i-dir')}</a>
      </div>`;
    const rows = STEPS.map((st, i) => {
      const [k, sub] = r[i];
      const fail = k === 'fail';
      const ms = +sub.split(' · ')[1].replace(' ms', '');
      return `<li class="${fail ? 'is-fail' : ''}"><a href="#" class="sm8-row is-${k}"${fail ? ' aria-expanded="true" aria-controls="sm8-d4"' : ''}>
        <span class="sm8-node" aria-hidden="true">${num(st.n)}</span>
        <span class="sm8-op">${METHOD(st.method)}<span class="sm8-name" lang="en">${st.op}</span><span class="sr-only">, ${L(`step ${st.n}`, `الخطوة ${st.n}`)}, ${fail ? L('failed', 'فشلت') : L('passed', 'نجحت')}</span></span>
        <span class="sm8-chips">${CHIPS[i]}</span>
        <span class="sm8-wf" aria-hidden="true" title="${L(`Started at ${AT[i]} ms`, `بدأت عند ${AT[i]} مللي ثانية`)}"><span style="inset-inline-start:${(AT[i] / RUN_MS * 100).toFixed(2)}%;inline-size:${(ms / RUN_MS * 100).toFixed(2)}%"></span></span>
        <span class="sm8-t">${ltr(`${ms} ms`)}</span>
        ${ico(fail ? 'chevron-down' : 'chevron-right', `i i-sm sm8-chev${fail ? '' : ' i-dir'}`)}
      </a>${fail ? detail : ''}</li>`;
    }).join('');
    const list = (rows) => `<ul class="sm8-list">${rows.map(([mark, name, what, state]) => `<li>${mark}<span class="sm8-ln">${name}</span><span class="sm8-lw">${what}</span><span class="sm8-tag">${state}</span></li>`).join('')}</ul>`;
    const out = (k, val) => `<li><code class="sm8-ok" dir="ltr">${k}</code><code class="sm8-ov" dir="ltr">${val}</code>${copyBtn(L(`Copy ${k}`, `انسخ ${k}`), { size: 'btn-xs' })}</li>`;
    return `${ctx([['Order to shipment'], [L(`Run ${RUN}`, `التشغيل ${RUN}`), true, false]], `<button class="btn btn-ghost btn-xs back-btn">${ico('arrow-left', 'i i-sm i-dir')}<span class="back-label">${L('Back to the journey', 'عودة إلى الرحلة')}</span></button>`)}
      <div class="pane-scroll"><div class="op-head sm8-head">
        <h1 class="op-title sm8-h">${ico('circle-x', 'i')}<span>${L('Failed at step 4 of 5', 'فشل في الخطوة 4 من 5')}</span></h1>
        <p class="op-desc">${L('Ship order used the wrong service level and kept the stock reservation.', 'استخدمت Ship order مستوى خدمة خاطئًا وأبقت حجز المخزون.')}</p>
        <p class="by8"><span class="by8-in">
          <span class="by8-i"><span class="av8" aria-hidden="true">AA</span><strong lang="en">Ada Admin</strong>${L('ran a', 'شغّلت')}<strong class="by8-mode">${ico('flask', 'i i-sm')}${L('Preview', 'معاينة')}</strong></span>
          <span class="by8-i"><time datetime="2026-11-22T14:02:07" title="22 Nov 2026, 14:02:07">${L('today at 14:02', 'اليوم الساعة 14:02')}</time></span>
          <span class="by8-i"><span class="by8-dur" title="${L('Whole run, 5 steps. The last run took 398 ms.', 'التشغيل كله، 5 خطوات. استغرق التشغيل السابق 398 مللي ثانية.')}">${ico('clock', 'i i-sm')}${ltr('412 ms')}</span></span>
          <span class="by8-i">${ico('undo', 'i i-sm i-dir')}${L('rolled back', 'تم التراجع')}</span>
        </span></p>
      </div>
      <div class="form j7-body sm8-body">
        ${sectionLabel(L('Steps', 'الخطوات'), `<span class="j7-sl-end">${L('4 passed · 1 failed', '4 نجحت · 1 فشلت')}</span>`)}
        <ol class="sm8" aria-label="${L('Steps', 'الخطوات')}">${rows}</ol>
        <p class="sm8-note">${ico('info', 'i i-sm')}<span>${L('Write differences don’t stop a run, so step 5 still ran.', 'فروق الكتابة لا توقف التشغيل، لذا شُغّلت الخطوة 5.')}</span></p>
        ${sectionLabel(L('Rolled back', 'تم التراجع'), `<span class="j7-sl-end">${L('Nothing was written', 'لم يُكتب شيء')}</span>`)}
        ${list([
          [logo('sqlite', 'lg-16'), `SQLite ${ltr('<code>store-demo.db</code>')}`, L('11 changes undone', 'تراجع عن 11 تغييرًا'), `${ico('undo', 'i i-sm i-dir')}${L('Rolled back', 'تم التراجع')}`],
          [logo('mongodb', 'lg-16'), `MongoDB ${ltr('<code>store</code>')}`, L('2 changes undone', 'تراجع عن تغييرين'), `${ico('undo', 'i i-sm i-dir')}${L('Aborted', 'أُلغيت')}`],
          [`<span class="lg-ico">${ico('mail', 'i i-sm')}</span>`, L('Email', 'البريد'), L('3 held, none sent', '3 محجوزة، لم يُرسل شيء'), `${ico('x', 'i i-sm')}${L('Discarded', 'أُهملت')}`],
        ])}
        ${sectionLabel(L('Outputs', 'المخرجات'), `<span class="j7-sl-end">${L('From the rolled-back run', 'من التشغيل المتراجَع عنه')}</span>`)}
        <ul class="sm8-list sm8-outs">${out('orderNumber', ORDER.number)}${out('orderId', ORDER.id)}${out('shipmentId', SHIP.id)}${out('trackingNumber', SHIP.tracking)}</ul>
      </div></div>
      <div class="actionbar"><span class="status is-bad7">${ico('circle-x', 'i i-sm')}<span>${L('1 step failed', 'فشلت خطوة واحدة')}</span></span>
        <button class="btn btn-run btn-send" type="button" aria-keyshortcuts="${aks('shift', 'mod', 'enter')}">${ico('send', 'i i-sm i-dir')}${L('Send run', 'تشغيل بالإرسال')}${kbd('shift', 'mod', 'enter')}</button>
        <button class="btn btn-primary btn-run btn-preview" type="button" aria-keyshortcuts="${aks('mod', 'enter')}">${ico('refresh', 'i i-sm')}${L('Preview again', 'عاين مجددًا')}${kbd('mod', 'enter')}</button></div>`;
  }
  function summaryAside() {
    return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${L(`Run ${RUN}`, `التشغيل ${RUN}`)}</strong><span class="status-code danger">${ico('circle-x', 'i i-sm')}${L('Failed', 'فشل')}</span><span class="spacer"></span>${copyBtn(L('Copy run as JSON', 'انسخ التشغيل بصيغة JSON'))}<button class="btn btn-sm" type="button">${ico('download', 'i i-sm')}JUnit XML</button></div>
      <div class="tabs" role="tablist">${tab(L('Approved differences', 'الفروق المعتمدة'), { selected: true, count: 3 })}${tab(L('Inputs', 'المدخلات'), { count: 6 })}${tab(L('Timeline', 'الخط الزمني'))}</div>
      <div class="pane-scroll" role="tabpanel"><div class="result-body j7-ads">
        ${sectionLabel(L('Used in this run', 'مستخدمة في هذا التشغيل'), `<span class="j7-sl-end">${num(2)}</span>`)}
        ${adCard('AD-0007')}${adCard('AD-0011')}
        ${sectionLabel(L('Not needed this run', 'لم يُحتج إليها'), `<span class="j7-sl-end">${num(1)}</span>`)}
        ${adCard('AD-0004', { unused: true })}
        ${sectionLabel(L('Run it from a terminal or an agent', 'شغّله من الطرفية أو من وكيل'))}
        <div class="blk6-code j7-cli" dir="ltr"><pre lang="en">npx sendproof journeys run orderToShipment \\
  --mode preview --inputs inputs.json --junit report.xml</pre>${copyBtn('Copy', { size: 'btn-xs' })}</div>
        <p class="j7-mcp">${ico('bot', 'i i-sm')}<span>${L('Agents use the same runner as MCP tools:', 'تستخدم الوكلاء المشغّل نفسه كأدوات MCP:')} ${['start_run', 'run_step', 'run_remaining', 'get_run'].map(x => `<code dir="ltr">${x}</code>`).join(' ')}</span></p>
      </div></div>${resultBar(L(`Run ${RUN} · kept in this browser`, `التشغيل ${RUN} · محفوظ في هذا المتصفح`), 'clock')}`;
  }

  /* ---------- Stopped by a refusal (a Send run) ---------- */
  function refusedMain() {
    let form = `<form class="form" novalidate onsubmit="return false"><fieldset><legend class="section-label">Path <span class="rule" aria-hidden="true"></span></legend><div class="fields f5s">${V.field({ name: 'id', kind: 'lookup', label: 'id', type: 'uuid', desc: 'The payment’s ID.', picked: ['P', 'PAY-2026-000357', '€142.20 · Cara Customer · Failed'], status: `${L('Sends', 'تُرسل')} ${ltr('<code>c91e07d4…5b2a</code>')} · ${ltr('<code>$steps.findPayment.outputs.paymentId</code>')}` })}</div></fieldset>
      <fieldset><legend class="section-label">Body <span class="rule" aria-hidden="true"></span></legend><div class="fields f5s">${V.field({ name: 'amount', kind: 'money', label: 'amount', type: 'decimal', optional: true, desc: 'The amount to capture. Defaults to the full authorized amount.', value: '142.20', currency: 'EUR', status: ltr('<code>$steps.createOrder.outputs.amount</code>') })}</div></fieldset></form>`;
    form = bindChip(form, 'id', `<span class="bind7">${ico('bind', 'i i-sm i-dir')}${L('From step 2', 'من الخطوة 2')} · ${ltr('<code>paymentId</code>')}</span>`);
    form = bindChip(form, 'amount', `<span class="bind7">${ico('bind', 'i i-sm i-dir')}${L('From step 1', 'من الخطوة 1')} · ${ltr('<code>amount</code>')}</span>`);
    return `${ctx([['Order to shipment'], [`${num(3)} · Capture payment`, true]], stepNav(3))}
      ${stepStrip(3, RUNS.refused, 'send')}
      <div class="pane-scroll"><div class="op-head">
        <div class="op-title-row"><h1 class="op-title" lang="en">Capture payment</h1></div>
        <p class="op-desc" lang="en">Takes the money from an authorized payment, in full or in part. The order moves to Paid.</p>
        <div class="urlbar"><span class="method m-post">POST</span><span class="url"><span class="base">http://127.0.0.1:5189</span>/api/v2/payments/<span class="token is-bound7" title="c91e07d4-61a3-4f0b-9d2e-8a47f3c05b2a">${ico('bind', 'i i-sm')}id</span>/capture</span>${copyBtn('Copy URL', { size: 'btn-xs' })}</div>
      </div><div class="tabs" role="tablist" aria-label="Request">${tab('Body')}${tab('Params', { selected: true, count: 1 })}${tab('Headers', { count: 5 })}${tab('Auth')}${tab('Code')}</div>${form}</div>
      <div class="actionbar"><span class="status is-bad7">${ico('ban', 'i i-sm')}<span>${L('Run stopped at step 3', 'توقّف التشغيل عند الخطوة 3')}</span></span>
        <button class="btn btn-run btn-send" type="button">${ico('send', 'i i-sm i-dir')}${L('Send again', 'أرسل مجددًا')}${kbd('shift', 'mod', 'enter')}</button>
        <button class="btn btn-primary btn-run btn-preview" type="button">${ico('flask', 'i i-sm')}${L('Preview step 3', 'عاين الخطوة 3')}${kbd('mod', 'enter')}</button></div>`;
  }
  function refusedAside() {
    const problem = { type: 'https://acme.example/problems/payment-not-authorized', title: 'The payment is not authorized.', status: 409, code: 'payment_not_authorized', detail: 'Only authorized payments can be captured, and this one is Failed.' };
    const pj = '<span class="j6-p">{</span>\n' + Object.entries(problem).map(([k, x]) => `  <span class="j6-k">"${k}"</span><span class="j6-p">: </span>${typeof x === 'string' ? `<span class="j6-s">"${esc(x)}"</span>` : `<span class="j6-n">${x}</span>`}`).join('<span class="j6-p">,</span>\n') + '\n<span class="j6-p">}</span>';
    const left = [
      [logo('sqlite', 'lg-16'), opBadge('insert'), 'Orders', `${v('ORD-2026-000189')} · ${v('Pending')}`, 1],
      [logo('sqlite', 'lg-16'), opBadge('insert'), 'Payments', `${v('PAY-2026-000357')} · ${v('Failed')} · ${v('card_declined')}`, 1],
      [logo('sqlite', 'lg-16'), opBadge('insert'), 'StockReservations', `${v('APP-MCS-HGR-M')} · ${L('2 units', 'وحدتان')}`, 1],
      [`<span class="lg-ico">${ico('mail', 'i i-sm')}</span>`, '<span class="op-badge">EMAIL</span>', 'OrderReceived', `${v('cara.customer@acme.dev')} · ${L('delivered', 'سُلّم')}`, 1],
    ];
    return `<div class="resp-head" role="status"><span class="pill j7-pill-send">${ico('send', 'i i-sm i-dir')}${L('Sent', 'أُرسل')}</span><span class="status-code danger">${ico('ban', 'i i-sm')}${ltr('409 Conflict')}</span><span class="metric">${ltr('34 ms · 0.3 kB')}</span><span class="spacer"></span>${copyBtn(TB.t('copy.curl'), { keys: aks('shift', 'mod', 'C') })}</div>
      ${resultTabs(0, undefined, L('Stopped', 'متوقّفة'))}
      <div class="pane-scroll" role="tabpanel"><div class="result-body j7-stop">
        <section class="stop7" aria-labelledby="stop7-h">
          <div class="stop7-top"><span class="vd7-ico is-danger">${ico('ban')}</span><div><p class="blk6-eyebrow">${L('Journey stopped', 'توقّفت الرحلة')}</p><h3 id="stop7-h">${L('Step 3 was refused: the payment isn’t authorized', 'رُفضت الخطوة 3: الدفعة غير مصرّح بها')}</h3>
            <p>${L('The journey expects', 'تتوقّع الرحلة')} ${ltr('<code>$statusCode == 200</code>')}. ${L('The API answered 409', 'أجابت الواجهة بـ 409')} ${ltr('<code>payment_not_authorized</code>')}: <q lang="en">Only authorized payments can be captured, and this one is Failed.</q></p></div></div>
          <ul class="stop7-facts">
            <li class="is-ok">${ico('shield-check', 'i i-sm')}<span><strong>${L('This step wrote nothing.', 'لم تكتب هذه الخطوة شيئًا.')}</strong> ${L('Traced Send: 0 changes, 0 effects.', 'إرسال متتبَّع: 0 تغييرات، 0 آثار.')}</span></li>
            <li>${ico('skip', 'i i-sm i-dir')}<span><strong>${L('Steps 4 and 5 didn’t run.', 'لم تُشغَّل الخطوتان 4 و5.')}</strong> ${L('Arazzo’s default on failure is to end the workflow.', 'الإجراء الافتراضي في Arazzo عند الفشل هو إنهاء سير العمل.')}</span></li>
          </ul>
        </section>
        ${sectionLabel(L('Left in the database by steps 1 and 2', 'ما تركته الخطوتان 1 و2 في قاعدة البيانات'), `<span class="j7-sl-end is-warn">${ico('warn', 'i i-sm')}${L('Sent for real', 'أُرسلت فعليًا')}</span>`)}
        <ul class="mt7 j7-left">${left.map(([mark, badge, t, d, n]) => `<li>${mark}<span class="mt7-t" dir="ltr">${t}</span>${badge}<span class="mt7-d">${d}</span><span class="mt7-s">${L('step', 'الخطوة')} ${num(n)}</span></li>`).join('')}</ul>
        <div class="stop7-next"><button class="btn btn-sm" type="button">${METHOD('post')}<span lang="en">Cancel order</span><span class="faint">${ltr('ORD-2026-000189')}</span></button><p>${L('Opens Cancel order with this order filled in. It releases the 2 reserved units and voids the payment.', 'يفتح Cancel order مع ملء هذا الطلب. يحرّر الوحدتين المحجوزتين ويُلغي الدفعة.')}</p></div>
        <div class="blk6-raw"><div class="sql-bar"><span>${L('Response body', 'نص الاستجابة')}</span><code dir="ltr">application/problem+json</code><span class="spacer"></span>${copyBtn('Copy', { size: 'btn-xs' })}</div><pre class="sql" dir="ltr">${pj}</pre></div>
      </div></div>${resultBar(L('Sent for real at 14:20:31 as Ada Admin · traced', 'أُرسل فعليًا الساعة 14:20:31 باسم Ada Admin · متتبَّع'), 'send')}`;
  }

  /* ---------- Empty and loading ---------- */
  function emptyMain() {
    // The steps to a first journey, in code. Small C# snippets, highlighted by hand like the JSON ones.
    const k = t => `<span class="j6-k">${t}</span>`, str = t => `<span class="j6-s">${t}</span>`, p = t => `<span class="j6-p">${t}</span>`;
    const cls = `${k('public sealed class')} OrderToShipmentJourney
    ${p(':')} Journey${p('&lt;')}OrderToShipmentInputs${p('&gt;')}
${p('{')}
    ${k('protected override void')} Define(
        JourneyBuilder${p('&lt;')}OrderToShipmentInputs${p('&gt;')} journey)
    ${p('{')}
        ${k('var')} place ${p('=')} journey.Step(${str('"placeOrder"')},
            StoreOperations.Orders.Place);
        place.Set(r ${p('=&gt;')} r.Body.CustomerId,
            journey.Input(i ${p('=&gt;')} i.CustomerId));
        Ref${p('&lt;')}Guid${p('&gt;')} orderId ${p('=')} place.Output(o ${p('=&gt;')} o.Id);
        ${p('…')}
    ${p('}')}
${p('}')}`;
    const reg = `sendproof.AddJourneys(${k('typeof')}(StoreApplication).Assembly);`;
    const test = `${k('public sealed class')} JourneyTests ${p(':')} JourneyTestSuite${p('&lt;')}StoreApplication${p('&gt;')} ${p('{ }')}`;
    const code = (src) => `<div class="blk6-code" dir="ltr"><pre lang="en">${src}</pre>${copyBtn('Copy', { size: 'btn-xs' })}</div>`;
    return `${ctx([[L('Journeys', 'الرحلات'), true, false]])}
      <div class="pane-scroll"><div class="j7-empty">${state({ icon: 'route', title: L('No journeys for this API yet', 'لا توجد رحلات لهذه الواجهة بعد'), heading: 'h1',
        body: L('A journey is a set of steps that finish a task, such as taking an order through to shipment. You define one in C#: its steps, the values each passes on, and what each should write. Sendproof runs it here one step at a time, and the same journey runs in <code>dotnet test</code> and in CI.', 'الرحلة مجموعة خطوات تُنجز مهمة، مثل إيصال طلب حتى الشحن. تعرّفها بلغة C#: خطواتها، والقيم التي تمررها كل خطوة، وما يجب أن تكتبه. يشغّلها Sendproof هنا خطوة بخطوة، وتعمل الرحلة نفسها في <code>dotnet test</code> وفي CI.') })}
        <div class="j7-cta"><button class="btn btn-primary btn-sm" type="button">${ico('bot', 'i i-sm')}${L('Copy a prompt for your agent', 'انسخ موجّهًا لوكيلك')}</button><span>${L('or write the class yourself:', 'أو اكتب الصنف بنفسك:')}</span></div>
        <ol class="j7-how">
          <li><span class="n">1</span><div><strong>${L('Write a journey class', 'اكتب صنف رحلة')}</strong><p>${L('Operations, request fields and tables are typed, so a wrong value doesn’t compile.', 'العمليات وحقول الطلب والجداول مكتوبة الأنواع، فالقيمة الخاطئة لا تُترجم.')}</p>${code(cls)}</div></li>
          <li><span class="n">2</span><div><strong>${L('Register the journeys', 'سجّل الرحلات')}</strong><p>${L('At startup they become Arazzo and expected writes.', 'عند التشغيل تصبح Arazzo وكتابات متوقعة.')}</p>${code(reg)}</div></li>
          <li><span class="n">3</span><div><strong>${L('Run them as tests too', 'شغّلها كاختبارات أيضًا')}</strong><p>${L('Every journey becomes a test case, previewed in memory.', 'تصبح كل رحلة حالة اختبار، تُعايَن في الذاكرة.')}</p>${code(test)}</div></li>
        </ol>
        <p class="j7-empty-foot"><a href="#" class="link">${L('Read the journeys guide', 'اقرأ دليل الرحلات')}</a><span class="sep" aria-hidden="true">·</span><a href="#" class="link">${L('Arazzo Specification 1.1.0', 'مواصفة Arazzo 1.1.0')}</a></p>
      </div></div>
      <div class="actionbar"><span class="status">${ico('info', 'i i-sm')}<span>${L('Nothing to run yet', 'لا شيء لتشغيله بعد')}</span></span></div>`;
  }
  const emptyAside = () => `<div class="resp-head j7-rh"><strong class="j7-rh-t">${L('Runs', 'التشغيلات')}</strong></div>
    <div class="pane-scroll"><div class="result-body">${state({ icon: 'history', compact: true, title: L('Runs appear here', 'تظهر التشغيلات هنا'), body: L('Each run lists its steps, what each wrote compared with what it should have, and the approved differences it used.', 'يعرض كل تشغيل خطواته، وما كتبته كل خطوة مقارنةً بما يجب، والفروق المعتمدة التي استخدمها.') })}</div></div>${resultBar(L('No runs yet', 'لا توجد تشغيلات بعد'), 'clock')}`;
  function loadingMain() {
    const line = (w, h = '') => `<span class="sk sk-line${h}" style="inline-size:${w}"></span>`;
    return `${ctx([[L('Journeys', 'الرحلات'), false, false], [`<span class="sk sk-line" style="inline-size:9rem;display:inline-block"></span>`, true, false]])}
      <div class="progress" role="progressbar" aria-label="${L('Loading the journey', 'جارٍ تحميل الرحلة')}"></div>
      <div class="pane-scroll" aria-busy="true"><div class="op-head j7-head j7-skel">
        ${line('14rem', ' j7-sk-title')}${line('92%')}${line('64%')}
        <div class="op-meta">${['6rem', '8.5rem', '7rem', '11rem'].map(w => `<span class="sk j7-sk-pill" style="inline-size:${w}"></span>`).join('')}</div></div>
        <div class="form j7-body j7-skel">${sectionLabel(L('Steps', 'الخطوات'))}
          <ol class="js7">${[0, 1, 2, 3, 4].map(i => `<li class="js7-step"><span class="sk js7-node"></span><div class="js7-main"><div class="js7-l1">${line(['7.5rem', '6.5rem', '8.5rem', '6rem', '5.5rem'][i])}<span class="js7-sum">${line(['6.5rem', '4.5rem', '6.5rem', '9rem', '4.5rem'][i])}</span></div><div class="js7-l2">${line(['10rem', '9.5rem', '14rem', '16rem', '10.5rem'][i])}</div><div class="js7-l3"><span class="sk j7-sk-pill" style="inline-size:${['5.5rem', '8rem', '8rem', '8rem', '8rem'][i]};block-size:1.375rem"></span></div></div></li>`).join('')}</ol>
          ${sectionLabel(L('Inputs', 'المدخلات'))}
          <div class="j7-sk-fields">${['100%', '100%', '48%', '48%'].map(w => `<div class="j7-sk-field" style="inline-size:${w}">${line('5.5rem')}<span class="sk j7-sk-control"></span>${line('60%')}</div>`).join('')}</div>
        </div></div>
      <div class="actionbar"><span class="status"><span class="spinner" aria-hidden="true"></span><span>${L('Loading journeys…', 'جارٍ تحميل الرحلات…')}</span></span>
        <button class="btn btn-run btn-send" type="button" disabled>${ico('send', 'i i-sm i-dir')}${L('Send run', 'تشغيل بالإرسال')}</button>
        <button class="btn btn-primary btn-run btn-preview" type="button" disabled>${ico('play', 'i i-sm i-dir')}${L('Preview run', 'تشغيل بالمعاينة')}</button></div>`;
  }
  const loadingAside = () => `<div class="resp-head j7-rh"><strong class="j7-rh-t">${L('Last run', 'آخر تشغيل')}</strong><span class="sk sk-line" style="inline-size:7rem"></span></div>
    <div class="pane-scroll" aria-busy="true"><div class="result-body j7-last j7-skel"><span class="sk sk-line" style="inline-size:70%"></span>
      <ol class="lr7-list">${[0, 1, 2, 3, 4].map(() => `<li class="lr7-row"><span class="sk lr7-n"></span><span class="sk sk-line" style="inline-size:8rem"></span><span class="sk sk-line" style="inline-size:4.5rem"></span><span class="sk sk-line" style="inline-size:2.5rem"></span></li>`).join('')}</ol></div></div>${resultBar(L('Loading runs…', 'جارٍ تحميل التشغيلات…'), 'clock')}`;

  /* ---------- Scene dispatch ---------- */
  const SCENES = {
    overview: [overviewMain, overviewAside],
    step: [() => stepMain(q.mode === 'send' ? 'send' : 'preview', false), () => stepAside(false)],
    result: [() => stepMain('preview', true), () => stepAside(true)],
    summary: [summaryMain, summaryAside],
    refused: [refusedMain, refusedAside],
    empty: [emptyMain, emptyAside],
    loading: [loadingMain, loadingAside],
  };
  const [m, a] = SCENES[scene] || SCENES.overview;
  set(main, m());
  set(aside, a());
  main.classList.add('j7-main');
  aside.classList.add('j7-aside');
})();

// Docs view of an operation (?view=docs) and the API overview (?view=overview), built from
// the OpenAPI document in mocks/spec.js.
//
// v4: Docs fills the same two columns as Try it. The main column is the reference page; the
// right column holds the page outline and code samples. Both end with a bar at the same
// height as the action bar, so switching Try it ⇄ Docs (D) swaps content, never layout.
// Schemas expand inline (?expand=counterparty opens that $ref in place); the type name is
// a link to the model page, which keeps the operation as its breadcrumb.
// Parameters: opid=<operationId> | op=create|get|list|update|login   open=201,400 (responses)
//             expand=<dotted paths>   bodyview=example   scroll=<section id>   sample=curl|csharp|fetch
(function () {
  const { q, ico, kbd, aks, tab, copyBtn, t } = window.TB;
  const S = window.TB.schema;
  const esc = S.esc;
  const BASE = 'http://127.0.0.1:5189';

  /** Puts main and right panes in the request and response slots of the stable grid. */
  function mount(main, aside) {
    const ws = document.querySelector('.workspace');
    ws.classList.add('docs-mode');
    document.querySelector('.mobile-switch')?.remove();
    document.querySelector('[data-shell="request"]').outerHTML = main;
    document.querySelector('[data-shell="response"]').outerHTML = aside;
  }
  window.TB.mountReference = mount;

  /** Resolves parameter and response $refs from components. */
  const component = (kind, x) => x?.$ref ? S.spec.components?.[kind]?.[x.$ref.split('/').pop()] || {} : x || {};
  const jsonSchemaOf = content => content && (content['application/json'] || Object.values(content)[0])?.schema;
  const statusClass = code => /^2/.test(code) ? 'ok' : /^[45]/.test(code) ? 'err' : 'info';
  // Examples prefer real data: the first object in the captured responses (mocks/spec.js)
  // whose keys include every required property of the schema. Otherwise the schema's own
  // example, or one built from it.
  const realSamples = new WeakSet();
  function findSample(schema) {
    const r = S.resolve(schema);
    const { props, required } = S.propertiesOf(schema);
    const keys = Object.keys(props);
    if (!keys.length) return undefined;
    const need = required.size ? [...required] : keys;
    const fits = v => v && typeof v === 'object' && !Array.isArray(v) && need.every(k => k in v) && Object.keys(v).every(k => keys.includes(k));
    const stack = Object.values(window.TB_SAMPLES || {});
    while (stack.length) {
      const v = stack.shift();
      if (fits(v)) return v;
      if (v && typeof v === 'object') stack.push(...Object.values(v));
    }
    return r.examples?.[0];
  }
  const sampleFor = schema => {
    const found = S.kindOf(S.refName(schema)) === 'object' ? findSample(schema) : undefined;
    if (found && typeof found === 'object') { realSamples.add(found); return found; }
    return S.exampleOf(schema);
  };
  window.TB.sampleFor = sampleFor;
  window.TB.isRealSample = v => v && typeof v === 'object' && realSamples.has(v) && !Object.values(S.schemas).some(s => s.examples?.includes(v));

  /** A parameter group as a tree: same row anatomy as schema properties. */
  function paramTree(params, id) {
    const props = Object.fromEntries(params.map(p => [p.name, { ...(p.schema || {}), description: p.description, ...(p.example !== undefined ? { example: p.example } : {}), ...(p.deprecated ? { deprecated: true } : {}) }]));
    const schema = { type: 'object', properties: props, required: params.filter(p => p.required).map(p => p.name) };
    return `<div class="stree" role="tree" aria-label="${esc(id)}">${S.rows(schema, { id })}</div>`;
  }

  /** cURL, C# and fetch samples for the operation, with the documented example body. */
  function sample(o, lang, body) {
    const path = o.path.replace(/\{(\w+)\}/g, (_, n) => n === 'id' ? '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13' : `{${n}}`);
    const s = x => `<span class="tok-s">${esc(x)}</span>`;
    const json = body === undefined ? '' : JSON.stringify(body, null, 2);
    const hl = text => esc(text).replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-k">$1</span>$2')
      .replace(/: (&quot;.*?&quot;)/g, ': <span class="tok-s">$1</span>').replace(/: (-?\d[\d.]*)/g, ': <span class="tok-n">$1</span>');
    if (lang === 'csharp') return `<span class="tok-k">using var</span> http = <span class="tok-k">new</span> HttpClient { BaseAddress = <span class="tok-k">new</span>(${s(`"${BASE}"`)}) };
<span class="tok-k">var</span> response = <span class="tok-k">await</span> http.${o.method === 'get' ? 'GetAsync' : o.method === 'delete' ? 'DeleteAsync' : o.method === 'put' ? 'PutAsJsonAsync' : o.method === 'patch' ? 'PatchAsJsonAsync' : 'PostAsJsonAsync'}(${s(`"${path}"`)}${json ? ', request' : ''});
response.EnsureSuccessStatusCode();`;
    if (lang === 'fetch') return `<span class="tok-k">const</span> response = <span class="tok-k">await</span> fetch(${s(`'${BASE}${path}'`)}, {
  method: ${s(`'${o.method.toUpperCase()}'`)},
  credentials: ${s("'include'")},${json ? `\n  headers: { ${s("'Content-Type'")}: ${s("'application/json'")} },\n  body: JSON.stringify(body),` : ''}
});`;
    const lines = [`curl -X ${o.method.toUpperCase()} ${s(`'${BASE}${path}'`)}`];
    if (o.secured) lines.push(`  -b ${s("'.AspNetCore.Cookies=…'")}`);
    if (o.op.parameters?.some(p => component('parameters', p).name === 'Idempotency-Key')) lines.push(`  -H ${s("'Idempotency-Key: 8b1f…c2'")}`);
    if (json) lines.push(`  -H ${s("'Content-Type: application/json'")}`, `  -d '${hl(json).replace(/\n/g, '\n  ')}'`);
    return lines.join(' \\\n');
  }

  /* ---------- Docs ---------- */
  (function docs() {
    if (q.view !== 'docs') return;
    const o = window.TB.currentOp(q);
    const op = o.op;
    const params = (op.parameters || []).map(p => component('parameters', p));
    const byIn = ['path', 'query', 'header', 'cookie'].map(where => [where, params.filter(p => p.in === where)]).filter(([, list]) => list.length);
    const body = jsonSchemaOf(op.requestBody?.content);
    const bodyName = S.refName(body);
    const responses = Object.entries(op.responses || {}).map(([code, r]) => [code, component('responses', r)]);
    // The response that matters most opens first: 201 for a create, otherwise the first 2xx.
    const firstOk = (o.method === 'post' && responses.find(([c]) => c === '201')?.[0]) || responses.find(([c]) => /^2/.test(c))?.[0];
    const open = new Set((q.open || firstOk || '').split(','));
    const expanded = new Set((q.expand || '').split(',').filter(Boolean));
    const schemes = S.spec.components?.securitySchemes || {};
    const signedOut = q.auth === 'out';

    const bodyStats = body && S.stats(body);
    const bodyCard = body ? `
      <h3 id="body">${t('docs.body')} <span class="faint">· application/json ·</span> ${bodyName ? `<a class="type-link" href="#">${bodyName}</a>` : ''}</h3>
      <div class="card">
        <div class="card-head"><span>${t('docs.props', { n: bodyStats.count })} · ${t('docs.required', { n: bodyStats.required })}</span>
          <span class="end">
            <div class="segmented" role="group" aria-label="${t('docs.bodyView')}"><button aria-pressed="${q.bodyview !== 'example'}">${t('docs.schema')}</button><button aria-pressed="${q.bodyview === 'example'}">${t('docs.example')}</button></div>
            ${bodyStats.nested ? `<button class="btn btn-ghost btn-xs">${ico('chevrons-ud', 'i i-sm')}${t('expandAll')}</button>` : ''}
          </span></div>
        ${q.bodyview === 'example' ? S.jsonView(S.exampleOf(body), { label: t('docs.example') }).html : S.tree(body, { id: 'b', expanded })}
      </div>` : '';

    const responseItems = responses.map(([code, r]) => {
      const schema = jsonSchemaOf(r.content);
      const isOpen = schema && open.has(code);
      const name = schema && (S.refName(schema) || S.typeLabel(schema).text);
      const head = `<span class="slot" aria-hidden="true">${schema ? ico(isOpen ? 'chevron-down' : 'chevron-right', 'i i-sm') : ''}</span>
        <span class="code ${statusClass(code)}">${code}</span><span class="d" lang="en">${esc(S.firstSentence(r.description) || '')}</span><span class="spacer"></span>
        ${schema ? `<span class="type-link">${esc(name)}</span>` : `<span class="faint" style="font-size:var(--fs-sm)">${t('docs.noBody')}</span>`}`;
      return `<div class="resp-item">${schema
        ? `<button class="head" aria-expanded="${!!isOpen}" aria-controls="resp-${code}">${head}</button>`
        : `<div class="head">${head}</div>`}
        ${isOpen ? `<div class="body" id="resp-${code}"><div class="media">application/json<span class="spacer"></span>${S.stats(schema).nested ? `<button class="btn btn-ghost btn-xs">${ico('chevrons-ud', 'i i-sm')}${t('expandAll')}</button>` : ''}</div>${S.tree(schema, { id: 'r' + code, expanded })}</div>` : ''}
      </div>`;
    }).join('');

    const requirements = op.security || [];
    const authCards = requirements.length ? (() => {
      const scheme = Object.keys(requirements[0])[0];
      const def = schemes[scheme] || {};
      const roles = o.roles;
      return `<div class="req-list">
        <div class="req"><span class="req-ico">${ico('lock', 'i i-sm')}</span><div class="grow"><div class="t">${t('docs.signin')} <span class="tag tag-mono">${esc(scheme)}</span>${signedOut ? `<span class="tag tag-accent">${t('docs.youreOut')}</span>` : ''}</div><div class="s" lang="en">${S.md(def.description, { block: false })}</div></div>${signedOut ? `<button class="btn btn-sm btn-primary">${ico('log-in', 'i i-sm')}${t('signIn')}</button>` : ''}</div>
        ${roles.length ? `<div class="req"><span class="req-ico">${ico('shield', 'i i-sm')}</span><div class="grow"><div class="t">${t('docs.roles')} ${roles.map(r => `<span class="tag tag-mono">${esc(r)}</span>`).join(' ')}</div><div class="s">${t('docs.rolesBody', { n: roles.length })}</div></div></div>` : ''}
      </div>`;
    })() : `<p class="lede">${t('docs.public')}</p>`;

    const main = `
    <main class="pane doc-pane" id="request" aria-labelledby="doc-title">
      ${window.TB.ctxBar(q, 'op', 'docs')}
      <div class="pane-scroll" id="doc-main"><div class="doc-inner">
        <h1 id="doc-title" lang="en">${esc(o.summary)}</h1>
        <div class="doc-meta">
          <span class="method m-${o.method}">${o.method.toUpperCase()}</span><code class="ltr">${esc(o.path)}</code>
          ${o.secured ? `<span class="tag">${ico(signedOut ? 'lock' : 'shield', 'i')}${signedOut ? t('docs.needsSignin') : o.roles.length ? esc(o.roles.join(' or ')) : t('docs.signedIn')}</span>` : `<span class="tag">${ico('globe', 'i')}${t('docs.publicTag')}</span>`}
          ${o.deprecated ? `<span class="tag tag-warn">${t('nav.deprecated')}</span>` : ''}
          <span class="tag tag-mono" title="operationId">${esc(o.id)}</span>
        </div>
        ${o.deprecated ? `<div class="deprecation" role="note">${ico('warn')}<div><strong>${t('docs.deprecated')}</strong> <span lang="en">${S.md(S.firstSentence((op.description || '').replace(/^\s*\**deprecated\.?\**\s*/i, '')), { block: false })}</span></div></div>` : ''}
        <div class="prose" lang="en">${S.md(op.description) || `<p class="faint">${t('docs.noDesc')}</p>`}</div>

        <h2 id="request-h">${t('docs.request')}</h2>
        ${byIn.map(([where, list]) => `<h3 id="params-${where}">${t('docs.in.' + where)} <span class="faint">· ${list.length}</span></h3><div class="card">${paramTree(list, `${where}-params`)}</div>`).join('')}
        ${bodyCard}
        ${!byIn.length && !body ? `<p class="lede">${t('docs.noInput')}</p>` : ''}

        <h2 id="responses">${t('docs.responses')} <span class="count">${t('docs.documented', { n: responses.length })}</span></h2>
        <div class="resp-list">${responseItems}</div>

        <h2 id="auth">${t('docs.auth')}</h2>
        ${authCards}
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('info', 'i i-sm')}<span>${t('docs.bar')}</span></span>
        <button class="btn btn-primary btn-sm" aria-keyshortcuts="D">${ico('flask', 'i i-sm')}${t('view.try')}${kbd('D')}</button></div>
    </main>`;

    const lang = q.sample || 'curl';
    const exampleBody = body ? (S.resolve(body).examples?.[0] ?? S.exampleOf(body)) : undefined;
    const okSchema = firstOk && jsonSchemaOf(responses.find(([c]) => c === firstOk)[1].content);
    const shownCodes = responses.filter(([, r]) => jsonSchemaOf(r.content)).map(([c]) => c).slice(0, 4);
    const outline = [['overview', t('docs.overview')], ['request-h', t('docs.request')], ...byIn.map(([w]) => [`params-${w}`, t('docs.in.' + w), true]), ...(body ? [['body', t('docs.body'), true]] : []), ['responses', t('docs.responses')], ['auth', t('docs.auth')]];
    const here = q.scroll || 'overview';
    const aside = `
    <aside class="pane aside-pane" aria-label="${t('docs.aside')}">
      <div class="aside-head">${t('docs.onPage')}</div>
      <div class="pane-scroll"><div class="aside-inner">
        <nav class="outline" aria-label="${t('docs.onPage')}">${outline.map(([id, label, sub]) => `<a href="#${id}" class="${sub ? 'sub' : ''}" ${id === here ? 'aria-current="location"' : ''}>${label}</a>`).join('')}</nav>
        <p class="aside-label">${t('docs.requestSample')}</p>
        <div class="sample-card card">
          <div class="viewer-bar"><div class="segmented" role="group" aria-label="${t('docs.language')}">${[['curl', 'cURL'], ['csharp', 'C#'], ['fetch', 'fetch']].map(([k, l]) => `<button aria-pressed="${k === lang}"><span class="ltr">${l}</span></button>`).join('')}</div><span class="spacer"></span>${copyBtn(t('docs.copySample'), { state: q.copied === 'doc' ? 'copied' : 'idle' })}</div>
          <pre class="ltr">${sample(o, lang, exampleBody)}</pre>
        </div>
        ${shownCodes.length ? `<p class="aside-label">${t('docs.responseSample')}</p>
        <div class="sample-card card">
          <div class="tabs" role="tablist" aria-label="${t('docs.responseSample')}">${shownCodes.map(c => tab(c, { selected: c === firstOk })).join('')}</div>
          ${okSchema ? S.jsonView(sampleFor(okSchema), { label: t('docs.responseSample'), maxLines: 40 }).html : ''}
        </div>` : ''}
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('server', 'i i-sm')}<span>${t('docs.base')} <code class="ltr">${BASE}</code></span></span>${copyBtn(t('docs.copyBase'), { size: 'btn-xs' })}</div>
    </aside>`;

    mount(main, aside);
    if (q.scroll) requestAnimationFrame(() => { const el = document.getElementById(q.scroll); const m = document.getElementById('doc-main'); if (el && m) m.scrollTop = el.offsetTop - 12; });
  })();

  /* ---------- API overview ---------- */
  // The landing page on first visit, built from info, servers, securitySchemes and tags.
  (function overview() {
    if (q.view !== 'overview') return;
    const signedOut = q.auth === 'out';
    const groups = window.TB.groups();
    const locked = S.operations.filter(o => o.secured).length;
    const how = [
      ['flask', t('preview'), kbd('mod', 'enter'), t('ov.preview')],
      ['send', t('send'), kbd('shift', 'mod', 'enter'), t('ov.send')],
      ['wand', t('autofill'), kbd('shift', 'mod', 'F'), t('ov.autofill')],
    ];
    const tagDesc = name => (S.spec.tags || []).find(x => x.name === name)?.description;
    const main = `
    <main class="pane doc-pane" id="request" aria-labelledby="ov-title">
      <div class="ctx-bar"><nav class="crumbs" aria-label="${t('crumbs')}"><ol><li><span aria-current="page">${t('ov.title')}</span></li></ol></nav><div class="end"></div></div>
      <div class="pane-scroll"><div class="doc-inner">
        <h1 id="ov-title" lang="en">Acme Store API <span class="faint" style="font-weight:400">v${esc(S.spec.info?.version || '1.0.0')}</span></h1>
        <div class="doc-meta"><span class="tag tag-mono">${BASE}</span><span class="tag tag-mono">OpenAPI ${esc(S.spec.openapi)}</span><span class="tag">${t('ops', { n: S.operations.length })}</span><span class="tag">${t('models.count', { n: Object.keys(S.schemas).length })}</span></div>
        <div class="prose" lang="en">${S.md(S.spec.info?.description)}</div>
        <h2>${t('ov.how')}</h2>
        <div class="how">${how.map(([i, n, k, d]) => `<div class="how-card"><div class="how-h">${ico(i, 'i i-sm')}<strong>${n}</strong><span class="spacer"></span>${k}</div><p>${d}</p></div>`).join('')}</div>
        <h2>${t('ov.byTag')}</h2>
        <div class="card used-list">${groups.map(([n, items]) => `<a href="#"><span class="label-text" lang="en"><strong style="font-weight:500">${esc(n)}</strong>${tagDesc(n) ? ` <span class="faint">· ${esc(S.firstSentence(tagDesc(n)))}</span>` : ''}</span><span class="where">${t('ops', { n: items.length })}</span></a>`).join('')}</div>
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('info', 'i i-sm')}<span>${t('ov.bar')}</span></span><button class="btn btn-sm" aria-keyshortcuts="${aks('mod', 'K')}">${ico('search', 'i i-sm')}${t('ov.find')}${kbd('mod', 'K')}</button></div>
    </main>`;
    const aside = `
    <aside class="pane aside-pane" aria-label="${t('ov.start')}">
      <div class="aside-head">${t('ov.start')}</div>
      <div class="pane-scroll"><div class="aside-inner">
        ${signedOut ? '' : `<div class="card"><div class="card-head">${ico('check', 'i i-sm')}<strong>${t('ov.signedIn')}</strong></div>
          <p style="margin:0;padding:0.875rem;font-size:var(--fs-md);color:var(--text-2)">${t('ov.signedInBody')}</p></div>`}
        <div class="card used-list">
          <a href="#"><span class="method m-get">GET</span><span class="label-text" lang="en">List payments</span><span class="where">${t('ov.readOnly')}</span></a>
          <a href="#"><span class="method m-post">POST</span><span class="label-text" lang="en">Create payment</span><span class="where">${t('ov.tryPreview')}</span></a>
          <a href="#">${ico('keyboard', 'i i-sm')}<span class="label-text">${t('ov.shortcuts')}</span><span class="where">${kbd('?')}</span></a>
        </div>
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('server', 'i i-sm')}<span>${t('docs.base')} <code class="ltr">${BASE}</code></span></span>${copyBtn(t('docs.copyBase'), { size: 'btn-xs' })}</div>
    </aside>`;
    mount(main, aside);
  })();
})();

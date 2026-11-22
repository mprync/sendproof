// Model page (?view=model&model=<Name>), built from components.schemas in mocks/spec.js.
//
// v4: a model page fills the same two columns as Try it and Docs. The main column is the
// property tree (or the composition and its variants, or an enum's values); the right column
// lists the operations and models that use it, then an Example or the raw JSON Schema.
//
// Where you came from decides the breadcrumbs, not the sidebar tab:
//   ?from=<operationId>   opened from an operation: Orders › Create order › Order, with
//                         one Back control in the head row, "← Back to Create order ⌥←".
//                         The sidebar stays on Operations and marks that operation.
//   ?side=models          picked in the Models tab: Models › Resources › Order.
//   ?via=Order            an intermediate model on the trail (Order › OrderLine).
// Other parameters: expand=<paths> collapse=<paths> expandAll=1 variant=<Name>
//                   aside=example|schema  hl=<path>
(function () {
  const { q, ico, kbd, tab, copyBtn, t } = window.TB;
  const S = window.TB.schema;
  const esc = S.esc;
  if (q.view !== 'model') return;
  const name = q.model || 'Order';
  const raw = S.schemas[name] || {};
  const kind = S.kindOf(name);
  const from = q.from && S.operations.find(o => o.id === q.from);
  const opts = {
    id: 'm', expandAll: !!q.expandAll,
    expanded: new Set((q.expand || '').split(',').filter(Boolean)),
    collapsed: new Set((q.collapse || '').split(',').filter(Boolean)),
    variant: q.variant ? { '': q.variant } : undefined, highlight: q.hl,
  };

  /* ---------- Main column ---------- */
  let body;
  if (kind === 'enum') {
    const values = raw.enum || [];
    const names = raw['x-enum-descriptions'] || raw['x-enumDescriptions'] || {};
    const described = values.some(v => names[v]);
    body = `<h2>${t('model.values')} <span class="count">${values.length} · ${esc(raw.type || 'string')}</span></h2>
      <div class="card">${described ? '' : `<div class="card-head"><span class="sr-desc is-quiet">${t('model.valuesUndescribed')}</span></div>`}
        <div class="enum-list" role="list">${values.map(v => `<div class="enum-row" role="listitem"><code class="sr-name">${esc(v)}</code>${names[v] ? `<span class="sr-desc">${esc(names[v])}</span>` : ''}</div>`).join('')}</div></div>`;
  } else if (kind === 'oneOf') {
    const disc = S.discriminatorOf(raw);
    const variants = S.variantsOf(raw).map(S.refName);
    const chosen = q.variant || variants[0];
    body = `${disc ? `<h2>${t('model.discriminator')} <span class="count">${t('model.discBy')} <code>${esc(disc.prop)}</code></span></h2>
      <div class="card disc-table">${disc.map.map(([value, target]) => `<div class="row"><code>${esc(disc.prop)} = "${esc(value)}"</code>${ico('arrow-right', 'i i-sm faint')}<a class="type-link" href="#">${esc(target)}</a><span class="faint" style="font-size:var(--fs-sm)">${t('docs.props', { n: S.stats(target).count })}</span></div>`).join('')}</div>` : ''}
      <h2>${t('model.variants')} <span class="count">${t('model.exactlyOne', { n: variants.length })}</span></h2>
      <div class="card">
        <div class="tabs" role="tablist" aria-label="${t('schema.variant')}" style="padding-inline:0.25rem">${variants.map(v => tab(`<span class="mono">${esc(v)}</span>`, { selected: v === chosen, count: S.stats(v).count })).join('')}</div>
        <div class="card-head"><span>${t('docs.props', { n: S.stats(chosen).count })} · ${t('docs.required', { n: S.stats(chosen).required })}</span><span class="end"><a class="btn btn-ghost btn-xs" href="#">${t('model.open', { name: chosen })}${ico('arrow-right', 'i i-sm')}</a></span></div>
        ${S.tree(chosen, opts)}
      </div>`;
  } else {
    const st = S.stats(name);
    const { sources } = S.propertiesOf({ $ref: `#/components/schemas/${name}` });
    body = `${sources.length ? `<p class="lede">${t('model.includes')} ${sources.map(s => `<a class="type-link" href="#">${esc(s)}</a>`).join(', ')}</p>` : ''}
      <h2>${t('model.properties')} <span class="count">${t('docs.props', { n: st.count })} · ${t('docs.required', { n: st.required })}</span></h2>
      <div class="card">
        ${st.nested ? `<div class="card-head"><span>${t('model.nested', { n: st.nested })}</span>
          <span class="end"><button class="btn btn-ghost btn-xs" aria-keyshortcuts="Alt+Shift+ArrowDown">${ico('chevrons-ud', 'i i-sm')}${q.expandAll ? t('collapseAll') : t('expandAll')}</button></span></div>` : ''}
        ${S.tree(name, opts)}
      </div>`;
  }

  const kindLabel = { object: t('kind.objectN', { n: S.stats(name).count }), enum: t('kind.enumN', { n: (raw.enum || []).length }), oneOf: t('kind.oneOfN', { n: S.variantsOf(raw).length }), allOf: t('kind.allOf'), array: t('kind.array') }[kind];
  const main = `
    <main class="pane doc-pane" id="request" aria-labelledby="model-title">
      ${window.TB.ctxBar(q, 'model')}
      <div class="pane-scroll"><div class="doc-inner">
        <h1 id="model-title" lang="en">${esc(name)}</h1>
        <div class="doc-meta">
          <span class="tag">${kindLabel}</span>
          <span class="tag tag-mono">#/components/schemas/${esc(name)}</span>
          ${copyBtn(t('model.copyRef'), { size: 'btn-xs' })}
        </div>
        <div class="prose" lang="en">${raw.description ? S.md(raw.description) : `<p class="faint">${t('schema.noDescModel')}</p>`}</div>
        ${body}
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('box', 'i i-sm')}<span>${t('model.bar')}</span></span>
        <button class="btn btn-ghost btn-sm">${ico('braces', 'i i-sm')}${t('model.copySchema')}</button></div>
    </main>`;

  /* ---------- Right column ---------- */
  const usage = S.usedBy(name);
  const asideView = q.aside || 'example';
  // A union's example follows the variant picked in the main column.
  const exampleTarget = kind === 'oneOf' ? (q.variant || S.variantsOf(raw).map(S.refName)[0]) : name;
  const sampleValue = window.TB.sampleFor({ $ref: `#/components/schemas/${exampleTarget}` });
  const isReal = window.TB.isRealSample(sampleValue);
  const viewer = asideView === 'schema'
    ? S.jsonView(raw, { label: t('model.jsonSchema') })
    : S.jsonView(kind === 'enum' ? (raw.enum || [])[0] : sampleValue, { label: t('docs.example') });
  const aside = `
    <aside class="pane aside-pane" aria-label="${t('model.aside')}">
      <div class="aside-head">${t('model.usedBy')} <span class="count">${t('ops', { n: (usage.operations.length ? usage.operations : usage.via).length })}</span></div>
      <div class="pane-scroll"><div class="aside-inner">
        ${usage.operations.length ? `<div class="card used-list">${usage.operations.map(o => `<a href="#" class="${from && o.id === from.id ? 'is-here' : ''}"><span class="method m-${o.method}">${o.method === 'delete' ? 'DEL' : o.method.toUpperCase()}</span><span class="label-text" lang="en" ${o.deprecated ? 'style="text-decoration:line-through"' : ''}>${esc(o.summary)}</span><span class="where">${o.where}</span></a>`).join('')}</div>`
          : usage.via.length ? `<p class="aside-label">${t('used.viaHead')}</p><div class="card used-list">${usage.via.slice(0, 8).map(o => `<a href="#"><span class="method m-${o.method}">${o.method === 'delete' ? 'DEL' : o.method.toUpperCase()}</span><span class="label-text" lang="en">${esc(o.summary)}</span><span class="where">${esc(o.where)}</span></a>`).join('')}</div>`
          : `<p class="faint" style="margin:0;font-size:var(--fs-md)">${t('model.unused')}</p>`}
        ${usage.models.length ? `<p class="aside-label">${t('model.referencedBy')}</p><div class="card used-list">${usage.models.slice(0, 6).map(m => `<a href="#"><span class="model-ico" style="inline-size:2.125rem;block-size:1.25rem;display:grid;place-items:center;border-radius:var(--r-sm);font:600 0.65625rem/1 var(--mono);color:var(--text-2);background:var(--sunken);border:1px solid var(--line)">{ }</span><span class="label-text" lang="en">${esc(m)}</span></a>`).join('')}</div>` : ''}
        <div class="sample-card card">
          <div class="viewer-bar"><div class="segmented" role="group" aria-label="${t('model.show')}"><button aria-pressed="${asideView === 'example'}">${t('docs.example')}</button><button aria-pressed="${asideView === 'schema'}">${t('model.jsonSchema')}</button></div>
            <span class="spacer"></span><span class="lines">${t('json.lines', { n: viewer.lines })}</span>${copyBtn(asideView === 'schema' ? t('model.copySchema') : t('model.copyExample'))}</div>
          ${viewer.html}
        </div>
      </div></div>
      <div class="pane-bar"><span class="bar-text">${ico('info', 'i i-sm')}<span>${asideView === 'schema' ? t('model.schemaNote') : isReal ? t('model.exampleReal') : t('model.exampleNote')}</span></span></div>
    </aside>`;

  window.TB.mountReference(main, aside);
})();

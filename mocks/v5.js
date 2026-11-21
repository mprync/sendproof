// v5 (?v5=1): the shared builders of the v5 design. Loads after schema.js and before the v4
// pane builders, so the v4 Docs and model pages pick up the new attribute list through
// S.tree and S.rows. The panes that change more (Try it, the result viewer) are rebuilt by
// v5-panes.js, and the new popovers live in v5-overlays.js. Without ?v5 nothing here runs and
// every v4 screen renders exactly as before.
//
// What it holds:
//   attrs        the attribute list in the Stripe reading style: flat rows on hairlines, name
//                in bold mono, muted type, "Required" or "Optional" on the same line, the
//                description flush beneath, constraints as quiet text, "Possible enum values",
//                and "Show child attributes" opening a bordered, inset child list.
//   field        one field anatomy for every control: label row, control, description, then
//                one reserved status line (constraints, what gets sent, or the error).
//   select       a field-styled select: the value, then a trigger joined to the control by a
//                divider. Its popover is a listbox (v5-overlays.js).
//   radio        a radio group for short enums, with a clear selected state and Clear.
//   deprecation  the notice for a deprecated operation, from x-replaced-by and x-sunset.
(function () {
  const { q, ico, kbd, aks, tab, t } = window.TB;
  if (!q.v5) return;
  const S = window.TB.schema;
  const esc = S.esc;
  const { num, date } = window.i18n;

  // Icons v5 needs that v4 didn't.
  document.querySelector('svg[style*="display:none"]')?.insertAdjacentHTML('beforeend', [
    ['minus', '<path d="M5 12h14"/>'],
    ['wrap', '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>'],
    ['table', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'],
    ['external', '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'],
    ['circle-check', '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'],
    ['languages', '<path d="M4 5h9M8.5 3v2M6 5c.7 3.2 2.6 5.6 5 7M11 5c-.6 3.8-3 6.8-6.5 8.5"/><path d="m12.5 21 4-10 4 10M14 17.5h5"/>'],
  ].map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join(''));

  /* ---------- Enums ---------- */
  /** An enum's values and their descriptions (x-enum-descriptions), or undefined. */
  function enumOf(s) {
    const { schema } = S.unwrapNull(s || {});
    const r = S.resolve(schema);
    const own = schema.enum ? schema : r.enum ? r : r.items && S.resolve(r.items).enum ? S.resolve(r.items) : undefined;
    if (!own) return undefined;
    const d = own['x-enum-descriptions'] || own['x-enumDescriptions'] || schema['x-enum-descriptions'] || {};
    return { values: own.enum, desc: d, described: own.enum.some(v => d[v]) };
  }
  // A radio group fits short enums; anything longer is a select. Values stay on one line.
  const useRadio = values => values.length <= 4 && values.every(v => String(v).length <= 12);

  /* ---------- Constraints as quiet text ---------- */
  function facts(raw, nullable, extra = []) {
    const r = { ...S.resolve(raw), ...Object.fromEntries(Object.entries(raw || {}).filter(([k]) => k !== '$ref')) };
    const out = [...extra];
    const f = (k, v) => out.push(v === undefined ? `<span>${k}</span>` : `<span>${k} <code>${esc(v)}</code></span>`);
    const type = S.typeOf(r);
    if (r.format && type !== 'array' && !(r.format === 'decimal')) f(t('v5.f.format'), r.format);
    if (r.minimum !== undefined && r.maximum !== undefined) f(t('v5.f.range'), `${r.minimum}–${r.maximum}`);
    else if (r.minimum !== undefined) f(t('v5.f.min'), r.minimum);
    else if (r.maximum !== undefined) f(t('v5.f.max'), r.maximum);
    if (r.exclusiveMinimum !== undefined) f(t('v5.f.gt'), r.exclusiveMinimum);
    if (r.multipleOf !== undefined) f(t('v5.f.step'), r.multipleOf);
    if (r.minLength !== undefined && r.maxLength !== undefined) f(t('v5.f.length'), r.minLength === r.maxLength ? r.minLength : `${r.minLength}–${r.maxLength}`);
    else if (r.maxLength !== undefined) f(t('v5.f.maxLength'), r.maxLength);
    else if (r.minLength !== undefined) f(t('v5.f.minLength'), r.minLength);
    if (r.pattern) out.push(`<span>${t('v5.f.pattern')} <code class="pat">${esc(r.pattern)}</code></span>`);
    if (r.minItems !== undefined || r.maxItems !== undefined) f(t('v5.f.items'), r.minItems !== undefined && r.maxItems !== undefined ? `${r.minItems}–${r.maxItems}` : r.maxItems !== undefined ? `≤ ${r.maxItems}` : `≥ ${r.minItems}`);
    if (r.uniqueItems) f(t('v5.f.unique'));
    if (r.default !== undefined) f(t('v5.f.default'), typeof r.default === 'string' ? r.default : JSON.stringify(r.default));
    if (r.readOnly) f(t('v5.f.readOnly'));
    if (r.writeOnly) f(t('v5.f.writeOnly'));
    if (r.deprecated) f(t('v5.f.deprecated'));
    return out;
  }

  /* ---------- Attribute list ---------- */
  /** The type after a name: "string", "nullable string", "array of AccountReference" (a link). */
  function typeText(schema, nullable) {
    const label = S.typeLabel(schema);
    const r = S.resolve(schema);
    const link = n => `<a class="attr-type is-ref" href="#" title="${t('schema.openModel', { name: n })}">${esc(n)}</a>`;
    let html;
    if (label.array) html = `<span class="attr-type">${t('v5.arrayOf')}</span> ${label.ref ? link(label.ref) : `<span class="attr-type">${esc(label.text.replace(/\[\]$/, ''))}</span>`}`;
    else if (label.ref) html = link(label.ref);
    else if (r.oneOf || r.anyOf) html = `<span class="attr-type">${t('v5.oneOfN', { n: S.variantsOf(r).length })}</span>`;
    else html = `<span class="attr-type">${esc(label.text === 'string' && enumOf(schema) ? 'enum' : label.text)}</span>`;
    return nullable ? `<span class="attr-type">${t('v5.nullable')}</span> ${html}` : html;
  }

  function enumBlock(en, opts) {
    if (!en || opts.compact) return '';
    const max = 6;
    const shown = en.values.length > max + 1 && !opts.allValues ? en.values.slice(0, max - 1) : en.values;
    const more = en.values.length - shown.length;
    const list = en.described
      ? `<dl class="enum-dl">${shown.map(v => `<div><dt><code>${esc(v)}</code></dt>${en.desc[v] ? `<dd lang="en">${esc(en.desc[v])}</dd>` : ''}</div>`).join('')}</dl>`
      : `<ul class="enum-inline">${shown.map(v => `<li><code>${esc(v)}</code></li>`).join('')}</ul>`;
    return `<div class="attr-enum"><p class="attr-enum-h">${t('v5.enumValues')}</p>${list}${more ? `<button class="link-btn" type="button">${t('v5.moreValues', { n: more })}</button>` : ''}</div>`;
  }

  /**
   * The attribute list for an object schema.
   * opts: expanded (Set of paths), expandAll, compact (head lines only, for the response
   *       Schema view), present (Set of returned paths), issues ({ path: message }),
   *       extra ([{ name, value }] returned but undocumented), variant ({ path: name }),
   *       collapsed (Set of paths the user closed; everything else starts open),
   *       disc ({ prop, value } of the chosen variant), id (prefix).
   */
  function attrs(s, opts = {}, depth = 0, path = '', seen = new Set()) {
    const { props, required } = S.propertiesOf(s);
    const rows = Object.entries(props).map(([name, raw]) => attrRow(name, raw, required.has(name), opts, depth, path ? `${path}.${name}` : name, seen));
    if (depth === 0 && opts.extra) rows.push(...opts.extra.map(x => `<li class="attr is-extra"><div class="attr-head"><code class="attr-name">${esc(x.name)}</code><span class="attr-type">${esc(typeof x.value)}</span><span class="attr-req is-undoc">${t('v5.undocumented')}</span><span class="spacer"></span>${mark('issue')}</div>${x.issue ? `<p class="attr-issue">${ico('warn', 'i i-sm')}<span>${x.issue}</span></p>` : ''}</li>`));
    return `<ul class="attrs${opts.compact ? ' is-compact' : ''}" role="list" ${depth === 0 && opts.label ? `aria-label="${esc(opts.label)}"` : ''}>${rows.join('')}</ul>`;
  }
  const mark = kind => `<span class="attr-mark is-${kind}" role="img" aria-label="${t('v5.mark.' + kind)}"></span>`;

  function attrRow(name, raw, req, opts, depth, path, seen) {
    const { schema, nullable } = S.unwrapNull(raw);
    const r = S.resolve(schema);
    const target = S.typeLabel(schema).ref;
    const recursive = target && seen.has(target);
    const canOpen = S.expandable(schema) && !recursive;
    // Open by default, like JSON and the sidebar groups: every level up to 3 deep, and deeper
    // with Expand all. Collapsing is remembered per path (opts.collapsed, ?collapse= here).
    const open = canOpen && !opts.collapsed?.has(path) && (depth < 3 || opts.expandAll || opts.expanded?.has(path));
    const desc = raw.description || schema.description || (target ? undefined : r.description);
    const en = enumOf(schema);
    const example = (() => { const x = { ...r, ...raw }; const v = x.example ?? x.examples?.[0]; return v !== undefined && typeof v !== 'object' ? v : undefined; })();
    const extra = [];
    // A one-value enum is a constant (a discriminator in its variant): say it once, as a fact.
    if (en?.values.length === 1 && !String(desc || '').includes(en.values[0])) extra.push(`<span>${t('v5.always', { value: `<code>${esc(en.values[0])}</code>` })}</span>`);
    if (false) extra.push(`<span>${t('v5.always', { value: `<code>${esc(opts.disc.value)}</code>` })}</span>`);
    const factList = facts(schema, nullable, extra);
    if (example !== undefined && !en) factList.push(`<span>${t('v5.f.example')} <code>${esc(String(example).length > 48 ? String(example).slice(0, 47) + '…' : example)}</code></span>`);
    const id = `${opts.id || 'a'}-${path.replace(/\W/g, '-')}`;
    const present = opts.present ? opts.present.has(path) : undefined;
    const issue = opts.issues?.[path];

    let kids = '';
    if (canOpen) {
      const label = open ? t('v5.hideKids') : t('v5.showKids');
      const toggle = `<button class="attr-toggle" type="button" aria-expanded="${open}" aria-controls="${id}-kids">${ico(open ? 'minus' : 'plus', 'i i-sm')}<span>${label}</span></button>`;
      if (!open) kids = toggle;
      else {
        const next = new Set(seen); if (target) next.add(target);
        const isArr = S.typeOf(r) === 'array';
        const inner = isArr ? S.resolve(r.items) : r;
        const innerRaw = isArr ? r.items : schema;
        const childPath = isArr ? path + '[]' : path;
        const body = inner.oneOf || inner.anyOf ? variants(innerRaw, opts, depth + 1, childPath, next) : attrs(innerRaw, opts, depth + 1, childPath, next);
        kids = `<div class="attr-kids" id="${id}-kids">${toggle}${body}</div>`;
      }
    }
    const state = issue ? 'issue' : present === false ? 'off' : present ? 'on' : '';
    return `<li class="attr${state ? ' is-' + state : ''}${opts.highlight === path ? ' is-hl' : ''}" id="${id}">
      <div class="attr-head">
        <code class="attr-name">${esc(name)}</code>${typeText(schema, nullable)}
        ${recursive ? `<span class="attr-note">${t('schema.recursive')}</span>` : ''}
        <span class="attr-req${req ? ' is-req' : ''}">${req ? t('v5.required') : t('v5.optional')}</span>
        ${present !== undefined || issue ? `<span class="spacer"></span>${mark(state || 'off')}` : ''}
      </div>
      ${issue ? `<p class="attr-issue">${ico('warn', 'i i-sm')}<span>${issue}</span></p>` : ''}
      ${opts.compact ? '' : `${desc ? `<p class="attr-desc" lang="en">${S.md(desc, { block: false })}</p>` : target ? '' : `<p class="attr-desc is-quiet">${t('schema.noDesc')}</p>`}
      ${factList.length ? `<p class="attr-facts">${factList.join('')}</p>` : ''}
      ${en?.values.length === 1 ? '' : enumBlock(en, opts)}`}
      ${kids}
    </li>`;
  }

  /** A oneOf inside a child list: how the variant is chosen, a tab per variant, its rows. */
  function variants(s, opts, depth, path, seen) {
    const list = S.variantsOf(s);
    const disc = S.discriminatorOf(s);
    const chosen = opts.variant?.[path] || S.refName(list[0]);
    const pick = list.find(v => S.refName(v) === chosen) || list[0];
    const value = disc?.map.find(([, n]) => n === chosen)?.[0];
    return `<div class="attr-variants">
        <span class="k">${disc ? t('v5.chosenBy', { prop: `<code>${esc(disc.prop)}</code>` }) : t('v5.exactlyOne')}</span>
        <div class="tabs v-tabs" role="tablist" aria-label="${t('schema.variant')}">${list.map(v => {
          const n = S.refName(v);
          const val = disc?.map.find(([, x]) => x === n)?.[0];
          return tab(`<span class="mono">${esc(val || n)}</span>`, { selected: n === chosen });
        }).join('')}</div>
        <a class="attr-type is-ref" href="#">${esc(chosen)}</a>
      </div>${attrs(pick, { ...opts, disc: disc && value ? { prop: disc.prop, value, depth } : undefined }, depth, path, seen)}`;
  }

  /** The whole list for a model or schema; a top-level union starts with its variant switch. */
  function tree(s, opts = {}) {
    const schema = typeof s === 'string' ? { $ref: `#/components/schemas/${s}` } : s;
    const r = S.resolve(schema);
    const name = S.refName(schema);
    if (r.oneOf || r.anyOf) return `<div class="attr-top">${variants(schema, opts, 0, '', new Set([name]))}</div>`;
    if (S.typeOf(r) === 'array') return attrs(r.items, opts, 0, '[]', new Set([S.refName(r.items)]));
    return attrs(schema, { ...opts, label: t('schema.treeLabel', { name: esc(name || 'Body') }) }, 0, '', new Set([name]));
  }

  // Descriptions often name another operation by its operationId (`BalancesController.Get`).
  // v5 links it to that operation and says its name, so "Use Get balance" reads as a link.
  const md = S.md;
  S.md = (text, o) => md(text, o).replace(/<code>([A-Za-z]+Controller\.[A-Za-z]+)<\/code>/g, (m, id) => {
    const op = S.operations.find(x => x.id === id);
    return op ? `<a class="op-ref" href="#" title="${esc(id)}"><span class="method m-${op.method}">${op.method.toUpperCase()}</span><span lang="en">${esc(op.summary)}</span></a>` : m;
  });

  // The v4 Docs and model pages call S.tree and S.rows; in v5 they get the attribute list.
  S.tree = tree;
  S.rows = (s, opts = {}) => attrs(s, opts);

  /* ---------- Field anatomy ---------- */
  // label row      name (i) optional ............ [Clear] type
  // control        input, select, radio group or lookup, 36 px (44 px on touch)
  // description    from the spec, flush with the control, as many lines as it needs
  // status line    one reserved line: constraints, what gets sent, or the error
  /**
   * f: { name, label, kind: text|number|date|password|select|radio|lookup|money|list,
   *      optional, type, desc, value, placeholder, options: [{ v, d }], status, count,
   *      error, generated, state: rest|hover|focus|open|disabled, picked: [chip, main, sub],
   *      currency, half, lang ('en' for spec text, the default) }
   */
  function field(f) {
    const id = 'f5-' + f.name;
    const st = f.state || 'rest';
    const disabled = st === 'disabled';
    const has = f.kind === 'lookup' ? !!f.picked : f.value !== undefined && f.value !== '' && f.value !== null;
    const clearable = f.optional && has && !disabled && ['radio', 'select', 'lookup', 'date'].includes(f.kind);
    const tipOpen = q.overlay === 'toggletip' && q.focus === f.name;
    const info = `<button type="button" class="info-btn" aria-label="${t('v5.about', { name: esc(f.label) })}" aria-expanded="${tipOpen}" ${disabled ? 'disabled' : ''}>${ico('info', 'i')}</button>`;
    const labelEl = ['radio'].includes(f.kind) ? `<span class="f5-name" id="${id}-l" lang="en">${esc(f.label)}</span>` : `<label class="f5-name" id="${id}-l" for="${id}" lang="en">${esc(f.label)}</label>`;
    const label = `<div class="f5-label">${labelEl}${info}${f.optional ? `<span class="opt">${t('optional')}</span>` : ''}
      <span class="f5-end">${clearable ? `<button type="button" class="f5-clear" aria-label="${t('v5.clearName', { name: esc(f.label) })}">${t('v5.clear')}</button>` : ''}<span class="f5-type">${esc(f.type || '')}</span></span></div>`;
    const describedBy = `${f.desc ? id + '-desc ' : ''}${id}-status`;
    const err = f.error;
    const aria = `id="${id}" aria-describedby="${describedBy}" ${f.optional ? '' : 'aria-required="true"'} ${err ? 'aria-invalid="true"' : ''} ${disabled ? 'aria-disabled="true"' : ''}`;
    const cls = `control${err ? ' is-invalid' : ''}${st === 'focus' || st === 'open' ? ' is-focus' : ''}${st === 'hover' ? ' is-hover' : ''}${st === 'open' ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${f.generated ? ' is-generated' : ''}`;
    const wand = (st === 'focus' || st === 'hover') && !disabled
      ? `<button type="button" class="slot wand" aria-label="${t('v5.generate', { name: esc(f.label) })}" aria-keyshortcuts="Alt+G" aria-haspopup="menu" aria-expanded="false">${ico('wand', 'i i-sm')}</button>`
      : err ? `<span class="slot err" aria-hidden="true">${ico('alert', 'i i-sm')}</span>` : `<span class="slot" aria-hidden="true"></span>`;
    const trigger = `<span class="sel5-trigger" aria-hidden="true">${ico('chevron-down', 'i i-sm')}</span>`;
    let control;
    switch (f.kind) {
      case 'select':
        control = `<div class="${cls} sel5" role="combobox" tabindex="${disabled ? -1 : 0}" aria-haspopup="listbox" aria-expanded="${st === 'open'}" ${st === 'open' ? `aria-controls="${id}-lb"` : ''} aria-labelledby="${id}-l" ${aria}>
          ${has ? `<span class="sel5-value${f.mono ? ' mono-val' : ''}" lang="en">${esc(f.value)}</span>` : `<span class="placeholder grow">${esc(f.placeholder || t('v5.choose'))}</span>`}
          ${err ? wand : '<span class="slot" aria-hidden="true"></span>'}${trigger}</div>`;
        break;
      case 'lookup':
        control = `<div class="${cls} sel5 lk5" role="combobox" tabindex="${disabled ? -1 : 0}" aria-haspopup="listbox" aria-expanded="${st === 'open'}" ${st === 'open' ? `aria-controls="${id}-lb"` : ''} aria-labelledby="${id}-l" ${aria}>
          ${has ? `<span class="picked"><span class="chip-ico" aria-hidden="true">${esc(f.picked[0])}</span><span class="main" lang="en">${esc(f.picked[1])}</span><span class="sub">${esc(f.picked[2])}</span></span>` : `<span class="placeholder grow">${esc(f.placeholder || t('v5.choose'))}</span>`}
          ${err ? wand : '<span class="slot" aria-hidden="true"></span>'}${trigger}</div>`;
        break;
      case 'radio':
        control = `<div class="rg5${err ? ' is-invalid' : ''}${disabled ? ' is-disabled' : ''}" role="radiogroup" aria-labelledby="${id}-l" aria-describedby="${describedBy}" ${f.optional ? '' : 'aria-required="true"'} ${err ? 'aria-invalid="true"' : ''} ${disabled ? 'aria-disabled="true"' : ''}>
          ${f.options.map((o, i) => {
            const on = o.v === f.value;
            const focusable = has ? on : i === 0;
            const s2 = (f.hoverOn === o.v ? ' is-hover' : '') + (st === 'focus' && (has ? on : i === 0) ? ' is-focus' : '');
            return `<span class="rg5-opt${s2}" role="radio" aria-checked="${on}" tabindex="${focusable && !disabled ? 0 : -1}" ${o.d ? `title="${esc(o.d)}"` : ''} lang="en"><span class="rg5-dot" aria-hidden="true"></span>${esc(o.v)}</span>`;
          }).join('')}</div>`;
        break;
      case 'money':
        control = `<div class="${cls} control-split money5">
          <span class="part"><input ${aria} class="num" inputmode="decimal" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '0.00')}">${wand}</span>
          <span class="part sel5-seg" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-label="${t('v5.currency')}: ${esc(f.currency)}"><span>${esc(f.currency)}</span>${ico('chevron-down', 'i i-sm')}</span></div>`;
        break;
      case 'date':
        control = `<div class="${cls}"><span class="lead">${ico('calendar', 'i i-sm')}</span><input ${aria} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || window.i18n.datePattern)}">${f.trail ? `<span class="trail">${esc(f.trail)}</span>` : ''}${wand}</div>`;
        break;
      case 'list':
        control = `<div class="list-input">${(f.items || []).map((it, i) => `<div class="li"><span class="idx" aria-hidden="true">${i + 1}</span><span class="val" lang="en">${esc(it)}</span><button type="button" class="btn btn-ghost btn-icon btn-xs" aria-label="${t('v5.removeLine', { n: i + 1 })}">${ico('x', 'i i-sm')}</button></div>`).join('')}
          <button type="button" class="add">${ico('plus', 'i i-sm')}${t('v5.addLine')}${kbd('mod', 'enter')}</button></div>`;
        break;
      default:
        control = `<div class="${cls}">${f.icon ? `<span class="lead">${ico(f.icon, 'i i-sm')}</span>` : ''}<input ${aria} class="${f.mono ? 'mono-val' : ''}${f.kind === 'number' ? ' num' : ''}" ${f.kind === 'number' ? 'inputmode="numeric"' : ''} ${f.kind === 'password' ? 'type="password"' : ''} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${disabled ? 'disabled' : ''}>${wand}</div>`;
    }
    const count = f.count ? `<span class="count">${f.count}</span>` : '';
    let status;
    if (err) status = `<p class="f5-status is-error" id="${id}-status">${ico('alert', 'i i-sm')}<span class="msg">${err}</span>${count}</p>`;
    else if (f.generated) status = `<p class="f5-status is-generated" id="${id}-status" aria-live="polite">${ico('wand', 'i i-sm')}<span class="msg">${t('v5.generated', { what: f.generated })}</span><button type="button" class="undo" aria-keyshortcuts="${aks('mod', 'Z')}">${t('v5.undo')}</button></p>`;
    else status = `<p class="f5-status" id="${id}-status"><span class="msg">${f.status ?? ''}</span>${count}</p>`;
    return `<div class="f5${f.half ? ' half' : ''}${disabled ? ' is-disabled' : ''}" data-field="${esc(f.name)}" ${f.kind === 'radio' ? 'role="group"' : ''}>${label}${control}${f.desc ? `<p class="f5-desc" id="${id}-desc" lang="en">${f.desc}</p>` : ''}${status}</div>`;
  }

  // "an account" from x-lookup's url (/api/v2/accounts?…), for "Choose an account…".
  const lookupNoun = l => { const m = l?.url?.match(/\/([a-z-]+?)(?:ies|s)?(?:\?|$)/); if (!m) return ''; const w = m[0].includes('ies') ? m[1] + 'y' : m[1]; return (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w.replace(/-/g, ' '); };

  /** A field from an OpenAPI parameter: the control, type, description and status follow the schema. */
  function fromParam(p, v = {}) {
    const sch = p.schema || {};
    const r = S.resolve(sch);
    const en = enumOf(sch);
    const type = S.typeOf(r);
    const lookup = sch['x-lookup'];
    const kind = en ? (useRadio(en.values) ? 'radio' : 'select') : lookup ? 'lookup' : ['integer', 'number'].includes(type) ? 'number' : r.format === 'date' ? 'date' : 'text';
    const typeLabel = en ? (S.refName(sch) || 'enum') : r.format && r.format !== 'decimal' ? r.format : type === 'integer' ? (r.format || 'integer') : type;
    const status = [];
    if (kind === 'number') {
      if (r.minimum !== undefined && r.maximum !== undefined) status.push(t('v5.between', { min: num(r.minimum), max: num(r.maximum) }));
      else if (r.minimum !== undefined) status.push(t('v5.atLeast', { min: num(r.minimum) }));
      if (r.default !== undefined) status.push(t('v5.defaultIs', { v: `<code>${esc(r.default)}</code>` }));
    }
    if (kind === 'text' && r.maxLength) status.push(t('v5.upTo', { n: num(r.maxLength) }));
    if (p.in === 'query' && !p.required && v.value === undefined && !status.length) status.push(t('v5.notSent'));
    return {
      name: p.name, label: p.name, kind, type: typeLabel, optional: !p.required, mono: kind === 'number',
      desc: S.md(p.description, { block: false }), placeholder: kind === 'number' && r.default !== undefined ? String(r.default) : kind === 'select' ? (p.required ? t('v5.choose') : t('v5.any')) : kind === 'lookup' ? t('v5.chooseAn', { name: lookupNoun(lookup) || p.name }) : '',
      options: en ? en.values.map(x => ({ v: x, d: en.desc[x] })) : undefined,
      status: status.join(' · '), count: kind === 'text' && r.maxLength ? `${num((v.value || '').length)} / ${num(r.maxLength)}` : '',
      lookup, ...v,
    };
  }

  /* ---------- Listbox popover (the select's options) ---------- */
  /**
   * o: { active (value), search (query or true), typed (type-ahead buffer), unset (label for
   *      the "not set" row, optional fields), foot (html), id }
   */
  function listbox(f, o = {}) {
    const id = o.id || `f5-${f.name}-lb`;
    const opts = f.options || [];
    const query = typeof o.search === 'string' ? o.search : '';
    const match = x => !query || [x.v, x.d].some(s => s && String(s).toLowerCase().includes(query.toLowerCase()));
    const shown = opts.filter(match);
    const hl = s => query ? esc(s).replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>') : esc(s);
    const row = (x, extra = '') => {
      const sel = x.v === f.value;
      const active = o.active === x.v;
      return `<li class="lb5-opt${active ? ' is-active' : ''}${x.d ? ' has-desc' : ''}${extra}" role="option" id="${id}-${String(x.v).replace(/\W/g, '_')}" aria-selected="${sel}">
        <span class="lb5-check" aria-hidden="true">${sel ? ico('check', 'i i-sm') : ''}</span>
        <span class="lb5-text"><span class="v${f.mono ? ' mono' : ''}" lang="en">${hl(x.v)}</span>${x.d ? `<span class="d" lang="en">${hl(x.d)}</span>` : ''}</span>
      </li>`;
    };
    const unsetRow = f.optional && !query ? `<li class="lb5-opt is-unset${o.active === '' ? ' is-active' : ''}" role="option" aria-selected="${!f.value}">
        <span class="lb5-check" aria-hidden="true">${!f.value ? ico('check', 'i i-sm') : ''}</span>
        <span class="lb5-text"><span class="v">${esc(o.unset || t('v5.any'))}</span><span class="d">${t('v5.unsetHint')}</span></span></li>` : '';
    const search = o.search ? `<div class="lb5-search">${ico('search', 'i i-sm')}<input role="searchbox" aria-controls="${id}" placeholder="${t('v5.searchN', { n: num(opts.length) })}" value="${esc(query)}"><span class="lb5-count">${query ? t('v5.matches', { n: num(shown.length) }) : ''}</span></div>` : '';
    const empty = !shown.length ? `<li class="lb5-empty" role="presentation">${t('v5.noMatch', { q: esc(query) })}</li>` : '';
    return `<div class="pop lb5" data-for="${esc(f.name)}">
      ${search}
      <ul class="lb5-list" role="listbox" id="${id}" aria-label="${esc(f.label)}" ${o.active !== undefined ? `aria-activedescendant="${id}-${String(o.active).replace(/\W/g, '_')}"` : ''}>${unsetRow}${shown.map(x => row(x)).join('')}${empty}</ul>
      <div class="pop-foot">${o.foot || `<span>${kbd('↑↓')}${t('v5.k.move')}</span><span>${kbd('↵')}${t('v5.k.choose')}</span>${o.typed ? `<span class="typed">${t('v5.typed')} <code>${esc(o.typed)}</code></span>` : ''}<span class="spacer"></span><span>${kbd('Esc')}</span>`}</div>
    </div>`;
  }

  /* ---------- Deprecation ---------- */
  /** What replaces a deprecated operation: x-replaced-by, as a string or a list of links. */
  function replacements(op) {
    const raw = op['x-replaced-by'];
    const list = !raw ? [] : Array.isArray(raw) ? raw : [typeof raw === 'string' ? { operationId: raw } : raw];
    return list.map(x => {
      const target = S.operations.find(o => o.id === (typeof x === 'string' ? x : x.operationId));
      const carry = Object.entries(x.parameters || {}).map(([to, expr]) => [to, String(expr).replace(/^\$request\.(path|query|header)\./, '')]);
      return target && { target, carry, description: x.description };
    }).filter(Boolean);
  }
  /** "30 June 2027 · in 7 months" from x-sunset, in the UI locale. */
  function sunset(op) {
    const when = op['x-sunset'];
    if (!when) return '';
    const months = Math.round((new Date(when + 'T00:00:00Z') - new Date('2026-11-21T00:00:00Z')) / (30.44 * 864e5));
    const rel = new Intl.RelativeTimeFormat(window.i18n.locale, { numeric: 'auto' }).format(months, 'month');
    return { date: date(when, { day: 'numeric', month: 'long', year: 'numeric' }), short: date(when, { day: 'numeric', month: 'short', year: 'numeric' }), rel };
  }
  /** The notice in Try it and Docs: what to use, when it stops working, one action that carries the inputs. */
  function deprecation(o, where = 'try') {
    const reps = replacements(o.op);
    const sun = sunset(o.op);
    const first = reps[0];
    const carry = first?.carry.length ? first.carry.map(([to, from]) => to === from ? `<code>${esc(from)}</code>` : t('v5.carryAs', { from: `<code>${esc(from)}</code>`, to: `<code>${esc(to)}</code>` })).join(', ') : '';
    return `<section class="dep5" role="note" aria-labelledby="dep5-h">
      <div class="dep5-head">${ico('warn', 'i i-sm')}<strong id="dep5-h">${t('v5.dep.title')}</strong>${sun ? `<span class="dep5-sunset">${t('v5.dep.sunset', { date: `<time datetime="${o.op['x-sunset']}">${sun.date}</time>`, rel: sun.rel })}</span>` : `<span class="dep5-sunset">${t('v5.dep.noSunset')}</span>`}</div>
      ${reps.length ? `<p class="dep5-lede">${t('v5.dep.useInstead')}</p>
      <ul class="dep5-list">${reps.map(x => `<li><a class="dep5-op" href="#"><span class="method m-${x.target.method}">${x.target.method.toUpperCase()}</span><span lang="en">${esc(x.target.summary)}</span></a>${x.description ? `<span class="dep5-why" lang="en">${esc(x.description)}</span>` : ''}</li>`).join('')}</ul>
      <div class="dep5-actions"><button class="btn btn-sm" type="button" aria-keyshortcuts="Alt+R">${t(where === 'docs' ? 'v5.dep.openTry' : 'v5.dep.open', { name: `<span lang="en">${esc(first.target.summary)}</span>` })}${ico('arrow-right', 'i i-sm')}</button>${carry ? `<span class="dep5-carry">${t('v5.dep.carries', { list: carry })}</span>` : ''}</div>`
      : `<p class="dep5-lede">${t('v5.dep.noReplacement')}</p>`}
    </section>`;
  }

  window.TB.v5 = { enumOf, useRadio, facts, attrs, tree, field, fromParam, listbox, replacements, sunset, deprecation, mark };
})();

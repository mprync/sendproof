// Reading the OpenAPI document (mocks/spec.js, shaped like a snapshot of the store example) and the
// two viewers built from it: the property tree (Docs, model pages, the response Schema view)
// and the JSON viewer (response bodies, examples, JSON Schema). Nothing here is written per
// screen: every row comes from components.schemas, so every row has the same anatomy.
//
// Property row anatomy, the same at every depth:
//   [toggle or reserved slot] name  type  required|optional
//   description, or a quiet "No description in the spec"
//   chips: format, constraints, read-only, nullable, default (one style, "key value")
//   values: enum members        example: the spec's example
// A toggle appears only when there is something to expand: an object, an array of objects,
// a $ref or a composition. $ref types are links to the model page and expand inline.
(function () {
  const { ico, t } = window.TB;
  let spec = window.TB_SPEC || { paths: {}, components: { schemas: {} } };
  // ?strip=descriptions removes the descriptions of ?model, to show an undocumented schema.
  if (window.TB.q.strip === 'descriptions' && window.TB.q.model) {
    spec = structuredClone(spec);
    const target = spec.components.schemas[window.TB.q.model];
    const strip = node => { if (node && typeof node === 'object') { if (typeof node.description === 'string') delete node.description; Object.values(node).forEach(strip); } };
    if (target) strip(target);
  }
  const schemas = spec.components?.schemas || {};

  /* ---------- Text ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a class="link" href="$2">$1</a>');
  /** Markdown as API descriptions use it: paragraphs, lists, bold, emphasis, code and links. */
  function md(text, { block = true } = {}) {
    if (!text) return '';
    if (!block) return inline(text.replace(/\s*\n\s*/g, ' '));
    return text.trim().split(/\n\s*\n/).map(chunk => {
      const lines = chunk.split('\n');
      if (lines.every(line => /^\s*([-*]|\d+\.)\s+/.test(line))) {
        const tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
        return `<${tag}>${lines.map(line => `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</${tag}>`;
      }
      if (/^#{1,4}\s/.test(chunk)) return `<h4>${inline(chunk.replace(/^#+\s*/, ''))}</h4>`;
      return `<p>${inline(chunk.replace(/\s*\n\s*/g, ' '))}</p>`;
    }).join('');
  }
  /** The first sentence of a description, for one-line summaries. */
  const firstSentence = text => (text || '').split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').replace(/^(.{0,180}?[.!?])\s.*$/, '$1');

  /* ---------- Schema helpers ---------- */
  const refName = s => s && s.$ref ? s.$ref.split('/').pop() : undefined;
  /** Follows $ref chains to the target schema (cycle-safe). */
  function resolve(s) {
    let current = s; const seen = new Set();
    while (current && current.$ref && !seen.has(current.$ref)) { seen.add(current.$ref); current = schemas[refName(current)]; }
    return current || {};
  }
  const isNull = s => s && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'));
  /** Splits "string | null" style schemas into the real schema and a nullable flag. */
  function unwrapNull(s) {
    if (!s) return { schema: {}, nullable: false };
    for (const key of ['oneOf', 'anyOf']) {
      if (Array.isArray(s[key]) && s[key].some(isNull)) {
        const rest = s[key].filter(x => !isNull(x));
        if (rest.length === 1) return { schema: { ...rest[0], ...omit(s, [key]) }, nullable: true };
        return { schema: { ...s, [key]: rest }, nullable: true };
      }
    }
    if (Array.isArray(s.type) && s.type.includes('null')) {
      const types = s.type.filter(x => x !== 'null');
      return { schema: { ...s, type: types.length === 1 ? types[0] : types }, nullable: true };
    }
    return { schema: s, nullable: !!s.nullable };
  }
  const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const typeOf = s => {
    const r = resolve(s);
    if (r.oneOf) return 'oneOf'; if (r.anyOf) return 'anyOf'; if (r.allOf) return 'allOf';
    if (Array.isArray(r.type)) return r.type.filter(x => x !== 'null')[0] || 'any';
    return r.type || (r.properties ? 'object' : r.items ? 'array' : r.enum ? 'string' : 'any');
  };
  /** Properties of an object, merging allOf parts and their required lists. */
  const asSchema = s => typeof s === 'string' ? { $ref: `#/components/schemas/${s}` } : s;
  function propertiesOf(s) {
    const r = resolve(asSchema(s));
    let props = { ...(r.properties || {}) }, required = new Set(r.required || []), sources = [];
    for (const part of r.allOf || []) {
      const p = propertiesOf(part);
      if (refName(part)) sources.push(refName(part));
      props = { ...p.props, ...props };
      p.required.forEach(x => required.add(x));
    }
    return { props, required, sources };
  }
  const variantsOf = s => { const r = resolve(s); return (r.oneOf || r.anyOf || []).filter(x => !isNull(x)); };
  /** Discriminator: the property and each value's target model. */
  function discriminatorOf(s) {
    const r = resolve(s);
    if (!r.discriminator) return undefined;
    const map = Object.entries(r.discriminator.mapping || {}).map(([value, ref]) => [value, ref.split('/').pop()]);
    if (!map.length) for (const v of variantsOf(r)) map.push([refName(v), refName(v)]);
    return { prop: r.discriminator.propertyName, map };
  }
  /** "CustomerReference", "string[]", "one of 3", "decimal": the label after a property name. */
  function typeLabel(s) {
    const { schema } = unwrapNull(s);
    const name = refName(schema);
    if (name) return { text: name, ref: name };
    const r = resolve(schema);
    if (r.oneOf || r.anyOf) return { text: t('schema.oneOf', { n: variantsOf(r).length }) };
    if (r.allOf) { const base = r.allOf.map(refName).find(Boolean); return base ? { text: base, ref: base } : { text: 'object' }; }
    const type = typeOf(r);
    if (type === 'array') {
      const inner = typeLabel(r.items || {});
      return { text: inner.text + '[]', ref: inner.ref, array: true };
    }
    return { text: type === 'number' && r.format === 'decimal' ? 'decimal' : type };
  }
  /** Something to show under the row: object properties, array items or a composition. */
  function expandable(s) {
    const { schema } = unwrapNull(s);
    const r = resolve(schema);
    const type = typeOf(r);
    if (type === 'object') return Object.keys(propertiesOf(r).props).length > 0;
    if (type === 'array') return expandable(r.items || {});
    return ['oneOf', 'anyOf', 'allOf'].includes(type);
  }

  const short = (v, n = 28) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  /** Uniform "key value" chips for format and every constraint, in one fixed order. */
  function chips(s, nullable) {
    const r = { ...resolve(s), ...omit(s, ['$ref']) };
    const out = [];
    const chip = (k, v, title) => out.push(`<span class="chip"${title ? ` title="${esc(title)}"` : ''}><span class="k">${k}</span>${v === undefined ? '' : `<span class="v">${esc(v)}</span>`}</span>`);
    const fmt = r.format && !(r.format === 'decimal' && typeOf(r) === 'number') ? r.format : r.format === 'decimal' ? 'decimal' : undefined;
    if (fmt && typeOf(r) !== 'array') chip(t('chip.format'), fmt);
    if (r.minimum !== undefined) chip(t('chip.min'), r.minimum);
    if (r.exclusiveMinimum !== undefined) chip(t('chip.gt'), r.exclusiveMinimum);
    if (r.maximum !== undefined) chip(t('chip.max'), r.maximum);
    if (r.multipleOf !== undefined) chip(t('chip.step'), r.multipleOf);
    if (r.minLength !== undefined && r.maxLength !== undefined) chip(t('chip.length'), `${r.minLength}–${r.maxLength}`);
    else if (r.minLength !== undefined) chip(t('chip.minLength'), r.minLength);
    else if (r.maxLength !== undefined) chip(t('chip.maxLength'), r.maxLength);
    if (r.pattern) chip(t('chip.pattern'), short(r.pattern, 22), r.pattern);
    if (r.minItems !== undefined || r.maxItems !== undefined) chip(t('chip.items'), r.minItems !== undefined && r.maxItems !== undefined ? `${r.minItems}–${r.maxItems}` : r.maxItems !== undefined ? `≤ ${r.maxItems}` : `≥ ${r.minItems}`);
    if (r.uniqueItems) chip(t('chip.unique'));
    if (r.default !== undefined) chip(t('chip.default'), short(r.default));
    if (r.readOnly) chip(t('chip.readOnly'));
    if (r.writeOnly) chip(t('chip.writeOnly'));
    if (nullable) chip(t('chip.nullable'));
    if (r.deprecated) chip(t('chip.deprecated'));
    return out.join('');
  }
  const exampleValue = s => {
    const r = { ...resolve(s), ...omit(s || {}, ['$ref']) };
    if (r.example !== undefined) return r.example;
    if (Array.isArray(r.examples) && r.examples.length) return r.examples[0];
    return undefined;
  };

  /* ---------- Property tree ---------- */
  // opts: expanded (Set of dotted paths to expand), collapsed (Set to force closed), expandAll,
  //       variant ({ path: variantName }), highlight (path), compact (no detail lines),
  //       present (Set of paths returned by a response, for the Schema view), id (prefix).
  function rows(s, opts, depth = 0, path = '', seen = new Set()) {
    const { props, required } = propertiesOf(s);
    return Object.entries(props).map(([name, raw]) => row(name, raw, required.has(name), opts, depth, path ? `${path}.${name}` : name, seen)).join('');
  }

  function row(name, raw, req, opts, depth, path, seen) {
    const { schema, nullable } = unwrapNull(raw);
    const r = resolve(schema);
    const label = typeLabel(schema);
    const target = label.ref;
    const recursive = target && seen.has(target);
    const canOpen = expandable(schema) && !recursive;
    // Inline objects open by default; $refs open on request (inline expansion) or with Expand all.
    const open = canOpen && !opts.collapsed?.has(path) && (opts.expandAll || opts.expanded?.has(path) || (!target && depth < 2));
    const desc = raw.description || schema.description || (target ? undefined : r.description);
    const values = r.enum || (r.items && resolve(r.items).enum);
    const example = exampleValue(raw) ?? (target ? undefined : exampleValue(r));
    const chipHtml = chips(schema, nullable);
    const hl = opts.highlight === path;
    const present = opts.present ? opts.present.has(path) : undefined;
    const id = `${opts.id || 'p'}-${path.replace(/\W/g, '-')}`;

    const toggle = canOpen
      ? `<button class="sr-toggle" aria-label="${open ? t('schema.collapse', { name }) : t('schema.expand', { name })}" aria-controls="${id}-kids" tabindex="-1">${ico(open ? 'chevron-down' : 'chevron-right', 'i i-sm')}</button>`
      : `<span class="sr-toggle" aria-hidden="true"></span>`;
    const type = target
      ? `<a class="sr-type is-ref" href="#" title="${t('schema.openModel', { name: target })}">${esc(label.text)}</a>`
      : `<span class="sr-type">${esc(label.text)}</span>`;
    const detail = opts.compact ? '' : `
      <div class="sr-body">
        ${desc ? `<div class="sr-desc" lang="en">${md(desc, { block: false })}</div>` : target ? `<div class="sr-desc is-quiet">${t('schema.seeModel', { name: target })}</div>` : `<div class="sr-desc is-quiet">${t('schema.noDesc')}</div>`}
        ${chipHtml ? `<div class="sr-chips">${chipHtml}</div>` : ''}
        ${values ? `<div class="sr-line"><span class="sr-k">${t('schema.values')}</span><span class="sr-enum">${values.slice(0, 12).map(v => `<code>${esc(v)}</code>`).join('')}${values.length > 12 ? `<span class="faint">${t('schema.more', { n: values.length - 12 })}</span>` : ''}</span></div>` : ''}
        ${example !== undefined && typeof example !== 'object' ? `<div class="sr-line"><span class="sr-k">${t('schema.example')}</span><code class="sr-ex">${esc(short(example, 60))}</code></div>` : ''}
      </div>`;

    let kids = '';
    if (open) {
      const nextSeen = new Set(seen); if (target) nextSeen.add(target);
      const inner = typeOf(r) === 'array' ? resolve(r.items) : r;
      const innerRaw = typeOf(r) === 'array' ? r.items : schema;
      if (inner.oneOf || inner.anyOf) kids = variantRows(innerRaw, opts, depth + 1, path, nextSeen);
      else kids = rows(innerRaw, opts, depth + 1, typeOf(r) === 'array' ? path + '[]' : path, nextSeen);
    }
    return `<div class="sr${hl ? ' is-hl' : ''}${present === false ? ' is-absent' : ''}" role="treeitem" aria-level="${depth + 1}" ${canOpen ? `aria-expanded="${open}"` : ''} style="--d:${depth}">
        <div class="sr-head">
          ${toggle}
          ${present !== undefined ? `<span class="sr-mark${present ? ' on' : ''}" aria-hidden="true"></span>` : ''}
          <code class="sr-name">${esc(name)}</code>${type}
          ${recursive ? `<span class="chip"><span class="k">${t('schema.recursive')}</span></span>` : ''}
          <span class="spacer"></span>
          <span class="sr-req${req ? ' is-req' : ''}">${req ? t('schema.required') : t('optional')}</span>
        </div>${detail}
      </div>${kids ? `<div role="group" id="${id}-kids">${kids}</div>` : ''}`;
  }

  /** A composition inside the tree: which variant applies and how it's chosen, then its rows. */
  function variantRows(s, opts, depth, path, seen) {
    const variants = variantsOf(s);
    const disc = discriminatorOf(s);
    const chosen = opts.variant?.[path] || refName(variants[0]) || '0';
    const pick = variants.find(v => refName(v) === chosen) || variants[0];
    const value = disc?.map.find(([, target]) => target === chosen)?.[0];
    return `<div class="sr sr-variants" role="treeitem" aria-level="${depth + 1}" style="--d:${depth}">
        <div class="sr-head"><span class="sr-toggle" aria-hidden="true"></span>
          <span class="sr-k">${disc ? t('schema.chosenBy') : t('schema.oneOfHead', { n: variants.length })}</span>${disc ? `<code class="sr-name">${esc(disc.prop)}</code>` : ''}
          <div class="segmented sr-pick" role="radiogroup" aria-label="${t('schema.variant')}">${variants.map(v => {
            const n = refName(v) || 'inline';
            const val = disc?.map.find(([, target]) => target === n)?.[0];
            return `<button role="radio" aria-checked="${n === chosen}">${val ? `<span class="mono">${esc(val)}</span>` : esc(n)}</button>`;
          }).join('')}</div>
        </div>
        <div class="sr-body"><div class="sr-desc is-quiet">${value ? t('schema.whenValue', { prop: disc.prop, value: esc(value), name: `<a class="type-link" href="#">${esc(chosen)}</a>` }) : `<a class="type-link" href="#">${esc(chosen)}</a>`}</div></div>
      </div>${rows(pick, opts, depth, path, seen)}`;
  }

  /** The tree for a model or any schema. Top-level compositions start with the variant row. */
  function tree(s, opts = {}) {
    const schema = typeof s === 'string' ? { $ref: `#/components/schemas/${s}` } : s;
    const r = resolve(schema);
    const label = typeof s === 'string' ? s : refName(schema) || 'Body';
    const body = r.oneOf || r.anyOf ? variantRows(schema, opts, 0, '', new Set([refName(schema)]))
      : typeOf(r) === 'array' ? rows(r.items, opts, 0, '[]', new Set([refName(r.items)]))
      : rows(schema, opts, 0, '', new Set([refName(schema)]));
    return `<div class="stree" role="tree" aria-label="${t('schema.treeLabel', { name: esc(label) })}">${body}</div>`;
  }

  /** Counts for headings: properties, required ones, and how many expand. */
  function stats(s) {
    const { props, required } = propertiesOf(asSchema(s));
    return { count: Object.keys(props).length, required: required.size, nested: Object.values(props).filter(expandable).length };
  }

  /* ---------- Usage ---------- */
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  /** Every operation in document order, with what the viewers need. */
  const operations = Object.entries(spec.paths || {}).flatMap(([path, item]) => METHODS.filter(m => item[m]).map(method => {
    const op = item[method];
    return { method, path, op, id: op.operationId || `${method} ${path}`, summary: op.summary || `${method.toUpperCase()} ${path}`, tag: op.tags?.[0] || 'Other',
      secured: !!(op.security ?? spec.security)?.some(req => Object.keys(req).length), deprecated: !!op.deprecated,
      roles: [...new Set((op.security || []).flatMap(req => Object.values(req).flat()))] };
  }));
  /** Collects model names referenced anywhere under a schema. */
  function refsIn(s, out = new Set(), depth = 0) {
    if (!s || typeof s !== 'object' || depth > 6) return out;
    if (s.$ref) { out.add(refName(s)); return out; }
    for (const v of Object.values(s)) if (v && typeof v === 'object') refsIn(v, out, depth + 1);
    return out;
  }
  /** Operations that use a model directly, and where: request body, response 200, parameter. */
  function usedBy(name) {
    const out = [];
    for (const o of operations) {
      const body = o.op.requestBody?.content && Object.values(o.op.requestBody.content)[0]?.schema;
      if (body && refsIn(body).has(name)) out.push({ ...o, where: t('used.request') });
      const codes = Object.entries(o.op.responses || {}).filter(([, res]) => {
        const media = res.content && Object.values(res.content)[0]?.schema;
        return media && refsIn(media).has(name);
      }).map(([code]) => code);
      if (codes.length) out.push({ ...o, where: t('used.response', { code: codes.join(' · ') }) });
    }
    // Models that reference it, for the "Referenced by" list.
    const models = Object.entries(schemas).filter(([other, s]) => other !== name && refsIn(s).has(name)).map(([other]) => other);
    // Nothing uses it directly (a union or a nested part): list the operations of the models
    // that contain it, so the page still answers "where does this appear?".
    const via = out.length ? [] : models.flatMap(m => usedBy(m).operations.map(o => ({ ...o, where: t('used.via', { name: m }) })))
      .filter((o, i, all) => all.findIndex(x => x.id === o.id) === i);
    return { operations: out, models, via };
  }
  const kindOf = name => { const r = schemas[name] || {}; return r.enum ? 'enum' : r.oneOf || r.anyOf ? 'oneOf' : r.allOf ? 'allOf' : typeOf(r) === 'array' ? 'array' : 'object'; };

  /* ---------- Examples ---------- */
  const FORMAT_EXAMPLES = { uuid: '3f9c0000-0000-4000-8000-00000000a21e', date: '2026-11-23', 'date-time': '2026-11-20T14:02:11Z', email: 'ada.admin@acme.dev', uri: 'https://api.acme.dev' };
  /** The spec's example, or one built from property examples, enums and formats. */
  function exampleOf(s, depth = 0, seen = new Set()) {
    const { schema } = unwrapNull(s);
    const own = exampleValue(schema);
    if (own !== undefined) return own;
    const name = refName(schema);
    if (name && (seen.has(name) || depth > 4)) return {};
    const r = resolve(schema);
    const next = new Set(seen); if (name) next.add(name);
    if (r.oneOf || r.anyOf) return exampleOf(variantsOf(r)[0], depth + 1, next);
    switch (typeOf(r)) {
      case 'object': return Object.fromEntries(Object.entries(propertiesOf(r).props).map(([k, v]) => [k, exampleOf(v, depth + 1, next)]));
      case 'array': return [exampleOf(r.items || {}, depth + 1, next)];
      case 'integer': return r.minimum ?? 1;
      case 'number': return r.minimum ?? 0;
      case 'boolean': return false;
      default: return r.enum?.[0] ?? FORMAT_EXAMPLES[r.format] ?? 'string';
    }
  }

  /* ---------- JSON viewer ---------- */
  // Every object and array is open unless the body is very large: then nesting below depth 1
  // starts collapsed and the viewer says so. A collapsed node shows its size and a label.
  const LARGE_LINES = 2000;
  const tok = v => v === null ? '<span class="tok-b">null</span>'
    : typeof v === 'string' ? `<span class="tok-s">${esc(JSON.stringify(v))}</span>`
    : typeof v === 'number' ? `<span class="tok-n">${v}</span>` : `<span class="tok-b">${v}</span>`;
  const labelOf = v => v && typeof v === 'object' && !Array.isArray(v) ? (v.number || v.name || v.title || v.reference || v.displayName || v.sku || v.code || v.id) : undefined;
  const countLines = v => v && typeof v === 'object' ? 2 + Object.values(v).reduce((n, x) => n + countLines(x), 0) : 1;
  function jsonLines(value, { collapseBelow } = {}) {
    const lines = [];
    const walk = (v, d, key, last) => {
      const k = key === undefined ? '' : `<span class="tok-k">${esc(JSON.stringify(key))}</span><span class="tok-p">: </span>`;
      const comma = last ? '' : '<span class="tok-p">,</span>';
      if (v && typeof v === 'object') {
        const arr = Array.isArray(v);
        const entries = arr ? v.map((x, i) => [undefined, x]) : Object.entries(v);
        const [o, c] = arr ? ['[', ']'] : ['{', '}'];
        if (!entries.length) { lines.push({ d, html: `${k}<span class="tok-p">${o}${c}</span>${comma}` }); return; }
        if (collapseBelow !== undefined && d >= collapseBelow) {
          const label = labelOf(v);
          const size = arr ? t('json.items', { n: entries.length }) : t('json.keys', { n: entries.length });
          lines.push({ d, fold: 'closed', html: `${k}<span class="tok-p">${o}</span><span class="folded">${size}${label ? ` · ${esc(short(label, 32))}` : ''}</span><span class="tok-p">${c}</span>${comma}` });
          return;
        }
        lines.push({ d, fold: 'open', html: `${k}<span class="tok-p">${o}</span>` });
        entries.forEach(([ck, cv], i) => walk(cv, d + 1, arr ? undefined : ck, i === entries.length - 1));
        lines.push({ d, html: `<span class="tok-p">${c}</span>${comma}` });
      } else lines.push({ d, html: `${k}${tok(v)}${comma}` });
    };
    walk(value, 0, undefined, true);
    return lines;
  }
  /** Renders a JSON value; large values auto-collapse below depth 2 and report it. */
  function jsonView(value, { label = 'JSON', maxLines, collapseAll = false } = {}) {
    const total = countLines(value);
    const large = total > LARGE_LINES;
    const lines = jsonLines(value, { collapseBelow: collapseAll ? 1 : large ? 2 : undefined });
    const shown = maxLines ? lines.slice(0, maxLines) : lines;
    return { large, total, lines: lines.length, html: `<div class="code-view ltr" role="tree" aria-label="${esc(label)}">${shown.map((l, i) => `<div class="ln" role="treeitem" aria-level="${l.d + 1}" ${l.fold ? `aria-expanded="${l.fold === 'open'}"` : ''}>
        <span class="no" aria-hidden="true">${i + 1}</span><span class="fold" aria-hidden="true">${l.fold ? ico(l.fold === 'open' ? 'chevron-down' : 'chevron-right', 'i i-sm') : ''}</span>
        <span class="src" style="--d:${l.d}">${l.html}</span></div>`).join('')}</div>` };
  }

  window.TB.schema = { spec, schemas, esc, md, firstSentence, resolve, refName, unwrapNull, typeOf, typeLabel, propertiesOf, variantsOf, discriminatorOf, expandable, chips, tree, rows, stats, operations, usedBy, kindOf, exampleOf, jsonLines, jsonView, countLines };
})();

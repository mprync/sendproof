// v6 (?v6=1, with v5=1): the NoSQL data-store screens, on top of the v5 workbench.
// Spec: spec/data-stores.md. Plan: docs/plans/data-stores.md, "Workbench UI changes".
// Without ?v6 nothing here runs, so every v3, v4 and v5 screen renders exactly as before.
//
// Builders (window.SP, also used by stores.html):
//   docCard(change)   a MongoDB change as a nested document diff: every object open, changed
//                     paths tinted, arrays compared by index, Extended JSON as typed badges,
//                     [REDACTED] in its own muted style. Insert, update, delete, plus the
//                     "via upsert" and "whole document replaced" qualifiers.
//   rowCard(change)   a SQL row change in the existing card style.
//   database()        the Database tab grouped by store, each group under its vendor mark.
//   logs()            the log table with Db entries: store chips beside the SQL filter,
//                     highlighted commands, redacted parameters, copy buttons.
//
// Scenes (?nosql=…), each on a real operation from mocks/spec.js:
//   changes   Ship order, a Preview that changed SQL rows and MongoDB documents
//             (dscroll=orders brings the orders document to the top)
//   logs      the same Preview's Logs tab (open=mongo|redis|dynamo, copied=cmd)
//   known     Price cart, marked preview: false: Preview disabled, the reason docked at
//             the button (confirm=1 shows Send's confirmation)
//   blocked   Redeem coupon, a Preview stopped by the write guard at Redis INCRBY (409)
// Other parameters: theme=dark, lang=de|ar, text=130, mview=result (phones).
(function () {
  const TB = window.TB;
  const { q, ico, kbd, aks, tab, copyBtn, copyTextBtn } = TB;
  if (!q.v6) return;
  document.documentElement.dataset.v6 = '';
  // v6.css loads only with ?v6=1 (parser-inserted, so the panes below are styled when measured).
  if (!document.querySelector('link[href="v6.css"]')) document.write('<link rel="stylesheet" href="v6.css">');
  const { logo, stores } = window.SP;
  const { num, unit, decimal, date, weekday, lang } = window.i18n;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Icons v6 needs.
  document.querySelector('svg[style*="display:none"]')?.insertAdjacentHTML('beforeend', [
    ['flask-off', '<path d="M9 3h6"/><path d="M10 3v4.5M14 3v6l2.2 4.1"/><path d="M8.6 11.4 4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 .9-.25"/><path d="M3 3l18 18"/>'],
    ['ban', '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>'],
    ['circle-check', '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'],
    ['shield-check', '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>'],
    ['minus', '<path d="M5 12h14"/>'],
    ['tilde', '<path d="M5 13.5c1.5-2 3-2.5 4.5-1.5s3 1.5 4.5 0 3-2 5-.5"/>'],
  ].map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join(''));

  /* ---------- Strings ---------- */
  // English is complete; German and Arabic carry the Preview-unavailable screens (README v6).
  // API authors' text (the preview: false reason) stays in English and is marked lang="en".
  const STR = {
    en: {
      brand: 'Sendproof',
      'pv.title': 'Preview unavailable', 'pv.why': 'Redis can’t roll back, so Sendproof won’t run a Preview of this operation. Send commits for real and asks first.',
      'pv.by': 'Marked by the API author', 'pv.learn': 'Why?', 'pv.status': 'Send only · asks before it commits', 'pv.tip': 'Preview unavailable: writes to Redis',
      'pv.step': 'Preview isn’t available here', 'pv.emptyBody': 'Run the request to see the status, body and timing. This operation writes to Redis, which can’t roll back, so it can only be sent for real.',
      'pv.side': 'No Preview', 'cf.status': 'Send for real? This writes to Redis and can’t be undone.', 'cf.cancel': 'Cancel', 'cf.confirm': 'Confirm send',
      'blk.code': 'Preview unavailable', 'blk.eyebrow': 'Blocked by the write guard',
      'blk.title': 'Preview stopped before writing to {store}', 'blk.body': 'The handler sent {op} to {store}. {store} can’t roll back, so Sendproof refused the command before it left the API.',
      'blk.safe': 'Nothing was written', 'blk.safeNote': 'A blocked Preview keeps nothing else either: no body, changes, logs or effects.',
      'blk.refused': '{op} refused, never sent', 'blk.rolled': 'Rolled back', 'blk.effects': 'Side effects', 'blk.held': '2 held, then discarded',
      'blk.next': 'What to do next', 'blk.send': 'Send for real', 'blk.sendNote': 'Commits for real and asks first. Traced Send records the rows, documents and commands as they’re committed.',
      'blk.author': 'For the API author', 'blk.authorBody': 'Mark the route with {code} so the Preview button explains this before anyone runs it.',
      'blk.copy': 'Copy', 'blk.raw': 'Response body', 'blk.lastBar': 'Last Preview blocked · Redis write', 'blk.ranAt': 'Preview blocked at 14:02:11 as Ada Admin',
      'blk.copyCurl': 'Copy as cURL', 'blk.sendReal': 'Send for real',
    },
    de: {
      'pv.title': 'Vorschau nicht verfügbar', 'pv.why': 'Redis kann nicht zurückrollen, deshalb führt Sendproof für diese Operation keine Vorschau aus. Senden speichert wirklich und fragt vorher nach.',
      'pv.by': 'Vom API-Autor markiert', 'pv.learn': 'Warum?', 'pv.status': 'Nur Senden · fragt vor dem Speichern nach', 'pv.tip': 'Vorschau nicht verfügbar: schreibt in Redis',
      'pv.step': 'Vorschau hier nicht verfügbar', 'pv.emptyBody': 'Führen Sie die Anfrage aus, um Status, Inhalt und Dauer zu sehen. Diese Operation schreibt in Redis, das nicht zurückrollen kann; sie lässt sich nur wirklich senden.',
      'pv.side': 'Keine Vorschau', 'cf.status': 'Wirklich senden? Das schreibt in Redis und lässt sich nicht rückgängig machen.', 'cf.cancel': 'Abbrechen', 'cf.confirm': 'Senden bestätigen',
      'blk.code': 'Vorschau nicht verfügbar', 'blk.eyebrow': 'Vom Schreibschutz blockiert',
      'blk.title': 'Vorschau vor dem Schreiben in {store} gestoppt', 'blk.body': 'Der Handler hat {op} an {store} gesendet. {store} kann nicht zurückrollen, deshalb hat Sendproof den Befehl abgelehnt, bevor er die API verlassen hat.',
      'blk.safe': 'Nichts wurde geschrieben', 'blk.safeNote': 'Eine blockierte Vorschau behält auch sonst nichts: keinen Inhalt, keine Änderungen, Logs oder Nebenwirkungen.',
      'blk.refused': '{op} abgelehnt, nie gesendet', 'blk.rolled': 'Zurückgerollt', 'blk.effects': 'Nebenwirkungen', 'blk.held': '2 zurückgehalten, dann verworfen',
      'blk.next': 'Wie es weitergeht', 'blk.send': 'Wirklich senden', 'blk.sendNote': 'Speichert wirklich und fragt vorher nach. Protokolliertes Senden zeichnet Zeilen, Dokumente und Befehle beim Speichern auf.',
      'blk.author': 'Für den API-Autor', 'blk.authorBody': 'Markieren Sie die Route mit {code}, damit die Vorschau-Schaltfläche das erklärt, bevor jemand sie ausführt.',
      'blk.copy': 'Kopieren', 'blk.raw': 'Antwortinhalt', 'blk.lastBar': 'Vorschau blockiert · Redis', 'blk.ranAt': 'Vorschau um 14:02:11 als Ada Admin blockiert',
      'blk.copyCurl': 'Als cURL kopieren', 'blk.sendReal': 'Wirklich senden',
    },
    ar: {
      'pv.title': 'المعاينة غير متاحة', 'pv.why': 'لا يستطيع Redis التراجع عن التغييرات، لذلك لا يشغّل Sendproof معاينة لهذه العملية. الإرسال يحفظ فعلياً ويطلب التأكيد أولاً.',
      'pv.by': 'حدّدها مؤلف الواجهة البرمجية', 'pv.learn': 'لماذا؟', 'pv.status': 'إرسال فقط · يطلب التأكيد قبل الحفظ', 'pv.tip': 'المعاينة غير متاحة: تكتب في Redis',
      'pv.step': 'المعاينة غير متاحة هنا', 'pv.emptyBody': 'شغّل الطلب لترى الحالة والمحتوى والتوقيت. هذه العملية تكتب في Redis الذي لا يستطيع التراجع، لذا لا يمكن إلا إرسالها فعلياً.',
      'pv.side': 'بلا معاينة', 'cf.status': 'إرسال فعلي؟ هذا يكتب في Redis ولا يمكن التراجع عنه.', 'cf.cancel': 'إلغاء', 'cf.confirm': 'تأكيد الإرسال',
      'blk.code': 'المعاينة غير متاحة', 'blk.eyebrow': 'أوقفها حارس الكتابة',
      'blk.title': 'توقفت المعاينة قبل الكتابة في {store}', 'blk.body': 'أرسل المعالج الأمر {op} إلى {store}. لا يستطيع {store} التراجع، لذلك رفض Sendproof الأمر قبل أن يغادر الواجهة البرمجية.',
      'blk.safe': 'لم يُكتب أي شيء', 'blk.safeNote': 'المعاينة المحظورة لا تحتفظ بشيء آخر أيضاً: لا محتوى ولا تغييرات ولا سجلات ولا آثار.',
      'blk.refused': 'رُفض {op} ولم يُرسل', 'blk.rolled': 'تم التراجع', 'blk.effects': 'الآثار الجانبية', 'blk.held': 'احتُجز أثران ثم أُلغيا',
      'blk.next': 'ماذا تفعل بعد ذلك', 'blk.send': 'إرسال فعلي', 'blk.sendNote': 'يحفظ فعلياً ويطلب التأكيد أولاً. الإرسال مع التتبع يسجّل الصفوف والمستندات والأوامر أثناء حفظها.',
      'blk.author': 'لمؤلف الواجهة البرمجية', 'blk.authorBody': 'حدّد المسار بـ {code} لكي يشرح زر المعاينة ذلك قبل أن يشغّله أحد.',
      'blk.copy': 'نسخ', 'blk.raw': 'محتوى الاستجابة', 'blk.lastBar': 'حُظرت آخر معاينة · Redis', 'blk.ranAt': 'حُظرت المعاينة الساعة 14:02:11 باسم Ada Admin',
      'blk.copyCurl': 'نسخ كأمر cURL', 'blk.sendReal': 'إرسال فعلي',
    },
  };
  const s = (key, vars = {}) => String(STR[lang]?.[key] ?? STR.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

  /* ---------- Values: Extended JSON, redaction, scalars ---------- */
  const EXT = { $oid: 'ObjectId', $date: 'Date', $numberDecimal: 'Decimal128', $numberLong: 'Int64', $binary: 'Binary', $uuid: 'UUID' };
  const extOf = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && EXT[Object.keys(v)[0]] ? Object.keys(v)[0] : null;
  const isBranch = v => v && typeof v === 'object' && !extOf(v);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** One value as it reads in the diff: typed badges for Extended JSON, a muted pill for secrets. */
  function val(v) {
    const ext = extOf(v);
    if (ext) { const raw = v[ext]; return `<span class="xt6"><span class="xt6-t">${EXT[ext]}</span><span class="xt6-v" dir="ltr">${esc(typeof raw === 'object' ? JSON.stringify(raw) : raw)}</span></span>`; }
    if (v === '[REDACTED]') return `<span class="rd6" title="A secret field: Sendproof never captures its value">${ico('lock', 'i i-sm')}redacted</span>`;
    if (v === null) return '<span class="j6-null">null</span>';
    if (typeof v === 'string') return `<span class="j6-s" dir="ltr">"${esc(v)}"</span>`;
    if (typeof v === 'number') return `<span class="j6-n">${v}</span>`;
    if (typeof v === 'boolean') return `<span class="j6-b">${v}</span>`;
    return esc(JSON.stringify(v));
  }
  const fieldsWord = n => n === 1 ? '1 field' : `${n} fields`;
  const itemsWord = n => n === 1 ? '1 item' : `${n} items`;

  /* ---------- Nested document diff ---------- */
  /**
   * Flattens before/after into tree rows. kind: same | chg | add | del; a branch also carries
   * `inner` (how many changes sit below it). Objects keep the after order, with removed keys
   * where they were; arrays compare by index.
   */
  function diffRows(before, after, depth = 0, out = [], path = '') {
    const keys = [];
    const push = k => { if (!keys.includes(k)) keys.push(k); };
    if (Array.isArray(before) || Array.isArray(after)) {
      const n = Math.max(before?.length || 0, after?.length || 0);
      for (let i = 0; i < n; i++) push(i);
    } else {
      const b = Object.keys(before || {}), a = Object.keys(after || {});
      a.forEach(push);
      b.forEach((k, i) => { if (!a.includes(k)) keys.splice(Math.min(keys.length, i), 0, k); });
    }
    for (const k of keys) {
      const has = x => x != null && (Array.isArray(x) ? k < x.length : Object.prototype.hasOwnProperty.call(x, k));
      const inB = has(before), inA = has(after);
      const bv = inB ? before[k] : undefined, av = inA ? after[k] : undefined;
      const kind = !inB ? 'add' : !inA ? 'del' : same(bv, av) ? 'same' : 'chg';
      const p = path ? (typeof k === 'number' ? `${path}[${k}]` : `${path}.${k}`) : String(k);
      const branchV = kind === 'del' ? bv : av;
      if (isBranch(branchV) && (kind !== 'chg' || isBranch(bv))) {
        const row = { depth, key: k, index: typeof k === 'number', kind: kind === 'chg' ? 'same' : kind, branch: Array.isArray(branchV) ? 'array' : 'object', size: Object.keys(branchV).length, path: p, inner: 0 };
        out.push(row);
        const start = out.length;
        diffRows(kind === 'add' ? undefined : bv, kind === 'del' ? undefined : av, depth + 1, out, p);
        if (kind === 'add' || kind === 'del') out.slice(start).forEach(r => { r.kind = kind; r.inherit = true; });
        row.inner = out.slice(start).filter(r => r.kind !== 'same' && !r.inherit && !r.branch).length + out.slice(start).filter(r => r.branch && (r.kind === 'add' || r.kind === 'del') && !r.inherit).length;
      } else out.push({ depth, key: k, index: typeof k === 'number', kind, before: bv, after: av, path: p });
    }
    return out;
  }
  /** Counts for the card head: leaves changed, branches or leaves added and removed. */
  function tally(rows) {
    const top = rows.filter(r => !r.inherit);
    return { chg: top.filter(r => r.kind === 'chg').length, add: top.filter(r => r.kind === 'add').length, del: top.filter(r => r.kind === 'del').length };
  }
  const MARK = { chg: '~', add: '+', del: '−', same: '' };
  function treeRow(r, mode) {
    const kind = mode === 'insert' ? 'add' : mode === 'delete' ? 'del' : r.kind;
    const tint = mode === 'update' && kind !== 'same' ? ` is-${kind}${r.inherit ? ' is-inherit' : ''}` : ` is-plain-${kind}`;
    const key = r.index ? `<span class="dt6-k is-idx" dir="ltr">${r.key}</span>` : `<span class="dt6-k" dir="ltr">${esc(r.key)}</span>`;
    const mark = `<span class="dt6-mk" aria-hidden="true">${mode === 'update' ? (r.inherit ? '' : MARK[kind]) : MARK[kind]}</span>`;
    let value;
    if (r.branch) {
      const open = r.branch === 'array' ? '[' : '{';
      const meta = r.branch === 'array' ? itemsWord(r.size) : fieldsWord(r.size);
      value = `<span class="dt6-meta"><span class="br">${open}</span>${meta}${mode === 'update' && r.inner && r.kind === 'same' ? `<span class="dt6-inner">${r.inner === 1 ? '1 change' : `${r.inner} changes`}</span>` : ''}</span>`;
    } else if (kind === 'chg') {
      value = `<span class="dt6-v">${val(r.before)}<span class="dt6-arrow" aria-hidden="true">→</span><span class="sr-only">changed to</span>${val(r.after)}</span>`;
    } else value = `<span class="dt6-v">${val(kind === 'del' ? r.before : r.after)}</span>`;
    const tw = r.branch ? `<span class="dt6-tw" aria-hidden="true">${ico('chevron-down', 'i i-sm')}</span>` : '<span class="dt6-tw"></span>';
    return `<div class="dt6-row${tint}${r.branch ? ' is-branch' : ''}" role="treeitem" aria-level="${r.depth + 1}"${r.branch ? ' aria-expanded="true"' : ''} style="--d:${r.depth}">${mark}<span class="dt6-in">${tw}${key}${value}</span></div>`;
  }

  /**
   * A document change card. change: { op: insert|update|delete, via: upsert|replace,
   * collection, ns, id (Extended JSON or string), before, after }.
   */
  function docCard(c, o = {}) {
    const mode = c.op;
    const rows = diffRows(mode === 'insert' ? undefined : c.before, mode === 'delete' ? undefined : c.after);
    const n = tally(rows);
    const badge = { insert: ['ins', '+ INSERT'], update: ['upd', '~ UPDATE'], delete: ['del', '− DELETE'] }[mode];
    const via = c.via === 'upsert' ? 'via upsert' : c.via === 'replace' ? 'whole document replaced' : '';
    const fields = Object.keys((mode === 'delete' ? c.before : c.after) || {}).length;
    const sum = mode === 'update'
      ? [n.chg && `<span class="c6 c-upd">${n.chg} changed</span>`, n.add && `<span class="c6 c-ins">${n.add} added</span>`, n.del && `<span class="c6 c-del">${n.del} removed</span>`].filter(Boolean).join('')
      : `<span class="c6 c-${badge[0]}">${mode === 'insert' ? 'New document' : 'Document removed'} · ${fieldsWord(fields)}</span>`;
    const views = mode === 'update' ? `<div class="segmented sm" role="radiogroup" aria-label="Show"><button role="radio" aria-checked="true">Diff</button><button role="radio" aria-checked="false">Before</button><button role="radio" aria-checked="false">After</button></div>` : '';
    return `<article class="doc6 is-${mode}" id="doc-${esc(c.collection)}" aria-label="${esc(c.collection)}: document ${mode === 'insert' ? 'inserted' : mode === 'delete' ? 'deleted' : 'updated'}">
      <header class="doc6-head">
        <span class="op-badge op-${badge[0]}">${badge[1]}</span><span class="doc6-coll" dir="ltr">${esc(c.collection)}</span>${via ? `<span class="doc6-via">${via}</span>` : ''}
        <span class="spacer"></span>${mode === 'update' ? `<button class="btn btn-ghost btn-xs doc6-only" type="button" aria-pressed="false" aria-label="Changes only" title="Changes only">${ico('filter', 'i i-sm')}<span class="lbl">Changes only</span></button>` : ''}${views}
      </header>
      <div class="doc6-bar"><span class="doc6-id"><span class="k" dir="ltr">_id</span>${typeof c.id === 'string' ? `<span class="j6-s" dir="ltr">"${esc(c.id)}"</span>` : val(c.id)}</span><span class="doc6-sum">${sum}</span></div>
      <div class="dt6" role="tree" aria-label="${esc(c.collection)} document">${rows.map(r => treeRow(r, mode)).join('')}</div>
    </article>`;
  }

  /** A SQL row change, in the existing card style (results.js), keyed by its primary key. */
  function rowCard(c) {
    const badge = { insert: ['ins', '+ INSERT'], update: ['upd', '~ UPDATE'], delete: ['del', '− DELETE'] }[c.op];
    const cols = c.op === 'update' ? Object.keys(c.after).filter(k => !same(c.before[k], c.after[k])) : Object.keys(c.after);
    const shown = cols.slice(0, c.limit || 5);
    const cell = v => v === null ? '<span class="j6-null">null</span>' : esc(v);
    return `<article class="table-change" aria-label="${esc(c.table)}: 1 row ${c.op}d">
      <div class="tc-head"><span class="op-badge op-${badge[0]}">${badge[1]}</span><span class="name">${esc(c.table)}</span><span class="spacer"></span><span class="faint tc-key"><span class="k">${esc(c.keyName)}</span> <span dir="ltr">${esc(c.key)}</span></span></div>
      <div class="kv">${shown.map(k => `<div class="k">${esc(k)}</div><div class="v${c.op === 'insert' ? ' new' : ''}" dir="ltr">${c.op === 'update' ? `<span class="old">${cell(c.before[k])}</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">changed to</span>${cell(c.after[k])}` : cell(c.after[k])}</div>`).join('')}</div>
      ${cols.length > shown.length ? `<button class="more-cols">${ico('chevron-down', 'i i-sm')}${cols.length - shown.length === 1 ? '1 more column' : `${cols.length - shown.length} more columns`}</button>` : ''}
    </article>`;
  }

  /* ---------- Ship order: one Preview across SQLite and MongoDB ---------- */
  const ORD = '7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13';
  const oid = x => ({ $oid: x }), dt = x => ({ $date: x }), dec = x => ({ $numberDecimal: x });
  const orderBefore = {
    _id: oid('6740a1c2e5b8f1a9c4d3e201'), orderId: ORD, number: 'ORD-2026-000187', reference: 'PO-2026-1184 / Q4 desk setup', status: 'Packed',
    amount: { value: dec('142.20'), currency: 'EUR' },
    customer: {
      name: 'Priya Raman', email: 'priya.raman@example.com',
      address: { street: '14 Marlay Park Road', city: 'Dublin', postcode: 'D16 X2P4', country: 'IE' },
      fraudCheck: { status: 'Pending', provider: 'riskwatch' },
      webhookSecret: '[REDACTED]',
    },
    lines: [{ sku: 'APP-MCS-HGR-M', quantity: 2, shipped: 0, unitPrice: dec('71.10') }, { sku: 'ELE-SDL-WHI', quantity: 1, shipped: 0, unitPrice: dec('59.90') }],
    packages: [{ type: 'Box M', weightGrams: 1380, label: 'pending' }],
    events: [],
    holdReason: 'Waiting for a carrier label',
    audit: { createdAt: dt('2026-11-20T09:14:52Z'), createdBy: 'sam.support@acme.dev', updatedAt: dt('2026-11-20T09:15:03Z'), version: 3 },
  };
  const orderAfter = {
    _id: orderBefore._id, orderId: ORD, number: orderBefore.number, reference: orderBefore.reference, status: 'Shipped', amount: orderBefore.amount,
    customer: { ...orderBefore.customer, fraudCheck: { status: 'Cleared', provider: 'riskwatch', checkedAt: dt('2026-11-21T14:02:10Z') } },
    lines: [{ ...orderBefore.lines[0], shipped: 2 }, { ...orderBefore.lines[1], shipped: 1 }],
    packages: [{ type: 'Box M', weightGrams: 1420, label: 'printed' }, { type: 'Satchel', weightGrams: 210, label: 'printed' }],
    events: [{ by: 'ada.admin@acme.dev', role: 'admin', type: 'Shipped', comment: 'All lines packed and labelled.', at: dt('2026-11-21T14:02:11Z'), webhookToken: '[REDACTED]' }],
    dispatch: { scheduledFor: dt('2026-11-23T00:00:00Z'), carrier: 'DHL Express', service: 'Standard', cutoff: '17:00 IST' },
    audit: { ...orderBefore.audit, updatedAt: dt('2026-11-21T14:02:11Z'), updatedBy: 'ada.admin@acme.dev', version: 4 },
  };
  const docs = [
    { op: 'update', collection: 'orders', ns: 'store', id: orderBefore._id, before: orderBefore, after: orderAfter },
    { op: 'insert', collection: 'order_events', ns: 'store', id: oid('6740a1d03b9e7c21f4a8e5b7'),
      after: { _id: oid('6740a1d03b9e7c21f4a8e5b7'), type: 'order.shipped', orderId: ORD, actor: { email: 'ada.admin@acme.dev', role: 'admin', sessionToken: '[REDACTED]' }, at: dt('2026-11-21T14:02:11Z'), changes: ['status', 'packages', 'dispatch'] } },
    { op: 'insert', via: 'upsert', collection: 'customer_profiles', ns: 'store', id: 'cus_3f9c0000a21e',
      after: { _id: 'cus_3f9c0000a21e', name: 'Priya Raman', lastOrderAt: dt('2026-11-21T14:02:11Z'), totals: { EUR: dec('142.20') }, orders: 1 } },
    { op: 'update', via: 'replace', collection: 'review_invites', ns: 'store', id: 'ord_7d2e41a0',
      before: { _id: 'ord_7d2e41a0', rule: { id: 'rv_after_delivery', delayDays: 7, channel: 'email' }, recipients: ['priya.raman@example.com'], scheduled: false, note: 'Waiting for the order to ship' },
      after: { _id: 'ord_7d2e41a0', rule: { id: 'rv_after_delivery', delayDays: 7, channel: 'email' }, recipients: ['priya.raman@example.com'], scheduled: true, sendAfter: dt('2026-11-30T09:00:00Z') } },
    { op: 'delete', collection: 'stock_holds', ns: 'store', id: oid('6740a0f71c2d9e8b5a3f6c10'),
      before: { _id: oid('6740a0f71c2d9e8b5a3f6c10'), orderId: ORD, reason: 'ReservedForPaidOrder', placedBy: 'stock-engine', placedAt: dt('2026-11-20T09:15:03Z') } },
  ];
  const rows = [
    { op: 'update', table: 'Orders', keyName: 'Id', key: '7d2e41a0…9f13', before: { Status: 'Packed', ShippedAt: null, ShippedBy: null, Amount: '142.20' }, after: { Status: 'Shipped', ShippedAt: '2026-11-21 14:02:11', ShippedBy: 'ada.admin@acme.dev', Amount: '142.20' } },
    { op: 'insert', table: 'Shipments', keyName: 'Id', key: '9b1f6c3e…07d4', after: { Id: '9b1f6c3e-2a7d-4b10-9e55-0c8a1d3f07d4', OrderId: ORD, Carrier: 'DHL Express', TrackingNumber: 'JD014600006281', ShippedAt: '2026-11-21 14:02:11', Notified: 'true' }, limit: 4 },
  ];

  /** One store's group: its mark, name, database and what happened to it. */
  function group(id, dbName, status, count, body) {
    return `<section class="sg6" aria-labelledby="sg6-${id}">
      <header class="sg6-head">${logo(id, 'lg-20')}<h3 id="sg6-${id}">${stores[id].name}</h3><code dir="ltr">${esc(dbName)}</code><span class="sg6-state">${ico('undo', 'i i-sm')}${status}</span><span class="spacer"></span><span class="sg6-count">${count}</span></header>
      <div class="sg6-list">${body}</div>
    </section>`;
  }

  /** The Database tab after the Preview: one banner, a jump strip, then a group per store. */
  function database() {
    const strip = `<nav class="ss6" aria-label="Stores in this result">
      <a href="#sg6-sqlite" class="ss6-item">${logo('sqlite', 'lg-14')}<span>SQLite</span><span class="n">2 rows</span></a>
      <a href="#sg6-mongodb" class="ss6-item">${logo('mongodb', 'lg-14')}<span>MongoDB</span><span class="n">5 documents</span></a>
      <span class="spacer"></span><span class="ss6-note">${ico('eye', 'i i-sm')}<span>Read, not written: <span class="ss6-st">${logo('redis', 'lg-14')}Redis</span> <span class="ss6-st">${logo('dynamodb', 'lg-14')}DynamoDB</span></span></span>
    </nav>`;
    return `<div class="banner">${ico('undo')}<div><strong>Rolled back. Nothing was saved.</strong> These are the rows and documents this request would write, as Ada Admin.</div></div>
      ${strip}
      ${group('sqlite', 'store-demo.db', 'Rolled back', '2 rows', rows.map(rowCard).join(''))}
      ${group('mongodb', 'store', 'Transaction aborted', '5 documents', docs.map(c => docCard(c)).join(''))}
      <p class="cov6">${ico('shield', 'i i-sm')}<span>Covered in Development: SQLite and MongoDB roll back; Redis <code>cache</code> and DynamoDB <code>idempotency</code> block writes. Stores and clients Sendproof didn’t hook aren’t covered.</span></p>
      <div class="effect">${ico('mail')}<div class="grow"><div class="t">1 email held back</div><div class="s ltr" dir="ltr">OrderShippedNotification → priya.raman@example.com</div></div><button class="btn btn-ghost btn-sm">View</button></div>`;
  }

  /* ---------- Command logs ---------- */
  /** JSON with literal placeholders ("?") as quiet chips; short objects stay on one line. */
  function jsonCmd(v, depth = 0) {
    const pad = '  '.repeat(depth + 1), end = '  '.repeat(depth);
    const flat = JSON.stringify(v);
    const key = k => `<span class="j6-k${k.startsWith('$') ? ' is-op' : ''}">"${esc(k)}"</span>`;
    const lit = x => x === '?' ? '<span class="ph6" title="Value hidden">?</span>' : typeof x === 'string' ? `<span class="j6-s">"${esc(x)}"</span>` : `<span class="j6-n">${esc(JSON.stringify(x))}</span>`;
    if (!v || typeof v !== 'object') return lit(v);
    const entries = Array.isArray(v) ? v.map(x => [null, x]) : Object.entries(v);
    const inner = entries.map(([k, x]) => `${k === null ? '' : key(k) + '<span class="j6-p">: </span>'}${jsonCmd(x, depth + 1)}`);
    const [o, c] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
    if (flat.length < 64) return `<span class="j6-p">${o}</span>${inner.join('<span class="j6-p">, </span>')}<span class="j6-p">${c}</span>`;
    return `<span class="j6-p">${o}</span>\n${inner.map(x => pad + x).join('<span class="j6-p">,</span>\n')}\n${end}<span class="j6-p">${c}</span>`;
  }
  const mongoUpdate = {
    update: 'orders', $db: 'store',
    updates: [{ q: { _id: '?', status: '?' }, u: { $set: { status: '?', 'packages.0.weightGrams': '?', 'customer.fraudCheck': '?', dispatch: '?', 'audit.updatedAt': '?', 'audit.updatedBy': '?' }, $push: { events: '?', packages: '?' }, $unset: { holdReason: '?' }, $inc: { 'audit.version': '?' } }, upsert: '?' }],
    ordered: '?', txnNumber: '?', autocommit: '?',
  };
  const redisCmd = cmd => cmd.split(' ').map((w, i) => i === 0 ? `<span class="rc6-c">${esc(w)}</span>` : w === '?' ? '<span class="ph6" title="Value hidden">?</span>' : `<span class="rc6-k">${esc(w)}</span>`).join(' ');
  const partiql = text => esc(text).replace(/\b(SELECT|FROM|WHERE|AND)\b/g, '<span class="tok-k">$1</span>').replace(/\?/g, '<span class="ph6" title="Value hidden">?</span>').replace(/&quot;([\w-]+)&quot;/g, '<span class="rc6-k">"$1"</span>');
  const sqlHl = text => esc(text).replace(/\b(SELECT|FROM|WHERE|AS|UPDATE|SET|INSERT INTO|VALUES)\b/g, '<span class="tok-k">$1</span>');

  // [ms, level, took, store, source label, message html, detail key]
  const logRows = [
    ['0.0', 'INF', '', null, 'Hosting', 'Request starting <code>POST /api/v2/orders/7d2e41a0…/shipments</code> 64 bytes'],
    ['1.1', 'INF', '', null, 'Auth', 'Signed in as <span class="prop">ada.admin@acme.dev</span> with roles <span class="prop">admin</span>'],
    ['2.4', 'DB', '0.6', 'dynamodb', 'DynamoDB', '<span class="dbm6"><b>GetItem</b> idempotency-keys</span>'],
    ['3.0', 'DB', '0.9', 'dynamodb', 'DynamoDB', `<span class="dbm6"><b>ExecuteStatement</b> idempotency-keys</span><span class="dbs6">SELECT status, responseHash FROM "idempotency-keys" WHERE pk = ? AND sk = ?</span>`, 'dynamo'],
    ['3.9', 'DB', '0.4', 'redis', 'Redis', `<code class="rc6">${redisCmd('HMGET limits:shipments:ada.admin ? ?')}</code>`, 'redis'],
    ['5.2', 'SQL', '2.8', 'sqlite', 'EF Core', '<code>SELECT o.Id, o.Status, o.Amount FROM Orders AS o WHERE o.Id = @p0</code>'],
    ['9.8', 'DB', '1.2', 'mongodb', 'MongoDB', '<span class="dbm6"><b>find</b> orders</span><span class="dbs6">{"find":"orders","filter":{"orderId":"?"},"limit":"?"}</span>'],
    ['14.6', 'INF', '', null, 'ShippingPolicy', 'Every line is paid and packed: <span class="prop">DHL Express</span> collects on <span class="prop">23 Nov 2026</span>'],
    ['18.3', 'SQL', '3.4', 'sqlite', 'EF Core', '<code>UPDATE Orders SET Status = @p0, ShippedAt = @p1, ShippedBy = @p2 WHERE Id = @p3</code>'],
    ['22.0', 'SQL', '2.1', 'sqlite', 'EF Core', '<code>INSERT INTO Shipments (Id, OrderId, Carrier, TrackingNumber, ShippedAt, Notified) VALUES (@p0, …)</code>'],
    ['25.7', 'DB', '1.8', 'mongodb', 'MongoDB', '<span class="dbm6"><b>update</b> orders</span><span class="dbs6">{"update":"orders","updates":[{"q":{"_id":"?","status":"?"},"u":{"$set":…}}]}</span>', 'mongo'],
    ['29.9', 'DB', '0.9', 'mongodb', 'MongoDB', '<span class="dbm6"><b>insert</b> order_events</span><span class="dbs6">{"insert":"order_events","documents":["?"]}</span>'],
    ['31.4', 'DB', '1.1', 'mongodb', 'MongoDB', '<span class="dbm6"><b>update</b> customer_profiles</span><span class="dbs6">{"update":"customer_profiles","updates":[{"q":{"_id":"?"},"u":{"$set":"?","$inc":"?"},"upsert":"?"}]}</span>'],
    ['33.0', 'DB', '0.7', 'mongodb', 'MongoDB', '<span class="dbm6"><b>update</b> review_invites</span><span class="dbs6">{"update":"review_invites","updates":[{"q":{"_id":"?"},"u":"?"}]}</span>'],
    ['34.2', 'DB', '0.6', 'mongodb', 'MongoDB', '<span class="dbm6"><b>delete</b> stock_holds</span><span class="dbs6">{"delete":"stock_holds","deletes":[{"q":{"orderId":"?"},"limit":"?"}]}</span>'],
    ['38.1', 'INF', '', null, 'ShipmentService', 'Shipped order <span class="prop">7d2e41a0…9f13</span>; carrier collects on <span class="prop">23 Nov 2026</span>'],
  ];
  const detail = {
    mongo: () => `
      <dl class="log-props"><div><dt>Store</dt><dd>MongoDB · <code>store</code></dd></div><div><dt>Collection</dt><dd><code>orders</code></dd></div><div><dt>Took</dt><dd>1.8 ms</dd></div><div><dt>Documents</dt><dd>1 matched · 1 modified</dd></div><div><dt>Session</dt><dd>Preview transaction</dd></div></dl>
      <div class="sql-wrap cmd6"><div class="sql-bar">${logo('mongodb', 'lg-14')}<span>Command · values hidden</span><span class="spacer"></span>${copyBtn('Copy command', { state: q.copied === 'cmd' ? 'copied' : 'idle', size: 'btn-xs' })}</div>
        <pre class="sql cmd6-json" dir="ltr">${jsonCmd(mongoUpdate)}</pre></div>
      <div class="prm6"><div class="prm6-h">Parameters <span class="faint">15</span><span class="spacer"></span><span class="faint">Secret names are never captured</span></div>
        <dl class="params" dir="ltr">
          <dt>updates[0].q._id</dt><dd>ObjectId("6740a1c2e5b8f1a9c4d3e201")</dd>
          <dt>updates[0].u.$set.status</dt><dd>Shipped</dd>
          <dt>updates[0].u.$push.events.webhookToken</dt><dd><span class="rd6">${ico('lock', 'i i-sm')}redacted</span></dd>
          <dt>updates[0].u.$push.events.by</dt><dd>ada.admin@acme.dev</dd>
          <dt>updates[0].u.$set.packages.0.weightGrams</dt><dd>Int32(1420)</dd>
          <dt>updates[0].q.status</dt><dd>Packed</dd>
        </dl><button class="link-btn6" type="button">Show 9 more parameters</button></div>
      <div class="fx-acts">${copyTextBtn('Copy as mongosh', { cls: 'btn-sm' })}${copyTextBtn('Copy entry as JSON', { cls: 'btn-sm' })}</div>`,
    redis: () => `
      <dl class="log-props"><div><dt>Store</dt><dd>Redis · <code>cache</code> · db 0</dd></div><div><dt>Key</dt><dd><code>limits:shipments:ada.admin</code></dd></div><div><dt>Took</dt><dd>0.4 ms</dd></div><div><dt>Kind</dt><dd>Read · allowed during Preview</dd></div></dl>
      <div class="sql-wrap cmd6"><div class="sql-bar">${logo('redis', 'lg-14')}<span>Command · key kept, arguments hidden</span><span class="spacer"></span>${copyBtn('Copy command', { size: 'btn-xs' })}</div>
        <pre class="sql" dir="ltr">${redisCmd('HMGET limits:shipments:ada.admin ? ?')}</pre></div>
      <p class="prm6-note">${ico('lock', 'i i-sm')}Redis arguments have no names to check, so every argument after the key is hidden.</p>`,
    dynamo: () => `
      <dl class="log-props"><div><dt>Store</dt><dd>DynamoDB · <code>idempotency</code></dd></div><div><dt>Table</dt><dd><code>idempotency-keys</code></dd></div><div><dt>Took</dt><dd>0.9 ms</dd></div><div><dt>Items</dt><dd>0 returned</dd></div></dl>
      <div class="sql-wrap cmd6"><div class="sql-bar">${logo('dynamodb', 'lg-14')}<span>PartiQL · ExecuteStatement</span><span class="spacer"></span>${copyBtn('Copy statement', { state: q.copied === 'cmd' ? 'copied' : 'idle', size: 'btn-xs' })}</div>
        <pre class="sql" dir="ltr">${partiql('SELECT status, responseHash\nFROM "idempotency-keys"\nWHERE pk = ? AND sk = ?')}</pre></div>
      <div class="prm6"><div class="prm6-h">Parameters <span class="faint">2</span></div>
        <dl class="params" dir="ltr"><dt>1</dt><dd>ship#7d2e41a0-5c1b-4e8f-a3d2-6b0e19c49f13</dd><dt>2</dt><dd>ada.admin@acme.dev</dd></dl></div>
      <div class="fx-acts">${copyTextBtn('Copy with values', { cls: 'btn-sm' })}${copyTextBtn('Copy entry as JSON', { cls: 'btn-sm' })}</div>`,
  };
  function logs() {
    const open = q.open || 'mongo';
    const count = id => logRows.filter(r => r[3] === id).length;
    const chips = ['sqlite', 'mongodb', 'redis', 'dynamodb'].map(id => `<button class="qc6" type="button" aria-pressed="true">${logo(id, 'lg-14')}<span>${id === 'sqlite' ? 'SQL' : stores[id].name}</span><span class="n">${count(id)}</span></button>`).join('');
    const bar = `<div class="log-bar">
        <div class="segmented" role="group" aria-label="Level"><button aria-pressed="true">All <span class="faint">${logRows.length}</span></button><button aria-pressed="false">Warning <span class="faint">0</span></button><button aria-pressed="false">Error <span class="faint">0</span></button></div>
        <label class="input-sm grow">${ico('filter', 'i i-sm')}<span class="sr-only">Filter logs</span><input placeholder="Filter messages, commands or keys"></label>
        ${copyBtn('Copy logs as JSON')}
      </div>
      <div class="qf6" role="group" aria-label="Queries by store"><span class="qf6-l">Queries</span>${chips}</div>`;
    return `<div class="lb6">${bar}</div><div class="logs ltr" role="table" aria-label="Log entries">
      <div class="log-row head" role="row"><span role="columnheader"></span><span role="columnheader">ms</span><span role="columnheader">Level</span><span role="columnheader">Took</span><span role="columnheader">Source</span><span role="columnheader">Message</span></div>
      ${logRows.map(([tm, lvl, took, store, src, msg, key]) => {
        const isOpen = key && key === open;
        return `<div class="log-row lvl-${lvl.toLowerCase()}${isOpen ? ' is-open' : ''}${store && lvl === 'DB' ? ' is-db6' : ''}" role="row" aria-expanded="${!!isOpen}">
          <span role="cell" class="chev">${ico(isOpen ? 'chevron-down' : 'chevron-right', 'i i-sm')}</span><span role="cell" class="tm">${tm}</span>
          <span role="cell"><span class="lvl">${lvl}</span></span><span role="cell" class="tm">${took}</span>
          <span role="cell" class="src">${store ? `<span class="src6">${logo(store, 'lg-14')}<span>${src}</span></span>` : src}</span><span role="cell" class="msg">${msg}</span>
        </div>${isOpen ? `<div class="log-detail" role="row"><div role="cell">${detail[key]()}</div></div>` : ''}`;
      }).join('')}
    </div>
    <div class="log-meta"><span>Only this request’s scope · trace <code>4bf92f35…4736</code></span><span class="spacer"></span><span>${kbd('↑↓')} move ${kbd('↵')} expand</span></div>`;
  }

  /* ---------- Board builder access ---------- */
  window.SP = Object.assign(window.SP, { docCard, rowCard, docs, rows, val, s });
  // v7 (journeys) builds its own scenes on these builders and marks.
  if (q.v7) return;

  /* =====================================================================
     Workbench scenes
     ===================================================================== */
  if (!document.querySelector('.workspace')) return;
  document.querySelectorAll('.brand .desktop-only').forEach(el => { el.textContent = s('brand'); });
  document.title = 'Sendproof · v6 mock';
  const V = TB.v5;
  const scene = q.nosql || 'changes';
  const opid = { changes: 'ShipmentsController.Create', logs: 'ShipmentsController.Create', known: 'CartsController.Quote', blocked: 'CouponsController.Redeem' }[scene];
  const S = TB.schema;
  const op = S.operations.find(o => o.id === opid);
  const swap = (sel, html) => document.querySelector(sel)?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: html.trim() }).content.firstElementChild);

  // The sidebar: bring the operation into view, and mark the operation that can't Preview.
  const quote = [...document.querySelectorAll('.nav-item')].find(a => a.title === 'Price cart');
  quote?.insertAdjacentHTML('beforeend', `<span class="nav6-np" title="${esc(s('pv.tip'))}">${ico('flask-off', 'i i-sm')}<span class="sr-only">${esc(s('pv.side'))}</span></span>`);
  requestAnimationFrame(() => {
    const here = document.querySelector('.nav-item[aria-current]');
    const nav = here?.closest('.nav');
    if (here && nav) nav.scrollTop = here.offsetTop - nav.clientHeight / 2 + 40;
  });

  /* ---------- Request pane: this operation's own form ---------- */
  const fields = {
    changes: () => [
      { name: 'orderId', kind: 'lookup', label: 'orderId', type: 'uuid', desc: 'The order’s ID, from <a href="#" class="op-link">GET List orders</a>.', picked: ['O', 'ORD-2026-000187', '€142.20 · Priya Raman'], status: 'Sends <code>7d2e41a0…9f13</code>' },
    ],
    known: () => [
      { name: 'shipTo', kind: 'select', label: 'shipTo', type: 'string', desc: 'The ISO 3166-1 alpha-2 country the order ships to.', value: 'IE', options: [{ v: 'IE' }], half: true },
      { name: 'shippingMethod', kind: 'radio', label: 'shippingMethod', type: 'ShippingMethod', desc: 'How the order would be delivered.', value: 'Express', options: [{ v: 'Standard' }, { v: 'Express' }, { v: 'Same day' }], half: true },
      { name: 'couponCode', kind: 'text', label: 'couponCode', type: 'string', optional: true, desc: 'A coupon to apply, such as SPRING25.', value: 'SPRING25', mono: true },
      { name: 'currency', kind: 'select', label: 'currency', type: 'Currency', optional: true, desc: 'Quote in this currency instead of the cart’s.', value: 'EUR', options: [{ v: 'EUR' }], half: true },
      { name: 'validForMinutes', kind: 'number', label: 'validForMinutes', type: 'int32', optional: true, desc: 'How long the quote stays valid, 5 to 60 minutes.', value: '15', mono: true, half: true, status: `<bdi>${num(5)} – ${num(60)}</bdi>` },
    ],
    blocked: () => [
      { name: 'code', kind: 'text', label: 'code', type: 'string', desc: 'The coupon code.', value: 'SPRING25', mono: true, half: true },
      { name: 'orderId', kind: 'lookup', label: 'orderId', type: 'uuid', desc: 'The order to apply the coupon to. It must still be pending.', picked: ['O', 'ORD-2026-000187', '€142.20 · Priya Raman'], status: 'Sends <code>7d2e41a0…9f13</code>' },
    ],
  };
  fields.logs = fields.changes;
  const form = `<form class="form" novalidate onsubmit="return false"><fieldset><legend class="section-label">${scene === 'changes' || scene === 'logs' ? 'Path' : 'Body'} <span class="rule" aria-hidden="true"></span></legend>
    <div class="fields f5s">${fields[scene]().map(f => V.field({ state: 'rest', ...f })).join('')}</div></fieldset>
    ${scene === 'changes' || scene === 'logs' ? `<fieldset><legend class="section-label">Body <span class="rule" aria-hidden="true"></span></legend><div class="fields f5s">${V.field({ name: 'carrier', kind: 'select', label: 'carrier', type: 'string', desc: 'The carrier that collects the parcel.', value: 'DHL Express', options: [{ v: 'DHL Express' }, { v: 'DPD' }, { v: 'UPS' }, { v: 'An Post' }, { v: 'Royal Mail' }] })}</div></fieldset>` : ''}</form>`;
  const req = document.querySelector('main.request');
  req?.querySelector('.form')?.replaceWith(Object.assign(document.createElement('template'), { innerHTML: form }).content.firstElementChild);
  req?.querySelectorAll('.tabs [role="tab"]').forEach(t => {
    const label = t.textContent.trim();
    if (scene === 'changes' || scene === 'logs') t.setAttribute('aria-selected', String(/^Params/.test(label)));
  });
  // The body heading names this operation's schema, not CreateOrderRequest.
  req?.querySelectorAll('.form-head, .body-head').forEach(el => el.remove());

  /* ---------- Action bar ---------- */
  const bar = req?.querySelector('.actionbar');
  const reqLine = `<code dir="ltr">${op.method.toUpperCase()} ${esc(op.path)}</code>`;
  if (scene === 'known' && bar) {
    // Preview stays in its place, disabled; the reason is docked right above it, not in a tooltip.
    const dock = `<div class="pv6-dock" role="note" aria-labelledby="pv6-h">
      <span class="pv6-tile">${logo('redis', 'lg-20')}</span>
      <div class="pv6-text"><p class="pv6-title"><strong id="pv6-h">${s('pv.title')}</strong><span class="pv6-reason" lang="en">Price quotes are cached in Redis for 15 minutes.</span></p>
        <p class="pv6-sub"><span class="pv6-why">${s('pv.why')} </span><span class="pv6-by">${s('pv.by')} · <code dir="ltr">preview: false</code></span> <button class="pv6-more" type="button" aria-expanded="false">${s('pv.learn')}</button></p></div>
      <span class="pv6-caret" aria-hidden="true"></span>
    </div>`;
    const confirming = !!q.confirm;
    const status = confirming
      ? `<span class="status cf6" role="status">${ico('warn', 'i i-sm')}<span>${s('cf.status', { req: reqLine })}</span></span>`
      : `<span class="status">${ico('send', 'i i-sm')}<span>${s('pv.status')}</span></span>`;
    const buttons = confirming
      ? `<span class="run-pair6"><button class="btn btn-run btn-ghost" type="button">${s('cf.cancel')}${kbd('Esc')}</button><button class="btn btn-run btn-primary" type="button" aria-keyshortcuts="${aks('shift', 'mod', 'enter')}">${ico('send', 'i i-sm')}${s('cf.confirm')}${kbd('shift', 'mod', 'enter')}</button></span>`
      : `<button class="btn btn-run btn-send btn-primary" id="send-btn" type="button" aria-keyshortcuts="${aks('shift', 'mod', 'enter')}">${ico('send', 'i i-sm')}${TB.t('send')}${kbd('shift', 'mod', 'enter')}</button>
         <button class="btn btn-run btn-preview pv6-off" type="button" aria-disabled="true" aria-describedby="pv6-h" title="${esc(s('pv.tip'))}">${ico('flask-off', 'i i-sm')}${TB.t('preview')}</button>`;
    bar.insertAdjacentHTML('beforebegin', dock);
    bar.innerHTML = status + buttons;
  } else if (scene === 'blocked' && bar) {
    bar.querySelector('.status').outerHTML = `<span class="status is-warn6">${ico('ban', 'i i-sm')}<span>${s('blk.lastBar')}</span></span>`;
  }

  /* ---------- Result pane ---------- */
  const pane = document.querySelector('section.pane.response');
  if (scene === 'known') {
    // Before a run: the same empty state, with Preview's step marked unavailable.
    const st = pane?.querySelector('.state');
    st?.querySelector(':scope > p') && (st.querySelector(':scope > p').textContent = s('pv.emptyBody'));
    pane?.querySelectorAll('.steps li').forEach(li => {
      if (/Preview/.test(li.textContent)) li.outerHTML = `<li class="step6-off">${ico('flask-off', 'i i-sm')}<span>${s('pv.step')}</span><span class="spacer"></span><span class="step6-tag">${logo('redis', 'lg-14')}Redis</span></li>`;
    });
    pane?.querySelectorAll('.state h3, .state h1').forEach(h => { if (lang !== 'en') h.textContent = { de: 'Die Antwort erscheint hier', ar: 'ستظهر الاستجابة هنا' }[lang] || h.textContent; });
    return;
  }

  const metrics = (ms, kb) => `<span class="metric"><bdi>${unit(ms, 'millisecond')}</bdi> · <bdi>${unit(kb, 'kilobyte', 1)}</bdi></span>`;
  const tabsRow = (sel, counts) => `<div class="tabs scrolls" role="tablist" aria-label="Result">${['res.response', 'res.database', 'res.effects', 'res.logs', 'res.headers'].map((k, i) => tab(TB.t(k), { selected: i === sel, count: counts[i] })).join('')}</div>`;
  const resultBar = text => `<div class="pane-bar result-bar"><span class="bar-text">${ico('undo', 'i i-sm')}<span>${text}</span></span><button class="btn btn-ghost btn-sm" aria-keyshortcuts="Meta+Y">${ico('history', 'i i-sm')}${TB.t('history')}${kbd('mod', 'Y')}</button></div>`;

  if (scene === 'changes' || scene === 'logs') {
    const head = `<div class="resp-head" role="status"><span class="pill pill-accent">${ico('flask', 'i i-sm')}${TB.t('res.preview')}</span><span class="status-code ok">${ico('check', 'i i-sm')}200 OK</span>${metrics(41, 1.6)}<span class="spacer"></span>${copyBtn(TB.t('copy.curl'), { keys: aks('shift', 'mod', 'C') })}<button class="btn btn-sm">${ico('send', 'i i-sm')}${TB.t('send.real')}</button></div>`;
    swap('section.pane.response', `<section class="pane response" aria-label="Result">${head}${tabsRow(scene === 'logs' ? 3 : 1, [undefined, 7, 1, logRows.length, 9])}
      <div class="pane-scroll" role="tabpanel"><div class="result-body">${scene === 'logs' ? logs() : database()}</div></div>${resultBar('Previewed at 14:02:11 as Ada Admin')}</section>`);
    if (q.dscroll) requestAnimationFrame(() => {
      const el = document.getElementById('doc-' + q.dscroll), sc = el?.closest('.pane-scroll');
      if (el && sc) sc.scrollTop = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 56;
    });
    if (scene === 'logs') requestAnimationFrame(() => {
      const el = document.querySelector('.log-row.is-open'), sc = el?.closest('.pane-scroll');
      // The filter bar is sticky, so the open entry scrolls up under it with two rows of context.
      const lb = document.querySelector('.lb6');
      const stick = lb && getComputedStyle(lb).position === 'sticky' ? lb.getBoundingClientRect().height : 0;
      if (el && sc && (q.open || 'mongo') === 'mongo') sc.scrollTop = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - stick - el.offsetHeight - 8;
    });
    return;
  }

  /* ---------- Blocked: a designed result state, not an error ---------- */
  const problem = { type: 'about:blank', title: 'Preview unavailable', status: 409, code: 'preview_unavailable', detail: 'Preview unavailable: this operation writes to Redis', store: 'redis', operation: 'INCRBY', rolledBack: false };
  const problemHtml = '<span class="j6-p">{</span>\n' + Object.entries(problem).map(([k, v]) => `  <span class="j6-k">"${k}"</span><span class="j6-p">: </span>${typeof v === 'string' ? `<span class="j6-s">"${esc(v)}"</span>` : `<span class="j6-n">${v}</span>`}`).join('<span class="j6-p">,</span>\n') + '\n<span class="j6-p">}</span>';
  const code = `<code dir="ltr">INCRBY</code>`;
  const snippet = '[SendproofPreview(Enabled = false, Reason = "Counts coupon redemptions in Redis")]';
  const head = `<div class="resp-head" role="status"><span class="pill pill-accent">${ico('flask', 'i i-sm')}${TB.t('res.preview')}</span><span class="status-code warn">${ico('ban', 'i i-sm')}<bdi>409</bdi> ${s('blk.code')}</span><span class="metric"><bdi>${unit(23, 'millisecond')}</bdi></span><span class="spacer"></span>${copyBtn(s('blk.copyCurl'), { keys: aks('shift', 'mod', 'C') })}<button class="btn btn-sm">${ico('send', 'i i-sm')}${s('blk.sendReal')}</button></div>`;
  const body = `<section class="blk6" aria-labelledby="blk6-h">
      <div class="blk6-top">
        <span class="blk6-tile">${logo('redis', 'lg-28')}<span class="blk6-badge">${ico('ban', 'i i-sm')}</span></span>
        <div class="blk6-lede"><p class="blk6-eyebrow">${s('blk.eyebrow')}</p><h3 id="blk6-h">${s('blk.title', { store: 'Redis' })}</h3><p>${s('blk.body', { store: 'Redis', op: code })}</p></div>
      </div>
      <div class="blk6-safe">
        <p class="blk6-safe-h">${ico('shield-check', 'i i-sm')}<strong>${s('blk.safe')}</strong></p>
        <ul>
          <li>${logo('redis', 'lg-16')}<span class="nm">Redis <code dir="ltr">cache</code></span><span class="st is-block">${ico('ban', 'i i-sm')}${s('blk.refused', { op: code })}</span></li>
          <li>${logo('sqlite', 'lg-16')}<span class="nm">SQLite <code dir="ltr">store-demo.db</code></span><span class="st">${ico('undo', 'i i-sm')}${s('blk.rolled')}</span></li>
          <li><span class="lg-ico">${ico('mail', 'i i-sm')}</span><span class="nm">${s('blk.effects')}</span><span class="st">${ico('undo', 'i i-sm')}${s('blk.held')}</span></li>
        </ul>
        <p class="blk6-note">${s('blk.safeNote')}</p>
      </div>
      <div class="blk6-next">
        <h4>${s('blk.next')}</h4>
        <div class="blk6-step"><span class="n">1</span><div class="grow"><button class="btn btn-primary btn-sm" type="button">${ico('send', 'i i-sm')}${s('blk.send')}${kbd('shift', 'mod', 'enter')}</button><p>${s('blk.sendNote')}</p></div></div>
        <div class="blk6-step"><span class="n">2</span><div class="grow"><p class="blk6-author"><strong>${s('blk.author')}</strong> ${s('blk.authorBody', { code: '<code dir="ltr">preview: false</code>' })}</p>
          <div class="blk6-code" dir="ltr"><pre lang="en">${esc(snippet)}</pre>${copyBtn(s('blk.copy'), { size: 'btn-xs' })}</div></div></div>
      </div>
      <div class="blk6-raw"><div class="sql-bar"><span>${s('blk.raw')}</span><code dir="ltr">application/problem+json</code><span class="spacer"></span>${copyBtn(s('blk.copy'), { size: 'btn-xs' })}</div><pre class="sql" dir="ltr">${problemHtml}</pre></div>
    </section>`;
  swap('section.pane.response', `<section class="pane response" aria-label="Result">${head}${tabsRow(0, [undefined, '–', '–', '–', 4])}
    <div class="pane-scroll" role="tabpanel"><div class="result-body">${body}</div></div>${resultBar(s('blk.ranAt'))}</section>`);
})();

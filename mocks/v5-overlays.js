// v5 (?v5=1): the new popovers, chosen with ?pop=. Each is anchored to its control and sized
// to it, closes with Esc, and keeps focus in the control (the listbox uses
// aria-activedescendant, as the APG select-only combobox does).
//   pop=<field>     a select's listbox: status | segment | currency | sort (List customers)
//                   with search=<query>, typed=<buffer> (type-ahead), active=<value>
//   pop=id | customerId   the ID lookup, with lstate=loading|empty|error
//                   (signed out comes from auth=out)
//   pop=lang        the language picker in Display settings (with overlay=display);
//                   lsearch=<query>, lactive=<language id> shows its RTL preview
//   pop=dep-tip     the sidebar tooltip of a deprecated operation
//   pop=match       the schema-match toggletip in the result's status line
(function () {
  const { q, ico, kbd, t } = window.TB;
  if (!q.v5) return;
  const S = window.TB.schema;
  const V = window.TB.v5;
  const esc = S.esc;
  const { num } = window.i18n;

  /**
   * Places a popover against its anchor, in viewport coordinates: the anchor's start edge
   * (the right edge in RTL), at least the anchor's width, below it, or above when there's no
   * room below. On a narrow screen a listbox becomes a bottom sheet instead (sheet: { title,
   * sub }): a grab handle, a title, a close button and safe-area padding, so it never covers
   * its own trigger.
   */
  function place(anchor, html, { align = 'start', gap = 6, width, arrow, sheet } = {}) {
    if (!anchor) return null;
    document.body.insertAdjacentHTML('beforeend', html);
    const pop = document.body.lastElementChild;
    pop.style.position = 'fixed';
    if (sheet && innerWidth <= 896 && pop.classList.contains('lb5')) {
      pop.classList.add('is-sheet');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-modal', 'true');
      pop.setAttribute('aria-label', sheet.title.replace(/<[^>]+>/g, ''));
      pop.insertAdjacentHTML('afterbegin', `<div class="sheet-head"><span class="grab" aria-hidden="true"></span>
        <div class="sheet-title"><strong lang="en">${sheet.title}</strong>${sheet.sub ? `<span>${sheet.sub}</span>` : ''}</div>
        <button class="btn btn-ghost btn-icon" type="button" aria-label="${t('v5.close')}">${ico('x')}</button></div>`);
      pop.insertAdjacentHTML('beforebegin', '<div class="sheet-scrim" aria-hidden="true"></div>');
      anchor.classList?.add('is-sheet-anchor');
      return pop;
    }
    const a = anchor.getBoundingClientRect();
    // At least the trigger's width (never capped below it), and at least 16rem.
    if (width === 'anchor') Object.assign(pop.style, { inlineSize: Math.min(Math.max(a.width, 256), innerWidth - 24) + 'px', maxInlineSize: 'none' });
    const w = pop.offsetWidth, vw = innerWidth, rtl = document.documentElement.dir === 'rtl';
    const end = (align === 'end') !== rtl;
    let left = end ? a.right - w : a.left;
    left = Math.max(12, Math.min(left, vw - w - 12));
    pop.style.left = left + 'px';
    const below = a.bottom + gap + pop.offsetHeight <= innerHeight - 12;
    if (below || a.top - gap - pop.offsetHeight < 12) pop.style.top = (a.bottom + gap) + 'px';
    else { pop.style.bottom = (innerHeight - a.top + gap) + 'px'; pop.classList.add('is-above'); }
    if (arrow) pop.style.setProperty('--arrow', (a.left + a.width / 2 - left - 6) + 'px');
    // Never past the viewport: the list inside gives up height, the search and footer stay.
    const over = pop.getBoundingClientRect().bottom - (innerHeight - 12);
    const list = pop.querySelector('.lb5-list');
    if (over > 0 && list) list.style.maxBlockSize = Math.max(120, list.offsetHeight - over) + 'px';
    return pop;
  }
  const scrollTo = name => {
    const f = document.querySelector(`[data-field="${name}"]`), sc = f?.closest('.pane-scroll');
    if (f && sc) sc.scrollTop = Math.max(0, f.offsetTop - (innerWidth > 900 ? 120 : 12));
  };
  if (q.scrollto) scrollTo(q.scrollto);
  /* ---------- The ID lookup ---------- */
  // The source of the options lives in the popover's footer, not under the field.
  //   lstate: ok | loading | empty | error | signedout    picked: the chosen record's name
  function lookupPop(name, lstate = 'ok', picked) {
    const accounts = window.TB_SAMPLES.customersPage.items;
    const src = `<code>GET /api/v2/customers?pageSize=100</code>`;
    const row = (a, active) => `<li class="lb5-opt${active ? ' is-active' : ''}" role="option" aria-selected="${a.name === picked}">
        <span class="lb5-check" aria-hidden="true">${a.name === picked ? ico('check', 'i i-sm') : ''}</span>
        <span class="chip-ico" aria-hidden="true">${esc(a.name[0])}</span>
        <span class="lb5-text"><span class="v" lang="en">${esc(a.name)}</span><span class="d mono">${esc(a.email)}</span></span>
        <span class="end">${a.status !== 'Active' ? `<span class="tag">${esc(a.status)}</span>` : ''}${esc(a.currency)}</span></li>`;
    const extras = `<li class="lb5-sep" role="separator"></li>
      <li class="lb5-opt" role="option" aria-selected="false"><span class="lb5-check"></span><span class="lead-ico">${ico('copy', 'i i-sm')}</span><span class="lb5-text"><span class="v">${t('v5.lk.paste')}</span></span><span class="end">${kbd('mod', 'V')}</span></li>
      <li class="lb5-opt" role="option" aria-selected="false"><span class="lb5-check"></span><span class="lead-ico">${ico('refresh', 'i i-sm')}</span><span class="lb5-text"><span class="v">${t('v5.lk.random')}</span><span class="d">${t('v5.lk.randomHint')}</span></span></li>`;
    const sk = Array.from({ length: 5 }, (_, i) => `<li class="lb5-sk" aria-hidden="true"><span class="sk sk-box"></span><span class="stack"><span class="sk sk-line" style="inline-size:${[52, 64, 44, 58, 48][i]}%"></span><span class="sk sk-line" style="inline-size:${[70, 62, 74, 66, 70][i]}%;block-size:0.55rem"></span></span><span class="sk sk-line" style="inline-size:2rem"></span></li>`).join('');
    const body = {
      ok: `<li class="lb5-group" role="presentation">${t('v5.lk.last')}</li>${row(accounts[3])}
           <li class="lb5-group" role="presentation">${t('v5.lk.all', { n: num(accounts.length) })}</li>${accounts.slice(0, 7).map((a, i) => row(a, i === 1)).join('')}${extras}`,
      loading: `<li class="lb5-group" role="presentation"><span class="spinner" aria-hidden="true" style="inline-size:0.75rem;block-size:0.75rem"></span>${t('v5.lk.loading')}</li>${sk}${extras}`,
      empty: `<li class="lb5-state" role="presentation"><strong>${ico('db', 'i i-sm')}${t('v5.lk.emptyTitle', { who: 'Ada Admin' })}</strong><p>${t('v5.lk.emptyBody')}</p><button class="btn btn-sm">${ico('plus', 'i i-sm')}<span lang="en">Register customer</span></button></li>${extras}`,
      error: `<li class="lb5-state is-error" role="presentation"><strong>${ico('alert', 'i i-sm')}${t('v5.lk.errorTitle')}</strong><p>${t('v5.lk.errorBody', { src, code: '500 Internal Server Error' })}</p><button class="btn btn-sm">${ico('refresh', 'i i-sm')}${t('v5.lk.retry')}</button></li>${extras}`,
      signedout: `<li class="lb5-state" role="presentation"><strong>${ico('lock', 'i i-sm')}${t('v5.lk.outTitle')}</strong><p>${t('v5.lk.outBody')}</p><button class="btn btn-sm btn-primary">${ico('log-in', 'i i-sm')}${t('signIn')}</button></li>${extras}`,
    }[lstate];
    // The footer is one line: icon, the request (its query string truncates, with a title),
    // who it ran as and how many came back, then Refresh.
    const meta = { ok: `<span class="who">${t('v5.lk.as', { who: 'Ada Admin' })}</span> · ${num(accounts.length)}`, loading: t('v5.lk.metaLoading'), empty: `<span class="who">${t('v5.lk.as', { who: 'Ada Admin' })}</span> · ${num(0)}`, error: t('v5.lk.metaError', { code: 500 }), signedout: t('v5.lk.metaOut') }[lstate];
    const srcLine = `<code class="src-q ltr" title="GET /api/v2/customers?pageSize=100"><span>GET /api/v2/customers</span><span class="qs">?pageSize=100</span></code><span class="meta">${meta}</span>`;
    return `<div class="pop lb5" data-for="${esc(name)}">
        <div class="lb5-search">${ico('search', 'i i-sm')}<input role="searchbox" placeholder="${t('v5.lk.search')}"></div>
        <ul class="lb5-list" role="listbox" aria-label="${t('v5.lk.label')}">${body}</ul>
        <div class="lb5-src">${ico(lstate === 'error' ? 'alert' : lstate === 'signedout' ? 'lock' : 'db', 'i i-sm')}${srcLine}<span class="spacer"></span><button class="btn btn-ghost btn-icon btn-xs" aria-label="${t('v5.lk.refresh')}" title="${t('v5.lk.refresh')}">${ico('refresh', 'i i-sm')}</button></div>
        <div class="pop-foot"><span>${kbd('↑↓')}${t('v5.k.move')}</span><span>${kbd('↵')}${t('v5.k.choose')}</span><span class="spacer"></span><span>${kbd('Esc')}</span></div>
      </div>`;
  }
  window.TB.v5.lookupPop = lookupPop;
  window.TB.v5.place = place;

  const pop = q.pop;
  if (!pop) return;

  /* ---------- A select's listbox ---------- */
  const o = S.operations.find(x => x.id === (q.opid || 'CustomersController.List'));
  const param = o?.op.parameters?.find(p => p.name === pop);
  if (param && V.enumOf(param.schema)) {
    if (!q.scrollto) scrollTo(pop);
    const f = V.fromParam(param, {});
    const control = document.querySelector(`[data-field="${pop}"] .sel5`);
    f.value = control?.querySelector('.sel5-value')?.textContent || undefined;
    const many = f.options.length > 8;
    place(control, V.listbox(f, { search: many ? (q.search ?? true) : false, active: q.active ?? (q.typed ? f.options.find(x => x.v.toLowerCase().startsWith(q.typed.toLowerCase()))?.v : f.value ?? ''), typed: q.typed }), { width: 'anchor', sheet: { title: S.esc(f.label), sub: S.md(param.description, { block: false }) } });
  }

  if (['id', 'customerId'].includes(pop)) {
    if (!q.scrollto) scrollTo(pop);
    const control = document.querySelector(`[data-field="${pop}"] .sel5`);
    const picked = control?.querySelector('.picked .main')?.textContent;
    place(control, lookupPop(pop, q.auth === 'out' ? 'signedout' : q.lstate || 'ok', picked), { width: 'anchor', sheet: { title: S.esc(pop), sub: t('v5.chooseAn', { name: 'a customer' }) } });
  }

  /* ---------- Language picker ---------- */
  if (pop === 'lang') {
    // Every UI language: autonym, English name and region, its own number and date format.
    const groups = [
      ['v5.lang.english', [['en-IE', 'English', 'Ireland'], ['en-GB', 'English', 'United Kingdom'], ['en-US', 'English', 'United States'], ['en-CA', 'English', 'Canada'], ['en-AU', 'English', 'Australia'], ['en-IN', 'English', 'India']]],
      ['v5.lang.west', [['de-DE', 'Deutsch', 'Deutschland', 'German'], ['fr-FR', 'Français', 'France', 'French'], ['es-ES', 'Español', 'España', 'Spanish'], ['it-IT', 'Italiano', 'Italia', 'Italian'], ['nl-NL', 'Nederlands', 'Nederland', 'Dutch'], ['pt-BR', 'Português', 'Brasil', 'Portuguese'], ['pt-PT', 'Português', 'Portugal', 'Portuguese']]],
      ['v5.lang.nordic', [['da-DK', 'Dansk', 'Danmark', 'Danish'], ['nb-NO', 'Norsk bokmål', 'Norge', 'Norwegian'], ['fi-FI', 'Suomi', 'Suomi', 'Finnish'], ['sv-SE', 'Svenska', 'Sverige', 'Swedish']]],
      ['v5.lang.central', [['cs-CZ', 'Čeština', 'Česko', 'Czech'], ['el-GR', 'Ελληνικά', 'Ελλάδα', 'Greek'], ['pl-PL', 'Polski', 'Polska', 'Polish'], ['ru-RU', 'Русский', 'Россия', 'Russian'], ['tr-TR', 'Türkçe', 'Türkiye', 'Turkish'], ['uk-UA', 'Українська', 'Україна', 'Ukrainian']]],
      ['v5.lang.rtl', [['ar', 'العربية', '', 'Arabic', 'rtl'], ['fa-IR', 'فارسی', 'ایران', 'Persian', 'rtl'], ['he-IL', 'עברית', 'ישראל', 'Hebrew', 'rtl']]],
      ['v5.lang.asia', [['hi-IN', 'हिन्दी', 'भारत', 'Hindi'], ['id-ID', 'Bahasa Indonesia', 'Indonesia', 'Indonesian'], ['ja-JP', '日本語', '日本', 'Japanese'], ['ko-KR', '한국어', '대한민국', 'Korean'], ['th-TH', 'ไทย', 'ไทย', 'Thai'], ['vi-VN', 'Tiếng Việt', 'Việt Nam', 'Vietnamese'], ['zh-Hans', '简体中文', '中国大陆', 'Chinese, Simplified'], ['zh-Hant', '繁體中文', '台灣', 'Chinese, Traditional']]],
    ];
    const regionEn = id => { try { const r = id.split('-')[1]; return r && r.length === 2 ? new Intl.DisplayNames(['en'], { type: 'region' }).of(r) : ''; } catch { return ''; } };
    const total = groups.reduce((n, [, l]) => n + l.length, 0);
    const current = { en: 'en-IE', de: 'de-DE', ar: 'ar', ja: 'ja-JP', he: 'he-IL' }[window.i18n.lang] || 'en-IE';
    const query = (q.lsearch || '').toLowerCase();
    const active = q.lactive || (query ? undefined : current);
    const sample = id => `${new Intl.NumberFormat(id, { minimumFractionDigits: 2 }).format(1250)} · ${new Intl.DateTimeFormat(id, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-11-23T00:00:00Z'))}`;
    const match = ([id, native, region, english]) => !query || [id, native, region, english || 'English', regionEn(id)].some(s => s && s.toLowerCase().includes(query));
    let firstActive;
    const rows = groups.map(([g, list]) => {
      const shown = list.filter(match);
      if (!shown.length) return '';
      return `<li class="lb5-group" role="presentation">${t(g)}</li>${shown.map(([id, native, region, english = 'English', dir]) => {
        const sel = id === current;
        const isActive = active ? id === active : !firstActive;
        if (isActive) firstActive = id;
        const sub = [english !== native ? english : '', regionEn(id)].filter(Boolean).join(' · ');
        return `<li class="lb5-opt${isActive ? ' is-active' : ''}" role="option" aria-selected="${sel}" lang="${id}">
          <span class="lb5-check" aria-hidden="true">${sel ? ico('check', 'i i-sm') : ''}</span>
          <span class="lb5-text"><span class="v native"><bdi>${native}</bdi></span><span class="d" lang="en" dir="ltr">${esc(sub || english)}</span></span>
          <span class="end">${dir ? '<span class="rtl-tag" title="Right to left">RTL</span>' : ''}<span class="sample">${sample(id)}</span></span></li>`;
      }).join('')}`;
    }).join('');
    const activeRtl = groups.flatMap(([, l]) => l).find(([id]) => id === firstActive)?.[4] === 'rtl';
    // The RTL preview: a real field in the picked language, mirrored, before you switch.
    const he = firstActive === 'he-IL';
    const preview = activeRtl ? `<div class="lang-preview" aria-label="${t('v5.lang.preview')}">
        <div class="lp-h">${ico('eye', 'i i-sm')}${t('v5.lang.previewRtl')}</div>
        <div class="lp-box" dir="rtl" lang="${he ? 'he' : 'ar'}">${V.field({ name: 'lp', label: 'status', kind: 'radio', optional: true, type: 'CustomerStatus', value: 'Active', options: [{ v: 'Active' }, { v: 'Suspended' }, { v: 'Closed' }], desc: '<span lang="en">Only customers with this status.</span>', status: he ? 'נשלח כ־<code>status=Active</code>' : 'يُرسل كـ <code>status=Active</code>' })
          .replace(`>${t('optional')}<`, `>${he ? 'אופציונלי' : 'اختياري'}<`).replace(`>${t('v5.clear')}<`, `>${he ? 'ניקוי' : 'مسح'}<`)}</div>
      </div>` : '';
    const btn = document.querySelector('.settings .row .btn.btn-sm');
    if (btn) btn.outerHTML = `<div class="control sel5 lang-btn is-focus is-open" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="true" aria-controls="lang-lb"><span class="sel5-value"><span>${{ en: 'English (Ireland)', de: 'Deutsch (Deutschland)', ar: 'العربية', ja: '日本語', he: 'עברית' }[window.i18n.lang]}</span><span class="sub ltr">${sample(current)}</span></span><span class="sel5-trigger" aria-hidden="true">${ico('chevron-down', 'i i-sm')}</span></div>`;
    place(document.querySelector('.lang-btn') || document.body, `<div class="pop lb5 lang5">
        <div class="lb5-search">${ico('search', 'i i-sm')}<input role="searchbox" aria-controls="lang-lb" placeholder="${t('v5.lang.search', { n: num(total) })}" value="${esc(q.lsearch || '')}"><span class="lb5-count">${query ? t('v5.matches', { n: num(groups.flatMap(([, l]) => l).filter(match).length) }) : ''}</span></div>
        <ul class="lb5-list" role="listbox" id="lang-lb" aria-label="${t('v5.lang.label')}">${rows}</ul>
        ${preview}
        <div class="pop-foot"><span>${t('v5.lang.foot')}</span><span class="spacer"></span><span>${kbd('Esc')}</span></div>
      </div>`, { align: 'end', sheet: { title: t('v5.lang.label'), sub: t('v5.lang.sub') } });
    // A submenu of Display settings: it opens beside the panel, top-aligned, so the list and
    // the RTL preview have the whole height instead of the space under the Language row.
    const panel = document.querySelector('.pop.settings')?.getBoundingClientRect();
    const picker = document.querySelector('.lang5');
    if (panel && picker && innerWidth > 900) {
      const rtl = document.documentElement.dir === 'rtl';
      Object.assign(picker.style, { top: panel.top + 'px', bottom: '', left: (rtl ? panel.right + 8 : panel.left - picker.offsetWidth - 8) + 'px' });
      const list = picker.querySelector('.lb5-list');
      list.style.maxBlockSize = '';
      const over = picker.getBoundingClientRect().bottom - (innerHeight - 12);
      if (over > 0) list.style.maxBlockSize = Math.max(160, list.offsetHeight - over) + 'px';
    }
  }

  /* ---------- Sidebar tooltip of a deprecated operation ---------- */
  if (pop === 'dep-tip') {
    const row = document.querySelector('.nav-item.is-deprecated');
    const dep = S.operations.find(x => x.deprecated);
    if (row && dep) {
      row.classList.add('is-hover');
      const sun = V.sunset(dep.op);
      const reps = V.replacements(dep.op).map(r => `<span lang="en">${esc(r.target.summary)}</span>`);
      place(row, `<div class="tooltip dep-tip" role="tooltip">
          <div class="row">${ico('warn', 'i i-sm')}<strong>${t('v5.dep.title')}</strong>${sun ? `<span class="dim">· ${t('v5.dep.sunsetShort', { date: sun.short })}</span>` : ''}</div>
          <div class="sub">${t('v5.dep.tipUse', { list: reps.join(t('v5.or')) })}</div>
        </div>`, { align: 'start', gap: 4 });
      const tip = document.querySelector('.dep-tip');
      const r = row.getBoundingClientRect();
      if (tip) { tip.style.left = (document.documentElement.dir === 'rtl' ? r.left - tip.offsetWidth - 8 : r.right + 8) + 'px'; tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px'; tip.style.bottom = ''; }
    }
  }

  /* ---------- Schema match ---------- */
  if (pop === 'match') {
    const fail = q.match === 'fail';
    const list = q.opid === 'CustomersController.List';
    const model = list ? 'PagedListOfCustomer' : 'Customer';
    const props = S.stats(model).count;
    const issues = [['country', t('v5.issue.length', { n: 2, got: '<code>"IRL"</code>', len: 3 })], ['email', t('v5.issue.missing')], ['legacyCode', t('v5.issue.extra', { model: 'Customer' })]];
    place(document.querySelector('#match-btn'), `<div class="pop toggletip match-tip${fail ? ' is-fail' : ''}" role="dialog" aria-labelledby="match-h">
        <div class="tt-body">
          <h3 id="match-h">${ico(fail ? 'warn' : 'circle-check', 'i i-sm')}${fail ? t('v5.match.failTitle', { n: issues.length }) : t('v5.match.okTitle')}</h3>
          <p>${fail ? t('v5.match.failBody', { model: `<a class="type-link" href="#">${model}</a>` }) : t('v5.match.okBody', { model: `<a class="type-link" href="#">${model}</a>`, n: num(props) })}</p>
          ${fail ? `<ul class="issue-list">${issues.map(([p, m]) => `<li><code>${p}</code><span>${m}</span></li>`).join('')}</ul>` : `<dl class="facts"><dt>${t('v5.match.schema')}</dt><dd><span class="ltr">200 · application/json</span> · ${model}</dd><dt>${t('v5.match.checked')}</dt><dd class="plain">${t('v5.match.checks')}</dd></dl>`}
          ${fail ? `<p class="faint" style="font-size:var(--fs-sm)">${t('v5.match.note')}</p>` : ''}
        </div>
        <div class="tt-foot"><a class="link" href="#">${t('v5.match.showSchema')}</a>${fail ? `<a class="link" href="#">${t('v5.match.copy')}</a>` : ''}<span class="spacer"></span>${kbd('Esc')}</div>
      </div>`, { gap: 10, arrow: true });
  }
})();

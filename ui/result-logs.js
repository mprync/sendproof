import { copyButton, copyTextButton, esc, icon, stateBlock } from './components.js';
import { formatList, formatNumber, t, th } from './i18n.js';
import { matchesShortcut, shortcutAttrs, shortcutHint } from './shortcuts.js';

// Log levels as the API names them: [badge, label key, filter group]. The badge is a fixed
// three-letter code; an unknown level keeps the name the API sent.
const levels = new Map([
  ['trace', ['TRC', 'trace', 'debug']], ['trc', ['TRC', 'trace', 'debug']],
  ['debug', ['DBG', 'debug', 'debug']], ['dbg', ['DBG', 'debug', 'debug']],
  ['information', ['INF', 'information', 'info']], ['info', ['INF', 'information', 'info']], ['inf', ['INF', 'information', 'info']],
  ['warning', ['WRN', 'warning', 'warning']], ['warn', ['WRN', 'warning', 'warning']], ['wrn', ['WRN', 'warning', 'warning']],
  ['error', ['ERR', 'error', 'error']], ['err', ['ERR', 'error', 'error']],
  ['critical', ['CRT', 'critical', 'error']], ['fatal', ['CRT', 'critical', 'error']],
  ['sql', ['SQL', 'sql', 'sql']],
]);
const filters = ['all', 'info', 'warning', 'error'];

function logEntries(result) {
  return (result.logs ?? []).filter(log => log && typeof log === 'object');
}

/** [badge, label, filter group] for a log entry. */
function logLevel(log) {
  const level = String(log.level ?? '');
  const known = levels.get(level.toLowerCase());
  return known ? [known[0], t('logs.level.' + known[1]), known[2]] : [level.slice(0, 3).toUpperCase(), level, 'other'];
}

function collapseLine(text) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/** A captured millisecond value as a number in this locale, with one or two decimals. */
function milliseconds(value) {
  return Number.isFinite(value)
    ? formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 2, useGrouping: false }) : '';
}

function sourceLabel(category) {
  if (category?.startsWith('Microsoft.EntityFrameworkCore.')) return t('logs.source.efCore');
  if (category?.startsWith('Microsoft.AspNetCore.Hosting.')) return t('logs.source.hosting');
  return category;
}

function messageMarkup(message, properties) {
  const values = Object.entries(properties ?? {}).filter(([, value]) => typeof value === 'string' && value.trim())
    .sort((a, b) => b[1].length - a[1].length);
  if (!values.length) return esc(message);
  const names = new Map(values.map(([key, value]) => [value, key]));
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(values.map(([, value]) => escaped(value)).join('|'), 'g');
  let html = '';
  let end = 0;
  for (const match of message.matchAll(pattern)) {
    html += esc(message.slice(end, match.index)) + `<span class="prop" title="${esc(names.get(match[0]))}">${esc(match[0])}</span>`;
    end = match.index + match[0].length;
  }
  return html + esc(message.slice(end));
}

function pairs(entries) {
  return entries.filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
}

function sqlMarkup(text) {
  const tokens = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]|\b(?:select|from|where|insert|into|values|update|set|delete|join|returning|as|limit|order|group|by)\b/gi;
  let output = '';
  let end = 0;
  for (const { 0: token, index } of text.matchAll(tokens)) {
    output += esc(text.slice(end, index)) + (/^[a-z]/i.test(token) ? `<span class="tok-k">${esc(token)}</span>` : esc(token));
    end = index + token.length;
  }
  return output + esc(text.slice(end));
}

function detailMarkup(log, index) {
  const { sql, exception } = log;
  const elapsed = milliseconds(log.elapsedMs);
  const offset = milliseconds(log.offsetMs);
  const eventId = log.eventId && [log.eventId.id, log.eventId.name].filter(value => value != null).join(' ');
  const metadata = pairs([
    [t('logs.field.category'), log.category], [t('logs.field.eventId'), eventId],
    [t('logs.field.offset'), offset && t('logs.msValue', { n: offset })],
    [t('logs.field.elapsed'), elapsed && t('logs.msValue', { n: elapsed })], [t('logs.field.rows'), sql?.rowsAffected],
  ]);
  const properties = pairs(Object.entries(log.properties ?? {}));
  const parameters = sql?.parameters ?? [];
  return `<div class="log-detail" id="capture-log-${index}" role="row" hidden><div role="cell" aria-colspan="6">
    ${metadata ? `<dl class="log-props">${metadata}</dl>` : ''}
    ${sql?.text ? `<pre class="sql" tabindex="0" aria-label="${esc(t('logs.sqlStatement'))}">${sqlMarkup(sql.text)}</pre>` : log.message
      ? `<div class="log-message">${esc(log.message)}</div>` : ''}
    ${parameters.length ? `<dl class="params">${parameters.map(param =>
      `<dt>${esc(param.name)}</dt><dd>${esc(param.value ?? 'null')}${param.dbType ? ` <span class="faint">· ${esc(param.dbType)}</span>` : ''}</dd>`).join('')}</dl>` : ''}
    ${properties ? `<dl class="log-props">${properties}</dl>` : ''}
    ${exception ? `<div class="log-message"><strong>${esc(exception.type || t('logs.exception'))}</strong> ${esc(exception.message)}</div>` : ''}
    <div class="fx-acts">
      ${sql?.text ? copyTextButton(t('logs.copySql'), { data: 'data-log-copy="sql"' }) : ''}
      ${copyTextButton(t('logs.copyJson'), { data: 'data-log-copy="json"' })}
    </div>
  </div></div>`;
}

function logRow(log, index) {
  const [badge, level, group] = logLevel(log);
  const modifier = group === 'warning' ? 'wrn' : group === 'error' ? 'err' : group === 'debug' ? 'dbg' : group;
  const message = collapseLine(log.sql?.text || log.message);
  return `<div class="log-row lvl-${modifier}" role="row" data-log-row="${index}" tabindex="${index ? '-1' : '0'}"
      ${shortcutAttrs('up', 'down', 'enter')}>
    <span role="cell" class="chev"><button type="button" class="capture-chevron log-toggle" tabindex="-1" data-log-toggle
      aria-label="${esc(t('logs.details'))}" aria-expanded="false" aria-controls="capture-log-${index}">${icon('chevron-right', true)}</button></span>
    <span role="cell" class="t">${milliseconds(log.offsetMs)}</span>
    <span role="cell"><span class="lvl" title="${esc(level)}"><span aria-hidden="true">${esc(badge)}</span><span class="sr-only">${esc(level)}</span></span></span>
    <span role="cell" class="dur">${milliseconds(log.elapsedMs)}</span>
    <span role="cell" class="src" title="${esc(log.category)}">${esc(sourceLabel(log.category))}</span>
    <span role="cell" class="msg">${log.sql?.text ? `<code>${esc(message)}</code>` : messageMarkup(message, log.properties)}</span>
  </div>${detailMarkup(log, index)}`;
}

/** The logs pane: level filters, a search box, the log table and a scope note. */
export function logsMarkup(result) {
  const logs = logEntries(result);
  const counts = { all: logs.length };
  for (const log of logs) {
    const group = logLevel(log)[2];
    counts[group] = (counts[group] ?? 0) + 1;
  }
  const truncated = result.logsTruncated ? esc(t('logs.truncated')) : '';
  if (!logs.length) return `<p class="faint capture-note">${esc(t('logs.none'))} ${truncated}</p>`;

  return `<div class="log-bar">
    <div class="segmented" role="group" aria-label="${esc(t('logs.levelGroup'))}">
      ${filters.map(value => `<button type="button" data-log-level="${value}" aria-pressed="${value === 'all'}">${esc(t('logs.filter.' + value))} <span class="faint">${formatNumber(counts[value] ?? 0)}</span></button>`).join('')}
    </div>
    ${counts.sql ? `<button class="btn btn-sm" type="button" data-log-sql aria-pressed="true">${icon('db', true)}${esc(t('logs.sqlCount', { n: formatNumber(counts.sql) }))}</button>` : ''}
    <label class="input-sm grow">${icon('filter', true)}<span class="sr-only">${esc(t('logs.filterLabel'))}</span><input type="search" data-log-search placeholder="${esc(t('logs.filterPlaceholder'))}"></label>
    ${copyButton(t('logs.copyAll'), { data: 'data-log-copy-all' })}
  </div>
  <div class="logs" role="table" aria-label="${esc(t('logs.table'))}">
    <div class="logs-inner" role="rowgroup">
      <div class="log-row head" role="row"><span role="columnheader"><span class="sr-only">${esc(t('logs.col.expand'))}</span></span><span role="columnheader">${esc(t('logs.col.ms'))}</span><span role="columnheader">${esc(t('logs.col.level'))}</span><span role="columnheader">${esc(t('logs.col.took'))}</span><span role="columnheader">${esc(t('logs.col.source'))}</span><span role="columnheader">${esc(t('logs.col.message'))}</span></div>
      ${logs.map(logRow).join('')}
    </div>
  </div>
  <div data-log-no-match role="status" hidden></div>
  <div class="log-meta"><span>${result.traceId ? th('logs.scopedTrace', { id: `<code>${esc(result.traceId)}</code>` }) : esc(t('logs.scoped'))}</span>
    <span class="spacer"></span><span>${th('logs.keys', { move: shortcutHint('up', 'down'), expand: shortcutHint('enter') })}</span></div>
  ${truncated ? `<p class="faint capture-note">${truncated}</p>` : ''}`;
}

function sqlWithValues({ text, parameters }) {
  // Keep the original command and record the captured bindings without rewriting SQL literals.
  const bindings = (parameters ?? []).map(({ name, value, dbType }) =>
    `-- ${collapseLine(name)} = ${JSON.stringify(value ?? null)}${dbType ? ` (${collapseLine(dbType)})` : ''}`);
  return [...bindings, text].join('\n');
}

function searchableText(log) {
  return [log.level, log.category, log.message, log.eventId?.name, log.exception?.type,
    log.exception?.message, log.sql?.text, ...Object.entries(log.properties ?? {}).flat(),
    ...(log.sql?.parameters ?? []).flatMap(({ name, value, dbType }) => [name, value, dbType])]
    .map(collapseLine).join(' ').toLowerCase();
}

/**
 * Wires the filters, search, row expansion and copy buttons. `copy(text, target)` is the helper
 * from bindCapturePane; the copied text is the captured data exactly as received.
 */
export function bindLogs(container, result, copy) {
  const logs = logEntries(result);
  const rows = [...container.querySelectorAll('[data-log-row]')];
  if (!rows.length) return;
  const levels = [...container.querySelectorAll('[data-log-level]')];
  const sql = container.querySelector('[data-log-sql]');
  const search = container.querySelector('[data-log-search]');
  const noMatch = container.querySelector('[data-log-no-match]');
  const searchIndex = logs.map(searchableText);
  let active = rows[0];
  let filter = 'all';
  let includeSql = !!sql;
  let visible = rows;

  function activate(row, focus) {
    if (active) active.tabIndex = -1;
    active = row;
    if (!row) return;
    row.tabIndex = 0;
    if (focus) row.focus();
  }

  function applyFilters() {
    const match = search.value.trim().toLowerCase();
    visible = rows.filter((row, index) => {
      const group = logLevel(logs[index])[2];
      const show = (group === 'sql' ? includeSql : filter === 'all' || group === filter) &&
        searchIndex[index].includes(match);
      row.hidden = !show;
      row.nextElementSibling.hidden = !show || row.querySelector('[data-log-toggle]').getAttribute('aria-expanded') !== 'true';
      return show;
    });
    activate(visible.includes(active) ? active : visible[0]);
    noMatch.hidden = visible.length !== 0;
    const table = container.querySelector('.logs');
    if (table) table.hidden = visible.length === 0;
    if (!visible.length) noMatch.innerHTML = noMatchState(match);
  }

  /** Filters that hide every entry say which filters did it, with a way back (mock 37). */
  function noMatchState(match) {
    const parts = [];
    if (filter !== 'all') parts.push(th('logs.hiddenLevel', { level: `<strong>${esc(t('logs.filter.' + filter))}</strong>` }));
    if (match) parts.push(th('logs.hiddenText', { text: esc(search.value.trim()) }));
    return stateBlock({
      glyph: 'filter', compact: true, title: esc(t('logs.noMatchTitle')),
      body: th('logs.noMatchBody', { n: rows.length, filters: parts.length ? formatList(parts) : esc(t('logs.hiddenSql')) }),
      actions: [`<button type="button" class="btn btn-sm" data-log-clear>${esc(t('logs.clearFilters'))} ${shortcutHint('escape')}</button>`,
        filter !== 'all' ? `<button type="button" class="btn btn-ghost btn-sm" data-log-all-levels>${esc(t('logs.allLevels'))}</button>` : ''].filter(Boolean),
    });
  }

  noMatch.addEventListener?.('click', event => {
    if (event.target.closest('[data-log-clear]')) { search.value = ''; levels[0]?.click(); search.focus(); }
    else if (event.target.closest('[data-log-all-levels]')) levels[0]?.click();
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (search.value || filter !== 'all')) { event.preventDefault(); event.stopPropagation(); search.value = ''; levels[0]?.click(); }
  });

  for (const button of levels) {
    button.addEventListener('click', () => {
      filter = button.dataset.logLevel;
      levels.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      includeSql = !!sql && filter === 'all';
      sql?.setAttribute('aria-pressed', String(includeSql));
      applyFilters();
    });
  }
  sql?.addEventListener('click', () => {
    includeSql = !includeSql;
    sql.setAttribute('aria-pressed', String(includeSql));
    applyFilters();
  });
  search.addEventListener('input', applyFilters);
  container.querySelector('[data-log-copy-all]').addEventListener('click', event => {
    const table = container.querySelector('.logs');
    copy(JSON.stringify(logs, null, 2), { button: event.currentTarget, what: t('copy.what.logs'), select: table, notice: table });
  });

  for (const [index, row] of rows.entries()) {
    const details = row.nextElementSibling;
    const disclosure = row.querySelector('[data-log-toggle]');
    function toggle() {
      details.hidden = !details.hidden;
      row.classList.toggle('is-open', !details.hidden);
      disclosure.setAttribute('aria-expanded', String(!details.hidden));
    }
    row.addEventListener('click', () => {
      activate(row, true);
      toggle();
    });
    row.addEventListener('keydown', event => {
      if (matchesShortcut('enter', event)) {
        event.preventDefault();
        toggle();
      } else {
        const step = matchesShortcut('up', event) ? -1 : matchesShortcut('down', event) ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = visible[visible.indexOf(row) + step];
        if (next) activate(next, true);
      }
    });
    for (const button of details.querySelectorAll('[data-log-copy]')) {
      button.addEventListener('click', () => {
        const sqlCopy = button.dataset.logCopy === 'sql';
        copy(sqlCopy ? sqlWithValues(logs[index].sql) : JSON.stringify(logs[index], null, 2), {
          button,
          what: t(sqlCopy ? 'copy.what.sql' : 'logs.what.entry'),
          select: details.querySelector(sqlCopy ? '.sql' : '.log-message') ?? details,
          notice: details.querySelector('.fx-acts'),
        });
      });
    }
  }
}

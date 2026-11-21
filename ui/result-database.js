import { esc, icon } from './components.js';
import { t, th } from './i18n.js';

const operations = {
  insert: ['ins', '+ INSERT'],
  update: ['upd', '~ UPDATE'],
  delete: ['del', '− DELETE'],
};

const serialize = value => typeof value === 'string' ? value : JSON.stringify(value);

function renderRows(change, columns) {
  const { before, after, operation } = change;
  return columns.map(key => {
    const original = serialize(before?.[key]);
    const updated = serialize(after?.[key]);
    const title = operation === 'update' ? `${original} → ${updated}` : operation === 'delete' ? original : updated;
    const value = operation === 'update'
      ? `<span class="old">${esc(original)}</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">${esc(t('db.changedTo'))}</span>${esc(updated)}`
      : esc(operation === 'delete' ? original : updated);
    const style = operation === 'delete' ? 'old' : operation === 'insert' ? 'new' : '';
    return `<div class="k" title="${esc(key)}">${esc(key)}</div><div class="v ${style}" title="${esc(title)}">${value}</div>`;
  }).join('');
}

function changeCard(change) {
  const operation = String(change.operation || '').toLowerCase();
  const [style, label] = operations[operation] || ['', operation.toUpperCase()];
  const columns = Object.keys({ ...change.before, ...change.after })
    .filter(key => operation !== 'update' || serialize(change.before?.[key]) !== serialize(change.after?.[key]));
  const leading = columns.slice(0, 5);
  const rest = columns.slice(5);
  return `<article class="table-change" aria-label="${esc(t('db.cardLabel', { table: change.table, operation }))}">
    <div class="tc-head">${label ? `<span class="op-badge op-${style}">${esc(label)}</span>` : ''}
      <span class="name" title="${esc(change.table)}">${esc(change.table)}</span>
      <span class="spacer"></span><span class="faint" title="${esc(serialize(change.key))}">${esc(t('db.rows', { n: 1 }))}</span>
    </div>
    <div class="kv">${renderRows(change, leading)}</div>
    ${rest.length ? `<details><summary class="more-cols">${icon('chevron-down', true)}${esc(t('db.moreColumns', { n: rest.length }))}</summary>
      <div class="kv">${renderRows(change, rest)}</div></details>` : ''}
  </article>`;
}

/** Render actual captured row deltas and a compact summary linking to the effects (mocks 01, 49). */
export function databaseMarkup(result, capabilities) {
  const count = result.changes.length;
  const databaseName = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const db = databaseName ? `<code class="ltr">${esc(databaseName)}</code>` : esc(t('db.thisDatabase'));
  const actor = capabilities.identity?.name;
  const vars = { db, name: esc(actor || ''), n: count };
  const banner = result.preview
    ? `<div class="banner">${icon('undo')}<div><strong>${esc(t('db.rolledTitle'))}</strong> ${th(actor ? 'db.rolledBodyAs' : 'db.rolledBody', vars)}</div></div>`
    : result.status < 400
      ? `<div class="banner banner-ok">${icon('check')}<div><strong>${esc(t('db.committedTitle'))}</strong> ${th(actor ? 'db.committedBodyAs' : 'db.committedBody', vars)}</div><button type="button" class="btn btn-ghost btn-xs" data-action="traced-off">${esc(t('res.tracedOff'))}</button></div>`
      : `<div class="banner banner-neutral">${icon('info')}<div><strong>${esc(t('db.capturedTitle'))}</strong> ${th('db.capturedBody', vars)}</div></div>`;
  const effect = result.effects?.find(item => item.kind === 'email') || result.effects?.[0];
  const matching = effect ? result.effects.filter(item => item.kind === effect.kind) : [];
  const effectSummary = effect ? `<div class="effect">
    ${icon(effect.kind === 'email' ? 'mail' : 'send')}<div class="grow">
      <div class="t">${esc(t(`db.effect.${effect.kind === 'email' ? 'email' : 'other'}.${result.preview ? 'held' : 'recorded'}`, { n: matching.length, kind: effect.kind }))}</div>
      <div class="s" lang="en">${esc(effect.description)}</div>
    </div><button type="button" class="btn btn-ghost btn-sm" data-result-tab="Side effects">${esc(t('db.view'))}</button>
  </div>` : '';
  return `${banner}
    ${result.changes.map(changeCard).join('')}
    ${result.changesTruncated ? `<p class="faint">${esc(t('db.truncated'))}</p>` : ''}
    ${effectSummary}`;
}

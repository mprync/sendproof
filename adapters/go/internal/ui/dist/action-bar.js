// The action bar under the request (mock: request.js "action bar"): a status line that wraps to
// two lines rather than truncating, then fixed-width Send and Preview buttons. Safe methods
// show one primary Send and say why there is no Preview instead of disabling it.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { shortcutAttrs, shortcutHint, shortcutLong, shortcutLabel } from './shortcuts.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for methods that can't change anything, so Preview has nothing to roll back. */
export const isReadOnly = op => SAFE.has(op?.method);

/** The default status line for an operation. */
export function idleStatus(op, previewAvailable) {
  if (isReadOnly(op)) return `<span class="status">${icon('eye', true)}<span>${esc(t('bar.readOnly', { method: op.method }))}</span></span>`;
  if (!previewAvailable) return `<span class="status">${icon('info', true)}<span>${esc(t('bar.noPreview'))}</span></span>`;
  return `<span class="status">${icon('undo', true)}<span>${esc(t('bar.rule'))}</span></span>`;
}

/** Send and Preview. Preview only exists when the operation can be previewed and isn't read-only. */
export function runButtons(op, previewAvailable) {
  const readOnly = isReadOnly(op);
  const sendShortcut = readOnly ? 'send-read-only' : 'send';
  const send = `<button type="button" class="btn btn-run btn-send${readOnly || !previewAvailable ? ' btn-primary' : ''}" id="send-btn" data-action="send" ${shortcutAttrs(sendShortcut)} title="${esc(t(readOnly ? 'bar.sendTipReadOnly' : 'bar.sendTip') + ' · ' + shortcutLong(sendShortcut))}">${icon('send', true)}<span>${esc(t('bar.send'))}</span>${shortcutHint(sendShortcut)}</button>`;
  const preview = readOnly || !previewAvailable ? ''
    : `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="preview" ${shortcutAttrs('preview')} title="${esc(shortcutLabel('preview') + ' · ' + shortcutLong('preview'))}">${icon('flask', true)}<span>${esc(t('bar.preview'))}</span>${shortcutHint('preview')}</button>`;
  return send + preview;
}

/** The whole bar for an idle operation. */
export const actionBar = (op, previewAvailable) => op ? idleStatus(op, previewAvailable) + runButtons(op, previewAvailable) : '';

/** The status while a request runs: who it runs as, and that editing stays possible. */
export function runningStatus(preview, identity) {
  const key = preview ? (identity ? 'bar.previewingAs' : 'bar.previewing') : (identity ? 'bar.sendingAs' : 'bar.sending');
  return `<span class="spinner" aria-hidden="true"></span><span>${esc(t(key, { name: identity }))}</span>`;
}

/** The status after generated values were filled in, with Undo. */
export function generatedStatus(count) {
  return `<span class="status is-ok" role="status">${icon('wand', true)}<span>${esc(t('bar.filled', { n: count }))}</span><button type="button" class="btn btn-ghost btn-xs" data-action="undo-fill" ${shortcutAttrs('autofill-undo')}>${esc(t('bar.undo'))} ${shortcutHint('autofill-undo')}</button></span>`;
}

/**
 * The confirmation that replaces the buttons before a committing Send. Cancel and Confirm send sit
 * in one pair that is at least as wide as Send + Preview, so the status keeps its room, and that
 * grows to fit a long translation instead of clipping it (see .run-pair in app.css).
 */
export function confirmation(method, path) {
  return `<span class="status" role="status"><span>${esc(t('bar.confirm', { method, path }))}</span></span>
    <span class="run-pair">
      <button type="button" class="btn btn-run btn-ghost" data-action="cancel-confirm" ${shortcutAttrs('escape')}>${esc(t('bar.cancel'))} ${shortcutHint('escape')}</button>
      <button type="button" class="btn btn-run btn-primary" data-action="confirm-send" ${shortcutAttrs('send')}>${icon('send', true)}<span>${esc(t('bar.confirmSend'))}</span>${shortcutHint('send')}</button>
    </span>`;
}

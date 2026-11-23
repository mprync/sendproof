import assert from 'node:assert/strict';
import test from 'node:test';
import { configure } from './i18n.js';
import { actionForKey, dialogMarkup, dialogOffer, dialogRow, initialAction, nextFocus, openDialog, plainText } from './dialog.js';

configure({ language: 'en-IE', platform: 'mac' });

const actions = [
  { label: 'Cancel', value: false },
  { label: 'Send run', kind: 'primary', value: true, icon: 'send', shortcut: 'send' },
];

test('focus starts on the safe action, never on the one that commits', () => {
  assert.equal(initialAction(actions), 0);
  assert.equal(initialAction([{ label: 'Stop', kind: 'danger' }, { label: 'Keep going' }]), 1);
  assert.equal(initialAction([{ label: 'Close' }, { label: 'Start again', kind: 'primary', focus: true }]), 1, 'a notice may mark its own');
  assert.equal(initialAction([{ label: 'OK', kind: 'primary' }]), 0, 'a lone action has focus');
});

test('the markup marks the safe action, shows the committing chord, and names its parts for assistive technology', () => {
  const markup = dialogMarkup({ tone: 'warn', glyph: 'send', title: 'Send this run for real?', body: 'It stays written.', actions }, 'd1');
  assert.match(markup, /data-dialog-action="0" data-dialog-initial autofocus/);
  assert.doesNotMatch(markup, /data-dialog-action="1"[^>]*data-dialog-initial/);
  assert.match(markup, /btn btn-primary btn-sm" type="button" data-dialog-action="1"[^>]*aria-keyshortcuts="Meta\+Shift\+Enter Control\+Shift\+Enter"/);
  assert.match(markup, /<kbd class="kbd">⇧⌘↵<\/kbd>/);
  assert.match(markup, /id="d1-t"/);
  assert.match(markup, /id="d1-d"/);
  assert.match(markup, /data-dialog-close aria-label="Close" title="Close · Esc"/);
  assert.match(dialogMarkup({ tone: 'danger', glyph: 'stop', title: 'x', actions: [{ label: 'Keep going' }, { label: 'Stop run', kind: 'danger' }] }), /btn btn-sm dl-danger/);
});

test('a row is a name with its subtitle under it, escaped, with the full text as its tooltip', () => {
  const row = dialogRow({ mark: '<i></i>', name: 'SQLite <b>', code: 'store-demo.db', sub: '14 rows in <bdi dir="ltr">Orders</bdi> &amp; more' });
  assert.match(row, /<span class="dl-name">SQLite &lt;b&gt; <bdi dir="ltr"><code>store-demo\.db<\/code><\/bdi><\/span>/);
  assert.match(row, /<span class="dl-sub">14 rows in <bdi dir="ltr">Orders<\/bdi> &amp; more<\/span>/);
  assert.match(row, /title="SQLite &lt;b&gt; store-demo\.db\n?14 rows in Orders &amp; more"/);
  assert.equal(plainText('a &lt; <bdi>b</bdi> &amp; c'), 'a < b & c');
  assert.match(dialogOffer({ value: 'undo', httpMethod: 'post', name: 'Cancel order', sub: 'Releases the units' }), /data-dialog-value="undo"[^]*m-post[^]*Cancel order/);
});

test('Tab wraps inside the dialog in both directions', () => {
  assert.equal(nextFocus(3, 2, false), 0);
  assert.equal(nextFocus(3, 0, true), 2);
  assert.equal(nextFocus(3, 1, false), 2);
  assert.equal(nextFocus(3, -1, false), 0, 'from outside it enters at the start');
  assert.equal(nextFocus(3, -1, true), 2);
  assert.equal(nextFocus(0, -1, false), -1);
});

test('only the shown chord commits: Shift+Mod+Enter, never plain Enter', () => {
  const key = (init = {}) => ({ key: 'Enter', code: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });
  assert.deepEqual(actionForKey(actions, key({ metaKey: true, shiftKey: true })), { value: true });
  assert.deepEqual(actionForKey(actions, key({ ctrlKey: true, shiftKey: true })), { value: true });
  assert.equal(actionForKey(actions, key()), null, 'plain Enter');
  assert.equal(actionForKey(actions, key({ metaKey: true })), null, 'Mod+Enter is Preview, not Send');
  assert.equal(actionForKey(actions, key({ shiftKey: true })), null);
});

/** A document with just what openDialog touches: a dialog element, the opener and the controls. */
function fakeDom(controls = 3) {
  const log = { removed: false, closed: false, shown: false };
  const events = {};
  const buttons = Array.from({ length: controls }, (_, index) => ({ index, focus() { doc.activeElement = this; } }));
  const opener = { isConnected: true, focus() { doc.activeElement = this; } };
  const host = {
    attributes: {}, innerHTML: '', className: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { (events[type] ??= []).push(listener); },
    querySelector: selector => selector === '[data-dialog-initial]' ? buttons[0] : null,
    querySelectorAll: () => buttons,
    showModal() { log.shown = true; },
    close() { log.closed = true; },
    remove() { log.removed = true; },
  };
  const doc = { activeElement: opener, createElement: () => host, body: { append() {} } };
  const fire = (type, init = {}) => {
    const event = { type, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    for (const listener of events[type] ?? []) listener(event);
    return event;
  };
  const target = (match) => ({ closest: selector => match[selector] ?? null });
  return { doc, host, buttons, opener, log, fire, target };
}

async function open(spec, controls) {
  const dom = fakeDom(controls);
  const saved = globalThis.document;
  globalThis.document = dom.doc;
  let settled;
  const promise = openDialog(spec).then(value => { settled = { value }; return value; });
  globalThis.document = saved;
  return { ...dom, promise, settled: () => settled };
}
const pending = () => new Promise(resolve => setImmediate(resolve));

test('it opens as a modal dialog with focus on Cancel, and a warning is an alertdialog', async () => {
  const dialog = await open({ tone: 'warn', glyph: 'send', title: 'Send?', body: 'Body', actions });
  assert.equal(dialog.log.shown, true, 'showModal makes the page behind it inert');
  assert.equal(dialog.host.attributes.role, 'alertdialog');
  assert.equal(dialog.host.attributes['aria-modal'], 'true');
  assert.match(dialog.host.attributes['aria-labelledby'], /^dl-\d+-t$/);
  assert.equal(dialog.doc.activeElement, dialog.buttons[0], 'focus is on the safe action');
  dialog.fire('keydown', { key: 'Escape' });
  await dialog.promise;
  const calm = await open({ tone: 'neutral', glyph: 'flask', title: 'End?', actions });
  assert.equal(calm.host.attributes.role, 'dialog');
  calm.fire('cancel');
  await calm.promise;
});

test('Esc, the native cancel and the close button resolve null, and focus returns to the opener', async () => {
  for (const dismiss of [
    dialog => dialog.fire('keydown', { key: 'Escape' }),
    dialog => dialog.fire('cancel'),
    dialog => dialog.fire('click', { target: dialog.target({ '[data-dialog-close]': {} }) }),
  ]) {
    const dialog = await open({ tone: 'warn', glyph: 'send', title: 'Send?', actions });
    dismiss(dialog);
    assert.equal(await dialog.promise, null);
    assert.equal(dialog.log.removed, true);
    assert.equal(dialog.doc.activeElement, dialog.opener, 'focus returns to what opened it');
  }
});

test('Esc is handled by the dialog alone: the workbench’s own shortcuts do not hear it', async () => {
  const dialog = await open({ tone: 'neutral', glyph: 'flask', title: 'End?', actions });
  const event = dialog.fire('keydown', { key: 'Escape' });
  assert.equal(event.stopped, true);
  assert.equal(event.defaultPrevented, true);
  await dialog.promise;
});

test('plain Enter does not commit; the chord does, once', async () => {
  const dialog = await open({ tone: 'warn', glyph: 'send', title: 'Send?', actions });
  const plain = dialog.fire('keydown', { key: 'Enter', code: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
  await pending();
  assert.equal(dialog.settled(), undefined, 'Enter alone leaves the question open');
  assert.equal(plain.stopped, true, 'and never reaches the workbench');
  const chord = dialog.fire('keydown', { key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true, altKey: false, ctrlKey: false });
  assert.equal(chord.defaultPrevented, true);
  assert.equal(await dialog.promise, true);
  dialog.fire('keydown', { key: 'Escape' });
  assert.equal(dialog.settled().value, true, 'it resolves once');
});

test('each action resolves its own value, and an offered row resolves its value', async () => {
  const cancel = await open({ tone: 'warn', glyph: 'send', title: 'Send?', actions });
  cancel.fire('click', { target: cancel.target({ '[data-dialog-action]': { dataset: { dialogAction: '0' } } }) });
  assert.equal(await cancel.promise, false);
  const go = await open({ tone: 'warn', glyph: 'send', title: 'Send?', actions });
  go.fire('click', { target: go.target({ '[data-dialog-action]': { dataset: { dialogAction: '1' } } }) });
  assert.equal(await go.promise, true);
  const undo = await open({ tone: 'danger', glyph: 'stop', title: 'Stop?', actions: [{ label: 'Keep going', value: false }, { label: 'Stop run', kind: 'danger', value: true }] });
  undo.fire('click', { target: undo.target({ '[data-dialog-value]': { dataset: { dialogValue: 'undo' } } }) });
  assert.equal(await undo.promise, 'undo');
});

test('Tab and Shift+Tab stay inside the dialog', async () => {
  const dialog = await open({ tone: 'warn', glyph: 'send', title: 'Send?', actions }, 3);
  dialog.doc.activeElement = dialog.buttons[2];
  const forward = dialog.fire('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(dialog.doc.activeElement, dialog.buttons[0], 'from the last control to the first');
  dialog.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(dialog.doc.activeElement, dialog.buttons[2], 'and back');
  dialog.fire('cancel');
  await dialog.promise;
});

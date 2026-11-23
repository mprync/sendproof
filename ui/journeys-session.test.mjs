import assert from 'node:assert/strict';
import test from 'node:test';
import { configure } from './i18n.js';
import { confirmSessionOpenFailed } from './journeys-dialogs.js';
import { overviewBar, stepBar, summaryBar } from './journeys-view.js';
import { endHeldSessions, heldSessionsKey, openSession, SessionError, sessionGone, storeBusy } from './journeys-session.js';

configure({ language: 'en-IE', platform: 'mac' });

const BASE = 'https://api.test/sendproof/';
const ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
};

/** A host that opens sessions with the given IDs in turn, answers DELETE with `deleted` and records every call. */
function host({ ids = [ID], deleted = 204, open } = {}) {
  const calls = [];
  const queue = [...ids];
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, keepalive: init.keepalive });
    if (init.method === 'POST') return open ?? json(201, { id: queue.shift(), idleTimeoutSeconds: 300, maxLifetimeSeconds: 1800 });
    if (init.method === 'DELETE') return json(deleted);
    return json(404, {});
  };
  return { fetch, calls };
}

test('a held session is remembered for this tab and forgotten when it ends', async () => {
  const storage = memory();
  const api = host();
  const session = await openSession({ base: BASE, fetch: api.fetch, storage });
  assert.deepEqual(JSON.parse(storage.getItem(heldSessionsKey(BASE))), [ID]);
  await session.end();
  assert.equal(storage.getItem(heldSessionsKey(BASE)), null, 'the key is cleared once the session ends');
  await session.end();
  assert.equal(api.calls.filter(call => call.method === 'DELETE').length, 1, 'and it ends once');
});

test('the id is forgotten even when ending it fails: the idle timeout is the backstop', async () => {
  const storage = memory();
  const session = await openSession({ base: BASE, fetch: async (url, init) => { if (init.method === 'DELETE') throw new TypeError('offline'); return { status: 201, json: async () => ({ id: ID }) }; }, storage });
  await session.end();
  assert.equal(storage.getItem(heldSessionsKey(BASE)), null);
});

test('a crash-reloaded tab ends the session its closed page left, and forgets it', async () => {
  const storage = memory();
  await openSession({ base: BASE, fetch: host().fetch, storage });
  // The page crashed: nothing ended it. The reloaded page (new module state, same sessionStorage) reclaims it.
  const reloaded = host({ deleted: 204 });
  assert.equal(await endHeldSessions({ base: BASE, fetch: reloaded.fetch, storage }), 1);
  assert.deepEqual(reloaded.calls, [{ url: `${BASE}_api/sessions/${ID}`, method: 'DELETE', keepalive: false }]);
  assert.equal(storage.getItem(heldSessionsKey(BASE)), null);
  assert.equal(await endHeldSessions({ base: BASE, fetch: reloaded.fetch, storage }), 0, 'nothing is left to reclaim');
  assert.equal(reloaded.calls.length, 1);
});

test('a session the host already ended (404) is reclaimed without an error', async () => {
  const storage = memory();
  await openSession({ base: BASE, fetch: host().fetch, storage });
  const gone = host({ deleted: 404 });
  await assert.doesNotReject(endHeldSessions({ base: BASE, fetch: gone.fetch, storage }));
  assert.equal(storage.getItem(heldSessionsKey(BASE)), null);
});

test('a failed reclaim never throws, and pagehide ends every held session with keepalive', async () => {
  const storage = memory();
  const api = host({ ids: [ID, OTHER] });
  await openSession({ base: BASE, fetch: api.fetch, storage });
  await openSession({ base: BASE, fetch: api.fetch, storage });
  assert.deepEqual(JSON.parse(storage.getItem(heldSessionsKey(BASE))), [ID, OTHER]);
  const closing = [];
  const fetch = async (url, init) => { closing.push({ url, keepalive: init.keepalive }); throw new TypeError('the page is going away'); };
  assert.equal(await endHeldSessions({ base: BASE, fetch, storage, keepalive: true }), 2);
  assert.deepEqual(closing.map(call => call.keepalive), [true, true]);
  assert.deepEqual(closing.map(call => call.url.split('/').pop()).sort(), [ID, OTHER]);
});

test('the remembered id is per mount: another API in the same tab keeps its own', async () => {
  const storage = memory();
  const other = 'https://api.test/other/';
  await openSession({ base: BASE, fetch: host({ ids: [ID] }).fetch, storage });
  await openSession({ base: other, fetch: host({ ids: [OTHER] }).fetch, storage });
  assert.notEqual(heldSessionsKey(BASE), heldSessionsKey(other));
  const api = host();
  await endHeldSessions({ base: BASE, fetch: api.fetch, storage });
  assert.deepEqual(api.calls.map(call => call.url), [`${BASE}_api/sessions/${ID}`]);
  assert.deepEqual(JSON.parse(storage.getItem(heldSessionsKey(other))), [OTHER], 'the other mount’s session is untouched');
});

test('missing, unreadable or full storage is tolerated', async () => {
  const session = await openSession({ base: BASE, fetch: host().fetch, storage: undefined });
  await session.end();
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
  await assert.doesNotReject(async () => (await openSession({ base: BASE, fetch: host().fetch, storage: broken })).end());
  assert.equal(await endHeldSessions({ base: BASE, fetch: host().fetch, storage: broken }), 0);
  const garbled = memory();
  garbled.setItem(heldSessionsKey(BASE), '{not json');
  assert.equal(await endHeldSessions({ base: BASE, fetch: host().fetch, storage: garbled }), 0);
  garbled.setItem(heldSessionsKey(BASE), JSON.stringify(['../../admin', ID]));
  const api = host();
  assert.equal(await endHeldSessions({ base: BASE, fetch: api.fetch, storage: garbled }), 1, 'only well-formed ids are sent');
});

test('a store_busy refusal carries its title, detail and the holder’s idle timeout, and is not a gone session', async () => {
  const body = { title: 'Another Preview session is holding store.db.', detail: 'That session ends by itself after its idle timeout (300 seconds), or when it is ended.', code: 'store_busy', idleTimeoutSeconds: 300 };
  const refused = host({ open: { status: 409, ok: false, json: async () => body } });
  const storage = memory();
  await assert.rejects(openSession({ base: BASE, fetch: refused.fetch, storage }), error => {
    assert.ok(error instanceof SessionError);
    assert.deepEqual({ status: error.status, code: error.code, title: error.title, detail: error.detail, idleSeconds: error.idleSeconds },
      { status: 409, code: 'store_busy', title: body.title, detail: body.detail, idleSeconds: 300 });
    assert.equal(storeBusy(error), true);
    assert.equal(sessionGone(error), false);
    return true;
  });
  assert.equal(storage.getItem(heldSessionsKey(BASE)), null, 'a refused open remembers nothing');
});

test('while a session opens, the run buttons show a spinner, are busy and cannot be clicked twice', () => {
  const journey = { id: 'j', name: 'J', sendOnly: false, steps: [{ stepId: 'a', op: { method: 'POST', path: '/a' } }, { stepId: 'b', op: { method: 'POST', path: '/b' } }] };
  const run = { status: 'running', mode: 'preview', steps: [{ stepId: 'a', status: 'pending' }, { stepId: 'b', status: 'pending' }] };
  const finished = { status: 'passed', mode: 'preview', steps: [{ stepId: 'a', status: 'passed' }, { stepId: 'b', status: 'passed' }] };
  const preview = html => /<button[^>]*data-action="journey-preview-run"[^>]*>[^]*?<\/button>/.exec(html)[0];
  const idle = overviewBar(journey);
  assert.doesNotMatch(preview(idle), /disabled|aria-busy|spinner/);
  assert.match(idle, /Preview rolls back/);
  for (const html of [overviewBar(journey, { opening: true }), summaryBar(journey, finished, { opening: true })]) {
    assert.match(preview(html), /aria-busy="true"/);
    assert.match(preview(html), /disabled/);
    assert.match(preview(html), /<span class="spinner"/);
    assert.doesNotMatch(preview(html), /<svg/, 'the spinner takes the glyph’s place');
    assert.match(html, /Opening the Preview session…/);
    assert.doesNotMatch(html, /data-action="journey-send-run"[^>]*>(?![^]*disabled)/, 'Send run waits too');
  }
  const step = stepBar(journey, run, 0, { opening: true });
  for (const action of ['preview', 'journey-run-to-end']) {
    const button = new RegExp(`<button[^>]*data-action="${action}"[^>]*>[^]*?</button>`).exec(step)[0];
    assert.match(button, /aria-busy="true"/);
    assert.match(button, /disabled/);
    assert.match(button, /<span class="spinner"/);
  }
  assert.match(step, /Opening the Preview session…/);
  assert.doesNotMatch(stepBar(journey, run, 0), /aria-busy|Opening the Preview session/);
});

/** A document with just what openDialog touches, as dialog.test.mjs does. */
function fakeDom() {
  const events = {};
  const host = {
    attributes: {}, innerHTML: '', className: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { (events[type] ??= []).push(listener); },
    querySelector: () => ({ focus() {} }),
    querySelectorAll: () => [],
    showModal() {}, close() {}, remove() {},
  };
  const doc = { activeElement: null, createElement: () => host, body: { append() {} } };
  const click = index => {
    const event = { target: { closest: selector => selector === '[data-dialog-action]' ? { dataset: { dialogAction: String(index) } } : null } };
    for (const listener of events.click ?? []) listener(event);
  };
  return { doc, host, click };
}

async function openFailedDialog(error, capabilities) {
  const dom = fakeDom();
  const saved = globalThis.document;
  globalThis.document = dom.doc;
  const answer = confirmSessionOpenFailed({ error, capabilities });
  globalThis.document = saved;
  return { ...dom, answer };
}

const capabilities = { database: { name: 'store.db', system: 'sqlite' } };

test('a store_busy refusal opens the busy dialog: title, plain words with the minutes, Close and Try again', async () => {
  const error = new SessionError('Another Preview session is holding store.db.', { status: 409, code: 'store_busy', idleSeconds: 300 });
  const dialog = await openFailedDialog(error, capabilities);
  assert.match(dialog.host.className, /dl-host/);
  assert.equal(dialog.host.attributes.role, 'alertdialog');
  assert.match(dialog.host.innerHTML, /dl-warn/, 'the tone is warn');
  assert.match(dialog.host.innerHTML, /<h2 id="dl-\d+-t">store\.db is held by another Preview<\/h2>/);
  assert.match(dialog.host.innerHTML, /Another Preview session, maybe in another tab or left behind by a tab that was closed, holds the database\. It ends by itself within 5 minutes\./);
  assert.match(dialog.host.innerHTML, /data-dialog-action="0"[^>]*>Close</);
  assert.match(dialog.host.innerHTML, /data-dialog-action="1"[^>]*>[^]*Try again</);
  assert.match(dialog.host.innerHTML, /Held by another Preview session/);
  dialog.click(1);
  assert.equal(await dialog.answer, true, 'Try again asks to open the session again');
});

test('the busy dialog still explains itself when the host gave no idle timeout, and Close declines', async () => {
  const dialog = await openFailedDialog(new SessionError('busy', { status: 409, code: 'store_busy' }), capabilities);
  assert.match(dialog.host.innerHTML, /It ends by itself after its idle timeout\./);
  dialog.click(0);
  assert.equal(await dialog.answer, false);
});

test('any other open failure shows the problem’s title and detail in a dialog, not a status line', async () => {
  const error = new SessionError('Too many preview sessions are open. End one first.', { status: 429, code: 'session_limit', title: 'Too many preview sessions are open. End one first.', detail: 'The caller has four.' });
  const dialog = await openFailedDialog(error, capabilities);
  assert.match(dialog.host.innerHTML, /The Preview session couldn’t open/);
  assert.match(dialog.host.innerHTML, /Too many preview sessions are open\. End one first\./);
  assert.match(dialog.host.innerHTML, /The caller has four\./);
  assert.doesNotMatch(dialog.host.innerHTML, /held by another Preview/);
  dialog.click(1);
  assert.equal(await dialog.answer, true);
  const network = await openFailedDialog(new TypeError('Failed to fetch'), capabilities);
  assert.match(network.host.innerHTML, /Failed to fetch/);
  network.click(0);
  assert.equal(await network.answer, false);
});

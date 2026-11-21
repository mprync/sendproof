import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindCapturePane, captureMarkup } from './result-capture.js';

test('typed effects show captured details and distinguish held, delivered and legacy records', () => {
  const effects = [
    { kind: 'email', description: 'Receipt', delivered: true, data: {
      from: 'ops@example.test', to: ['person@example.test'], cc: ['audit@example.test'],
      subject: '<receipt>', text: 'Hello <person>\n\nYour order.', html: '<p onclick="risky()">Hi</p>',
    } },
    { kind: 'http', description: 'Confirm order', delivered: true, data: {
      method: 'POST', url: 'https://example.test/confirm', status: 202, body: { submitted: true },
    } },
    { kind: 'job', description: 'Check stock', data: { name: 'CheckStock', queue: 'stock', runAt: '2026-11-23', arguments: { stock: 0 } } },
    { kind: 'message', description: 'Publish order', delivered: true, data: { topic: 'order.created', key: 'new', payload: '<details>' } },
    { kind: 'custom', description: 'Adapter effect', data: { legacy: 'visible' } },
    { kind: 'email', description: 'Legacy email effect', data: { to: ['captured@example.test'], template: 'legacy-template' } },
  ];
  const preview = captureMarkup('Side effects', { preview: true, effects, effectsTruncated: true });
  assert.match(preview, /Held.*Intercepted · not sent.*Discarded on rollback/s);
  assert.match(preview, /Cc<\/dt><dd>audit@example.test/);
  assert.match(preview, /Hello &lt;person&gt;<\/p><p>Your order/);
  assert.match(preview, /&lt;p onclick=&quot;risky\(\)&quot;&gt;Hi&lt;\/p&gt;/);
  assert.doesNotMatch(preview, /<iframe|<p onclick=|tag-ok/);
  assert.match(preview, /capture limit was reached/);
  const send = captureMarkup('Side effects', { effects });
  assert.match(send, /6 side effects captured.*3 side effects ran/);
  assert.match(send, /tag-ok">Delivered/);
  assert.match(send, /Sent · 202/);
  assert.match(send, /Published/);
  assert.match(send, /queue stock.*Run at<\/dt><dd>2026-11-23.*&quot;stock&quot;: 0/s);
  assert.match(send, /Payload.*&lt;details&gt;/s);
  assert.match(send, /legacy.*visible.*legacy-template/s);
});

const capturedLogs = [
  { level: 'Warning', message: 'Failed <lookup> for [42]', category: 'App.Read', offsetMs: 3,
    properties: { 'key"<': '[42]' }, exception: { type: 'TypeError', message: '<invalid>' } },
  { level: 'Sql', message: 'Read rows', offsetMs: 4, elapsedMs: 6.2,
    category: 'Microsoft.EntityFrameworkCore.Database.Command', eventId: { id: 20101, name: 'CommandExecuted' },
    sql: { text: 'SELECT *\nFROM widget WHERE id = @p0', rowsAffected: 0,
      parameters: [{ name: '@p0', value: '[REDACTED]', dbType: 'String' }, { name: '@p1', value: null, dbType: 'Int32' }] } },
  { level: 'Information', message: 'Legacy message' },
];

test('log rows preserve the captured structure, fallbacks and display of zero values', () => {
  const markup = captureMarkup('Logs', { logs: capturedLogs, logsTruncated: true, traceId: '<trace>' });
  assert.match(markup, /All <span class="faint">3<\/span>/);
  assert.match(markup, /Warning <span class="faint">1<\/span>/);
  assert.match(markup, /Failed &lt;lookup&gt; for <span class="prop" title="key&quot;&lt;">\[42\]<\/span>/);
  assert.match(markup, /SELECT \* FROM widget/);
  assert.match(markup, /<span class="tok-k">SELECT<\/span> \*\n<span class="tok-k">FROM<\/span>/);
  assert.match(markup, /Rows affected<\/dt><dd>0/);
  assert.match(markup, /Elapsed<\/dt><dd>6.2 ms/);
  assert.match(markup, /\[REDACTED\].*· String.*null.*· Int32/s);
  assert.match(markup, /20101 CommandExecuted/);
  assert.match(markup, /TypeError<\/strong> &lt;invalid&gt;/);
  assert.match(markup, /Legacy message/);
  assert.match(markup, /&lt;trace&gt;/);
  assert.match(markup, /capture limit was reached/);
});

class Control extends EventTarget {
  attributes = new Map();
  dataset = {};
  hidden = false;
  value = '';
  classList = { toggle() {} };
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  querySelectorAll() { return []; }
  trigger(type, fields) {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    this.dispatchEvent(event);
    return event;
  }
}

test('log controls filter by level, properties and SQL and move between visible rows', () => {
  const rows = capturedLogs.map(() => {
    const disclosure = new Control();
    return Object.assign(new Control(), {
      nextElementSibling: Object.assign(new Control(), { hidden: true }),
      querySelector: () => disclosure,
    });
  });
  const levelButtons = ['all', 'warning', 'info'].map(logLevel => Object.assign(new Control(), { dataset: { logLevel } }));
  const sql = new Control();
  const search = new Control();
  const empty = new Control();
  const nodes = {
    '[data-log-row]': rows, '[data-log-level]': levelButtons, '[data-log-sql]': sql,
    '[data-log-search]': search, '[data-log-no-match]': empty, '[data-log-copy-all]': new Control(),
  };
  bindCapturePane({
    querySelectorAll: selector => nodes[selector],
    querySelector: selector => nodes[selector],
  }, 'Logs', { logs: capturedLogs }, {});
  rows[0].trigger('keydown', { key: 'ArrowDown' });
  assert.equal(rows[1].focused, true);
  assert.equal(rows[1].tabIndex, 0);
  rows[1].trigger('keydown', { key: 'Enter' });
  assert.equal(rows[1].querySelector('[data-log-toggle]').getAttribute('aria-expanded'), 'true');
  levelButtons[1].trigger('click');
  assert.deepEqual(rows.map(row => row.hidden), [false, true, true]);
  assert.equal(rows[1].nextElementSibling.hidden, true);
  sql.trigger('click');
  assert.deepEqual(rows.map(row => row.hidden), [false, false, true]);
  assert.equal(rows[1].nextElementSibling.hidden, false);
  search.value = 'key"<';
  search.trigger('input');
  assert.deepEqual(rows.map(row => row.hidden), [false, true, true]);
  search.value = 'no match';
  search.trigger('input');
  assert.equal(empty.hidden, false);
});

test('headers resolve a captured Location, compare request IDs and retain each cookie', () => {
  const requestUrl = 'https://example.test/host/widgets';
  const headers = new Headers({
    'Location': 'widgets/7?x=1&y=2',
    'X-Request-ID': 'confirmed',
    'Idempotency-Replayed': 'false',
    'Content-Type': 'application/json; profile="<profile>"',
  });
  headers.append('Set-Cookie', 'a=42; Expires=Wed, 21 Oct 2030 07:28:00 GMT');
  headers.append('Set-Cookie', 'b=17; Secure');
  const markup = captureMarkup('Headers', {
    requestUrl, headers, requestHeaders: { 'x-request-id': 'confirmed', 'x-idempotency-key': 'resolved-key', Cookie: 'sent=21' },
  }, { basePath: '/host/' });
  assert.match(markup, /href="https:\/\/example.test\/host\/widgets\/7\?x=1&amp;y=2"/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(markup, /matches request/);
  assert.match(markup, /first use of this key/);
  assert.match(markup, /profile=&quot;&lt;profile&gt;&quot;/);
  assert.match(markup, /Request headers as sent.*resolved-key/s);
  assert.match(markup, /Cookies.*a=42; Expires=Wed, 21 Oct 2030 07:28:00 GMT.*b=17; Secure.*sent=21/s);
});

test('missing capture data and untrusted or mismatched header values fall back to safe text', () => {
  for (const location of [' javascript:alert(1)', 'data:text/html,<p>Hi</p>', 'https://[invalid']) {
    const markup = captureMarkup('Headers', {
      requestUrl: 'https://example.test/', headers: { location, 'x-request-id': 'one' }, requestHeaders: { 'X-REQUEST-ID': 'two' },
    });
    assert.doesNotMatch(markup, /data-location-open|matches request/);
    assert.doesNotMatch(markup, />Cookies</);
  }
  assert.match(captureMarkup('Headers', {}, {}), /No response headers were captured/);
  assert.match(captureMarkup('Side effects', {}), /No side effects were captured/);
  assert.match(captureMarkup('Logs', {}), /No logs were captured/);
});

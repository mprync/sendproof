import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations } from './api.js';
import { responseDefinition, responseFollowUps, responseTimings } from './response-metadata.js';
import { bindResponseViewer, matchButton, matchTip, responseMarkup, treePath } from './response-viewer.js';

function payments() {
  const path = name => ({ in: 'path', name, required: true });
  const query = name => ({ in: 'query', name });
  const document = {
    openapi: '3.1.0',
    paths: {
      '/accounts/{accountId}/payments': {
        parameters: [path('accountId')],
        post: { responses: { 201: { $ref: '#/components/responses/PaymentCreated' } } },
      },
      '/accounts/{accountId}/payments/{paymentId}': {
        parameters: [path('accountId'), path('paymentId')],
        get: { operationId: 'getPayment', summary: 'Get payment', parameters: [query('include'), query('trace')] },
        delete: { operationId: 'cancelPayment', summary: 'Cancel payment' },
      },
      '/accounts/{accountId}/payments/{paymentId}/approve': {
        patch: {
          summary: 'Approve payment', parameters: [path('accountId'), path('paymentId')],
          security: [{ bearer: ['payments.approve'] }],
        },
      },
      '/tags/{tagId}': {
        get: { summary: 'Get tag', parameters: [path('tagId')] },
      },
    },
    components: {
      links: {
        Read: {
          operationId: 'getPayment',
          parameters: {
            'path.accountId': '$request.path.accountId',
            'path.paymentId': '$response.body#/id',
            include: 'account-{$response.body#/a~1b~0c}',
            'query:trace': '$response.header.X-Trace',
          },
        },
      },
      responses: {
        PaymentCreated: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentResponse' } } },
          links: { Read: { $ref: '#/components/links/Read' } },
        },
      },
      schemas: {
        PaymentResponse: {
          type: 'object',
          required: ['id', 'internal'],
          properties: { id: { type: 'string', readOnly: true }, internal: { type: 'string', writeOnly: true } },
        },
      },
    },
  };
  const available = operations(document);
  const result = {
    status: 201, body: { id: 'payment/1', 'a/b~c': 'debit' },
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-trace': 'trace-1' },
    requestUrl: 'https://example.test/team/accounts/a%2Fb/payments',
  };
  const context = { document, operation: available[0], operations: available, basePath: '/team/', onFollowUp() {} };
  return { context, result };
}

test('server timing keeps quoted descriptions and duplicate metric instances', () => {
  const metrics = responseTimings({
    serverTiming: 'auth;dur=4, handler;dur="21.5", db;dur=52;desc="4 queries, cache \\"miss\\"; retry", db;dur=0, broken;dur=soon',
    timing: { handler: 99 },
  });
  assert.deepEqual(metrics.map(({ label, duration, description }) => [label, duration, description]), [
    ['Auth', 4, undefined], ['Handler', 21.5, undefined],
    ['Database', 52, '4 queries, cache "miss"; retry'], ['Database', 0, undefined],
  ]);
  assert.deepEqual(responseTimings({ headers: new Headers({ 'Server-Timing': 'serialize;dur=7' }) })
    .map(({ label, duration }) => [label, duration]), [['Serialise', 7]]);
  assert.deepEqual(responseTimings({ serverTiming: 'broken;dur=-1', timing: { auth: 0, db: 1, queryCount: 1 } })
    .map(({ label, duration, description }) => [label, duration, description]), [
    ['Auth', 0, undefined], ['Database', 1, '1 query'],
  ]);
  assert.deepEqual(responseTimings({ timing: { handler: -2 } }), []);
});

test('documented links enhance related path follow-ups without linking unrelated operations', () => {
  const { context, result } = payments();
  const definition = responseDefinition(result, context);
  const followUps = responseFollowUps(result, context, definition, result.body);
  assert.deepEqual(followUps.map(({ operation, values, paths }) => [operation.title, values, paths]), [
    ['Get payment', { 'path:accountId': 'a/b', 'path:paymentId': 'payment/1', 'query:include': 'account-debit', 'query:trace': 'trace-1' }, [['id'], ['a/b~c']]],
    ['Cancel payment', { 'path:accountId': 'a/b', 'path:paymentId': 'payment/1' }, [['id']]],
    ['Approve payment', { 'path:accountId': 'a/b', 'path:paymentId': 'payment/1' }, [['id']]],
  ]);
  assert.doesNotMatch(responseMarkup(result, context), /Get tag/);
});

test('local operation references and same-application Location fill parameters without guessing external destinations', () => {
  const { context, result } = payments();
  const definition = responseDefinition(result, context);
  const link = context.document.components.links.Read;
  delete link.operationId;
  link.operationRef = '#/paths/~1accounts~1%7BaccountId%7D~1payments~1%7BpaymentId%7D/get';
  assert.equal(responseFollowUps(result, context, definition, result.body)[0].name, 'Read');

  result.headers.Location = '/team/accounts/a%2Fb/payments/p%2F2?include=account&include=history';
  assert.deepEqual(responseFollowUps(result, context, {}, undefined).map(item => item.values), [
    { 'path:accountId': 'a/b', 'path:paymentId': 'p/2', 'query:include': ['account', 'history'] },
    { 'path:accountId': 'a/b', 'path:paymentId': 'p/2' },
  ]);
  result.headers.Location = 'https://other.test/team/accounts/a%2Fb/payments/p%2F2';
  assert.deepEqual(responseFollowUps(result, context, {}, undefined), []);
  result.status = 422;
  assert.deepEqual(responseFollowUps(result, context, {}, result.body), []);
});

test('response validation respects the documented status, media type, and response-only shape', () => {
  const { context, result } = payments();
  context.operation.operation.responses['2XX'] = context.operation.operation.responses[201];
  result.status = 202;
  result.body = { id: 'payment/1' };
  // The match is a quiet detail in the status line, not a pill in the toolbar.
  assert.match(matchButton(result, context), /class="match" id="match-btn"[^>]*>.*Matches schema/);
  assert.doesNotMatch(responseMarkup(result, context), /pill-ok|pill-warn/);
  assert.match(matchTip(result, context), /Matches the documented schema/);
  result.body = {};
  assert.match(matchButton(result, context), /class="match is-fail"[^>]*>.*1 schema issue/);
  assert.match(matchTip(result, context), /<code>id<\/code>/);
  result.body = { id: 'p1', legacyCode: 'X' };
  assert.match(matchButton(result, context), /1 schema issue/, 'an undocumented property is an issue');
  assert.match(matchTip(result, context), /<code>legacyCode<\/code><span>Not in the PaymentResponse schema/);
  result.headers['Content-Type'] = 'application/problem+json';
  assert.equal(matchButton(result, context), '');
  result.headers['Content-Type'] = 'application/json';
  context.document.components.schemas.PaymentResponse.properties.id = { $ref: './other.json#/Id' };
  result.body = { id: 'p1' };
  assert.equal(matchButton(result, context), '');
});

test('viewer renders syntax, folding, schema, registered controls and truthful body modes', () => {
  const { context, result } = payments();
  result.raw = '{"id":"payment/1","amount":50000.00,"debitAccount":{"name":"Operating EUR","secret":"<img>"},"approval":{"required":true}}';
  result.serverTiming = 'auth;dur=4, handler;dur=21, db;dur=52;desc="4 queries", serialize;dur=7';
  const markup = responseMarkup(result, context);
  assert.match(markup, /84 milliseconds in total/);
  assert.match(markup, /Database 52 ms · 4 queries/);
  assert.match(markup, /class="tok-n">50000\.00</);
  // Every object opens by default; nothing is folded unless the body is large.
  assert.doesNotMatch(markup, /class="folded"/);
  assert.match(markup, /aria-label="Collapse debitAccount" aria-expanded="true"/);
  assert.match(markup, /aria-label="Collapse approval" aria-expanded="true"/);
  assert.match(markup, /Collapse all/);
  assert.match(markup, /class="viewer-bar vb"/, 'one toolbar line');
  assert.match(markup, /data-wrap aria-pressed="false" hidden/, 'Wrap belongs to Raw');
  assert.match(markup, /class="no" data-n="2" aria-hidden="true"></);
  assert.match(markup, /Open in Get payment/);
  assert.match(markup, /data-action="find-response" aria-keyshortcuts=/);
  assert.match(markup, /data-action="copy-response" aria-keyshortcuts=/);
  assert.match(markup, /data-response-mode="table"/);
  assert.doesNotMatch(markup, /<img>/);

  const text = responseMarkup({ status: 200, raw: '<img>', headers: { 'Content-Type': 'text/plain' } });
  assert.match(text, /&lt;img&gt;/);
  assert.match(text, /data-response-mode="raw" aria-pressed="true"/);
  assert.doesNotMatch(text, /data-response-mode="(pretty|table)"/);
  assert.doesNotMatch(responseMarkup({ status: 200, body: result.body, raw: result.raw, headers: { 'Content-Type': 'text/plain' } }), /data-response-mode="pretty"/);
  assert.doesNotMatch(responseMarkup({ status: 200, raw: '[1,2]' }), /data-response-mode="table"/);
  assert.match(responseMarkup({ status: 200, raw: 'null' }), /class="tok-b">null</);
  assert.match(responseMarkup({ status: 204, body: null, raw: '' }), /No response body/);
});

test('viewer delegates follow-up values and finds matches in the open body', () => {
  const { context, result } = payments();
  result.body.debitAccount = { name: 'Operating EUR', label: 'needle Found' };
  let followUp;
  context.onFollowUp = (...args) => { followUp = args; };
  const node = (extra = {}) => Object.assign(new EventTarget(), { setAttribute() {} }, extra);
  const input = node({ value: '', focus() {}, select() {} });
  const count = {};
  const search = node({
    hidden: true,
    querySelector: selector => selector === 'input' ? input : count,
    querySelectorAll: () => [],
  });
  const content = node({ querySelector: () => undefined, querySelectorAll: () => [] });
  const elements = new Map([
    ['[data-response-content]', content], ['.response-find', search],
    ['[data-action="find-response"]', node({ focus() {} })], ['[data-fold-all]', node({ querySelector: () => ({}) })],
  ]);
  const root = node({ matches: () => true, contains: () => true, querySelector: selector => elements.get(selector), querySelectorAll: () => [] });
  const press = dataset => {
    const click = new Event('click');
    Object.defineProperty(click, 'target', { value: { closest: () => ({ dataset }) } });
    root.dispatchEvent(click);
  };

  bindResponseViewer(root, result, context);
  press({ followUp: '0' });
  assert.equal(followUp[0].operation.operationId, 'getPayment');
  assert.equal(followUp[1]['path:paymentId'], 'payment/1');

  press({ action: 'find-response' });
  assert.equal(search.hidden, false);
  input.value = 'NEEDLE';
  input.dispatchEvent(new Event('input'));
  assert.equal(count.textContent, '1 of 1');
  assert.match(content.innerHTML, /<mark class="is-current" data-current-match><span class="tok-s">needle</);
  assert.match(content.innerHTML, /aria-label="Collapse debitAccount"/);
  input.value = 'payment';
  input.dispatchEvent(new Event('input'));
  press({ responseMode: 'table' });
  assert.match(content.innerHTML, /<table>/);
  assert.match(content.innerHTML, /<mark class="is-current" data-current-match>payment<\/mark>/);
  assert.match(content.innerHTML, /class="obj" data-table-open="\[&quot;debitAccount&quot;\]">2 keys</, 'nested values are buttons, not text');
  press({ closeResponseFind: '' });
  assert.equal(search.hidden, true);
  assert.doesNotMatch(content.innerHTML, /<mark/);
});

test('the Table view is a real table: label column first, numbers aligned, page facts in the footer', () => {
  const body = { items: [{ id: 'a', balance: 12.5, name: 'Operating EUR', closedOn: null, bank: { bic: 'X' } }, { id: 'b', balance: 3, name: 'Payroll', closedOn: null, bank: { bic: 'Y' } }], page: 1, totalPages: 1, totalItems: 2 };
  const result = { status: 200, raw: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
  const markup = responseMarkup(result, {});
  assert.match(markup, /data-response-mode="table"/);
  const node = (extra = {}) => Object.assign(new EventTarget(), { setAttribute() {}, hidden: false }, extra);
  const content = node({ querySelector: () => undefined, querySelectorAll: () => [], dataset: {} });
  const elements = new Map([['[data-response-content]', content], ['.response-find', node({ querySelector: () => node({ value: '' }), querySelectorAll: () => [] })],
    ['[data-action="find-response"]', node()], ['[data-fold-all]', node({ querySelector: () => ({}) })]]);
  const root = node({ matches: () => true, contains: () => true, querySelector: selector => elements.get(selector), querySelectorAll: () => [] });
  bindResponseViewer(root, result, {});
  const click = new Event('click');
  Object.defineProperty(click, 'target', { value: { closest: () => ({ dataset: { responseMode: 'table' } }) } });
  globalThis.ResizeObserver ??= class { observe() {} };
  root.dispatchEvent(click);
  const html = content.innerHTML;
  assert.match(html, /<th scope="col" class="lead">name<\/th>/, 'the record’s name leads and stays in view');
  assert.match(html, /<th scope="col" class="num">balance<\/th>/);
  assert.match(html, /<td class="num">12\.5<\/td>/);
  assert.match(html, /<span class="null">null<\/span>/);
  assert.match(html, /2 rows of <code>items<\/code> · Page 1 of 1 · 2 in all/);
  assert.match(html, /data-table-more/);
});

test('validator paths map to the attribute list’s paths', () => {
  assert.equal(treePath('items.0.name'), 'items[].name');
  assert.equal(treePath('entityCountry'), 'entityCountry');
  assert.equal(treePath(''), '');
});

test('Pretty marks each line that breaks the schema with a quiet reason', () => {
  const document = { openapi: '3.1.0', paths: {}, components: { schemas: { Account: { type: 'object', required: ['id', 'bic'], properties: { id: { type: 'string' }, bic: { type: 'string' }, country: { type: 'string', minLength: 2, maxLength: 2 } } } } } };
  const operation = { method: 'GET', path: '/a', parameters: [], operation: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } } } } };
  const result = { status: 200, raw: '{"id":"a","country":"NLD","legacy":1}', headers: { 'Content-Type': 'application/json' } };
  const markup = responseMarkup(result, { document, operation });
  assert.match(markup, /class="ln is-issue"[^]*?&quot;country&quot;[^]*?class="ln-note"/, 'the too-long value is marked on its line');
  assert.match(markup, /class="ln is-issue"[^]*?&quot;legacy&quot;/, 'an undocumented property is marked');
  assert.match(matchTip(result, { document, operation }), /<code>bic<\/code><span>Required, but not in the body/, 'a missing property says so');
  assert.match(matchButton(result, { document, operation }), /3 schema issues/, 'missing bic, the length and the extra property');
});

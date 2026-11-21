import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResults } from './results.js';
import { loadingBody, networkError, networkHeader, requestError, resultCounts } from './result-states.js';
import { responseMarkup } from './response-viewer.js';

test('network recovery is distinct from a rejected Preview acknowledgement', () => {
  const failure = { network: true, preview: true, seconds: 1.2, host: 'localhost', origin: 'http://localhost' };
  assert.match(networkHeader(failure), /No response/);
  assert.match(networkError(failure), /data-action="retry-request"/);
  assert.match(networkError(failure), /data-action="copy-failed-curl"/);
  const rejected = requestError({ error: 'Preview rollback could not be confirmed' });
  assert.match(rejected, /could not be confirmed/);
  assert.doesNotMatch(rejected, /retry-request/);
  assert.equal(loadingBody('Database', true).match(/class="table-change"/g).length, 2);
});

test('all five result tabs always have a count or a not-yet-known marker', () => {
  assert.deepEqual(resultCounts(null), [undefined, '–', '–', '–', '–']);
  assert.deepEqual(resultCounts({ preview: true, status: 201, changes: [1], effects: [], logs: [1, 2], headers: { a: '1' } }), [undefined, 1, 0, 2, 1]);
  assert.deepEqual(resultCounts({ preview: false, status: 201, headers: { a: '1' } }), [undefined, '–', '–', '–', 1]);
  assert.deepEqual(resultCounts({ preview: false, status: 401, headers: {} }), [undefined, 0, 0, '–', 0]);
});

test('validation response highlights the returned JSON and escapes field names and values', () => {
  const body = { errors: { '<amount>': ['Value must be <100'] }, status: 400 };
  const markup = responseMarkup({ body, status: 400, headers: { 'content-type': 'application/problem+json' } });
  assert.match(markup, /Validation problem/);
  assert.match(markup, /class="tok-k"/);
  assert.match(markup, /class="tok-n">400/);
  assert.match(markup, /&lt;amount&gt;/);
  assert.doesNotMatch(markup, /<amount>|<100/);
});

test('mutating sends require in-place confirmation and cancellation sends nothing', async () => {
  const bar = {
    innerHTML: '<button data-action="send">Send</button>',
    querySelector: () => ({ focus() {} }),
  };
  const workspace = { dataset: {} };
  globalThis.document = { querySelectorAll: () => [] };
  const state = {
    cap: { previewOperations: [] },
    op: { method: 'POST', path: '/widgets', operation: {}, parameters: [] },
    documentUrl: '/openapi.json',
  };
  const results = createResults({
    state, basePath: '/',
    $: selector => selector === '.actionbar' ? bar : selector === '.workspace' ? workspace : null,
    readRequest: () => ({ method: 'POST', url: 'https://example.test/widgets', headers: new Headers() }),
    sensitiveNames: () => [], renderOperation() {},
  });
  await results.run(false);
  assert.match(bar.innerHTML, /data-action="confirm-send"/);
  assert.match(bar.innerHTML, /Confirm send/);
  results.cancelConfirmation();
  assert.doesNotMatch(bar.innerHTML, /confirm-send/);
  await results.run(false, true); // A cancelled confirmation cannot execute.
  assert.doesNotMatch(bar.innerHTML, /confirm-send/);
});

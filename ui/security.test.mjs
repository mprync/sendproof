import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublic, scopeText } from './security.js';
import { operationNotice } from './operation-header.js';
import { configure } from './i18n.js';

const document = { components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'session' } } } };
const op = security => ({ method: 'POST', path: '/x', title: 'X', group: 'G', parameters: [], operation: { security } });

test('security requirements say who may call an operation', () => {
  configure({ language: 'en-IE' });
  assert.equal(isPublic(op(undefined), document), true);
  assert.equal(isPublic(op([{}]), document), true, 'an empty requirement makes sign-in optional');
  assert.equal(isPublic(op([{ cookieAuth: [] }]), document), false);
  assert.equal(scopeText(op([{ cookieAuth: ['admin'] }, { cookieAuth: ['payments.approve'] }]), document), 'admin or payments.approve');
});

test('deprecation and missing sign-in are explained above the URL bar', () => {
  const deprecated = { ...op([{ cookieAuth: [] }]), operation: { deprecated: true, 'x-deprecation': 'Use Approve payment.' } };
  const notice = operationNotice(deprecated, document, false, true);
  assert.match(notice, /<strong id="dep-h-try">Deprecated<\/strong>/);
  assert.match(notice, /<p class="dep-lede" lang="en">Use Approve payment\.<\/p>/, 'the spec’s own message leads the notice');
  assert.match(notice, /No sunset date in the spec/);
  assert.match(operationNotice(op([{ cookieAuth: [] }]), document, false, true), /Needs sign-in/);
  assert.equal(operationNotice(op([{ cookieAuth: [] }]), document, true, true), '');
});

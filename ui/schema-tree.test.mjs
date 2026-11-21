import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTreeState, parameterTree, propertyTree } from './schema-tree.js';
import { discriminatorOf, findSample, modelExample, modelGroups, modelKind, propertiesOf, usedBy } from './schema-model.js';

const operation = (path, method, extra) => ({ method, path, title: path, group: 'G', parameters: [], operation: { operationId: method + path, responses: {}, ...extra } });
const json = schema => ({ content: { 'application/json': { schema } } });
const document = {
  components: { schemas: {
    Money: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', format: 'decimal', minimum: 0, maximum: 1e30, multipleOf: 0.01, description: 'The amount.' }, currency: { type: 'string', minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$' } } },
    Approval: { type: 'object', properties: { by: { type: 'string', readOnly: true, nullable: true } } },
    Payment: { type: 'object', required: ['id', 'amount'], properties: {
      id: { type: 'string', format: 'uuid', description: 'Unique id.', example: 'abc' },
      amount: { $ref: '#/components/schemas/Money' },
      status: { $ref: '#/components/schemas/Status' },
      approval: { $ref: '#/components/schemas/Approval' },
      parent: { $ref: '#/components/schemas/Payment' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 5, uniqueItems: true },
      lines: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' } } } },
      bank: { $ref: '#/components/schemas/Bank' },
    } },
    Status: { type: 'string', enum: ['Draft', 'Paid'] },
    Bank: { oneOf: [{ $ref: '#/components/schemas/Iban' }, { $ref: '#/components/schemas/Ach' }], discriminator: { propertyName: 'scheme', mapping: { iban: '#/components/schemas/Iban', ach: '#/components/schemas/Ach' } } },
    Iban: { type: 'object', required: ['scheme'], properties: { scheme: { type: 'string' }, iban: { type: 'string' } } },
    Ach: { type: 'object', properties: { scheme: { type: 'string' }, routing: { type: 'string' } } },
    PagedListOfPayment: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Payment' } } } },
    ProblemDetails: { type: 'object', properties: { title: { type: 'string' } } },
    CreateRequest: { type: 'object', properties: { amount: { $ref: '#/components/schemas/Money' } } },
  } },
};
const tree = (name, options) => propertyTree({ $ref: '#/components/schemas/' + name }, document, options);

test('every row says Required or Optional, and undocumented rows say so quietly', () => {
  const html = tree('Payment');
  const rows = html.match(/<li class="attr/g).length;
  assert.equal(html.match(/class="attr-req/g).length, rows, 'one Required or Optional on every row');
  assert.match(html, /<span class="attr-req is-req">Required<\/span>/);
  assert.match(html, /<span class="attr-req">Optional<\/span>/);
  assert.match(html, /No description in the spec/);
  assert.match(html, /Unique id\./);
  assert.match(html, /<code class="attr-name">id<\/code><span class="attr-type t-string">string<\/span>/, 'the type carries its family tint');
  assert.match(html, /<a class="attr-type is-ref" href="#model\/Money" data-model="Money"/, 'a model is a link');
});

test('child lists start open three levels deep, toggle per path and stop at cycles', () => {
  const html = tree('Payment');
  assert.match(html, /data-attr-toggle="amount" aria-expanded="true"/, 'a $ref child list starts open');
  assert.match(html, /data-path="amount\.currency"/);
  assert.match(html, /data-attr-toggle="lines" aria-expanded="true"/);
  assert.match(html, /data-path="lines\[\]\.sku"/, 'an array of objects lists its items’ attributes');
  assert.doesNotMatch(html, /data-attr-toggle="id"/, 'leaf rows have no toggle');
  assert.match(html, /<span class="attr-note">recursive<\/span>/, 'Payment inside Payment stops');
  assert.doesNotMatch(html, /data-path="parent\.id"/);
  const state = newTreeState();
  state.collapsed.add('amount');
  const closed = tree('Payment', { state });
  assert.match(closed, /data-attr-toggle="amount" aria-expanded="false"><svg[^>]*><use href="#i-plus"\/><\/svg><span>Show child attributes<\/span>/);
  assert.doesNotMatch(closed, /data-path="amount\.currency"/);
  state.mode = 'none';
  state.collapsed.clear();
  assert.doesNotMatch(tree('Payment', { state }), /aria-expanded="true"/, 'Collapse all closes every child list');
});

test('constraints read as quiet text and leave out platform limits', () => {
  const html = tree('Money');
  const facts = html.match(/<p class="attr-facts">(.*?)<\/p>/g).map(text => text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  assert.deepEqual(facts, ['Minimum 0 Step 0.01', 'Length 3 Pattern ^[A-Z]{3}$'], 'a 1e30 maximum is a platform limit, not a rule');
});

test('enums list their values, with descriptions when the spec has them, and a one-value enum is a constant', () => {
  const doc = { components: { schemas: {
    S: { type: 'object', properties: {
      status: { type: 'string', enum: ['Open', 'Closed'], 'x-enum-descriptions': { Open: 'Sends and receives.', Closed: 'Kept for history.' } },
      many: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      scheme: { type: 'string', enum: ['Iban'] },
    } },
  } } };
  const html = propertyTree({ $ref: '#/components/schemas/S' }, doc);
  assert.match(html, /Possible enum values/);
  assert.match(html, /<dt><code>Open<\/code><\/dt><dd lang="en">Sends and receives\.<\/dd>/);
  assert.match(html, /Show 3 more values/, 'past 6 values the rest hide behind a button');
  assert.match(html, /Always <code>Iban<\/code> in this variant/);
});

test('a union shows how the variant is chosen, a tab per variant and the chosen variant’s rows', () => {
  const html = tree('Bank');
  assert.match(html, /Chosen by <code>scheme<\/code>/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*data-variant="Iban"/);
  assert.match(html, /data-path="iban"/);
  assert.doesNotMatch(html, /data-path="routing"/);
});

test('parameters use the same rows, each with its location', () => {
  const html = parameterTree([
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: 'Page number.' },
    { name: 'status', in: 'query', required: true, schema: { $ref: '#/components/schemas/Status' } },
  ], document);
  assert.match(html, /<span class="attr-in in-query" lang="en" title="in: query">query<\/span>/);
  assert.match(html, /<span class="attr-req">Optional<\/span>/);
  assert.match(html, /<span class="attr-req is-req">Required<\/span>/);
  assert.match(html, /Page number\./);
  assert.match(html, /Default <code>1<\/code>/);
});

test('the response Schema view marks which paths came back and why a row fails', () => {
  const html = tree('PagedListOfPayment', { compact: true, present: new Set(['items', 'items[].id']), issues: { 'items[].id': 'Expected a UUID' }, extra: [{ name: 'legacy', value: 1, issue: 'Not in the schema' }] });
  assert.match(html, /data-path="items\[\]\.id"/);
  assert.match(html, /class="attr is-issue"[^>]*data-path="items\[\]\.id"/);
  assert.match(html, /Expected a UUID/);
  assert.match(html, /class="attr is-off"/);
  assert.match(html, /attr-mark is-on/);
  assert.match(html, /<code class="attr-name">legacy<\/code>.*Not in the schema/s);
  assert.doesNotMatch(html, /attr-desc/, 'compact rows keep only their head line');
});

test('model groups: resources, request bodies, list pages, enums and errors', () => {
  const groups = Object.fromEntries(modelGroups(document));
  assert.deepEqual(groups.lists, ['PagedListOfPayment']);
  assert.deepEqual(groups.enums, ['Status']);
  assert.deepEqual(groups.errors, ['ProblemDetails']);
  assert.deepEqual(groups.requests, ['CreateRequest']);
  assert.ok(groups.resources.includes('Payment') && groups.resources.includes('Bank'));
  assert.equal(modelKind(document.components.schemas.Bank, document).id, 'oneOf');
  assert.deepEqual(discriminatorOf(document.components.schemas.Bank, document).map, [['iban', 'Iban'], ['ach', 'Ach']]);
});

test('Used by lists direct users, or the operations of the models that contain it, with "via"', () => {
  const ops = [
    operation('/payments', 'post', { requestBody: json({ $ref: '#/components/schemas/CreateRequest' }), responses: { 201: json({ $ref: '#/components/schemas/Payment' }), 400: json({ $ref: '#/components/schemas/ProblemDetails' }) } }),
    operation('/payments/list', 'get', { responses: { 200: json({ $ref: '#/components/schemas/PagedListOfPayment' }) } }),
  ];
  const payment = usedBy('Payment', ops, document);
  assert.deepEqual(payment.operations.map(row => [row.op.path, row.request, row.codes]), [['/payments', false, ['201']]]);
  assert.ok(payment.models.includes('PagedListOfPayment'));
  const approval = usedBy('Approval', ops, document);
  assert.equal(approval.operations.length, 0);
  assert.deepEqual(approval.via.map(row => [row.op.path, row.model]), [['/payments', 'Payment'], ['/payments/list', 'PagedListOfPayment']]);
  const money = usedBy('Money', ops, document);
  assert.equal(money.operations.length, 0, 'a model only nested inside request and response bodies has no direct users');
  assert.ok(['Payment', 'CreateRequest'].includes(money.via.find(row => row.op.path === '/payments').model), 'a model the operation uses is named');
});

test('examples prefer a real captured response that fits, then the schema, then a generated one', () => {
  const real = { id: 'p1', amount: { amount: 5, currency: 'EUR' }, status: 'Draft' };
  assert.equal(findSample({ $ref: '#/components/schemas/Payment' }, document, [{ unrelated: 1 }, { items: [real] }]), real, 'found inside a list response');
  assert.equal(findSample({ $ref: '#/components/schemas/Payment' }, document, [{ id: 'p1', extra: true }]), undefined, 'keys the schema does not declare do not fit');
  assert.deepEqual(modelExample('Payment', document, [real]), { value: real, source: 'real' });
  assert.equal(modelExample('Payment', document, []).source, 'generated');
  assert.deepEqual(modelExample('Status', document), { value: 'Draft', source: 'generated' });
  const withExample = { components: { schemas: { A: { type: 'object', properties: { x: { type: 'string' } }, example: { x: 'spec' } } } } };
  assert.deepEqual(modelExample('A', withExample, []), { value: { x: 'spec' }, source: 'spec' });
  assert.deepEqual(Object.keys(propertiesOf('Payment', document).props).slice(0, 2), ['id', 'amount']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaForm, sampleValue, resolveSchema, validateSchemaValue } from './schema.js';
import { inferLookup } from './fields/infer.js';

// A small DOM stand-in exercises the renderer without requiring a browser process.
class Node {
  constructor(tag) {
    this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; this.style = {};
    this.classList = { add: name => { this.className = [this.className, name].filter(Boolean).join(' '); }, toggle() {}, remove() {} };
  }
  append(...nodes) { for (const node of nodes) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes.reverse()) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; this.children.unshift(node); } }
  get firstChild() { return this.children[0]; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll(selector) { return selector === '[data-schema-path]' ? this.walk().filter(node => node.dataset.schemaPath) : []; }
  querySelector() { return null; }
  walk() { return [this, ...this.children.flatMap(child => child.walk())]; }
}
globalThis.document = { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag) };

test('forms round-trip unrelated typed schemas and validate nested references', () => {
  const document = { components: { schemas: { Item: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } } } } } };
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/Item' } }, currency: { type: 'string', enum: ['EUR', 'USD'] } } };
  const events = []; const container = new Node('div');
  const form = createSchemaForm({ container, schema, document, value: { items: [{ count: 2, enabled: false }], currency: 'EUR' }, onChange: value => events.push(value) });
  assert.equal(form.validate().valid, true);
  const input = container.walk().find(node => node.inputMode === 'numeric');
  input.value = '3'; input.events.input();
  assert.deepEqual(form.getValue(), { items: [{ count: 3, enabled: false }], currency: 'EUR' });
  assert.deepEqual(events.at(-1), form.getValue());
  form.setValue({ items: [{ count: 0 }] });
  assert.ok(form.validate().errors.some(error => error.path === 'items.0.count'));
  form.setValue({ items: [{ count: 4 }], currency: 'USD' });
  assert.deepEqual(form.getValue(), { items: [{ count: 4 }], currency: 'USD' });
  assert.equal(typeof sampleValue(schema, document).items[0].count, 'number');
  assert.equal(resolveSchema({ $ref: '#/components/schemas/Item' }, document).type, 'object');
  form.destroy();
  const second = createSchemaForm({ container, schema: { type: 'array', items: { type: 'boolean' } }, value: [true, false] });
  assert.deepEqual(second.getValue(), [true, false]);
});

test('flattenRoot hides only the root object label and preserves nested validation', () => {
  const container = new Node('div');
  const schema = { type: 'object', required: ['child'], properties: {
    child: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
  } };
  const form = createSchemaForm({ container, schema, flattenRoot: true, value: { child: {} } });
  const labels = container.walk().filter(node => node.className === 'name').map(node => node.textContent);
  assert.ok(!labels.includes('Value'));
  assert.ok(labels.includes('Child'));
  assert.ok(labels.includes('Name'));
  assert.ok(form.validate().errors.some(error => error.path === 'child.name'));
  form.setValue({ child: { name: 'ok' } });
  assert.equal(form.validate().valid, true);
});

test('short enums are radio groups, the currency is a joined select, and both keep typed siblings', () => {
  const container = new Node('div');
  const schema = { type: 'object', required: ['amount', 'currency', 'priority'], properties: {
    amount: { type: 'number', 'x-currency-field': 'currency' },
    currency: { type: 'string', enum: ['EUR', 'USD', 'GBP', 'CHF', 'SEK'] },
    priority: { type: 'string', enum: ['Normal', 'Urgent'] }
  } };
  const form = createSchemaForm({ container, schema, value: { amount: 12, currency: 'EUR', priority: 'Normal' } });
  assert.ok(container.walk().some(node => node.role === 'radiogroup'), 'two short values are a radio group');
  const urgent = container.walk().find(node => node.role === 'radio' && node.dataset.value === 'Urgent');
  urgent.events.click();
  const currency = container.walk().find(node => node.role === 'combobox' && node['aria-label'] === 'Currency');
  assert.ok(currency.className.includes('sel-seg'), 'the currency is a segment of the amount');
  currency.choose('USD');
  assert.deepEqual(form.getValue(), { amount: 12, currency: 'USD', priority: 'Urgent' });
  assert.ok(!container.walk().some(node => node.tag === 'select'), 'no native select remains');
});

test('display hints group fields and expose optional inputs without making them required', () => {
  const container = new Node('div');
  const schema = { type: 'object', required: ['amount', 'date'], properties: {
    amount: { type: 'number', minimum: 0.01, 'x-testbench-row': 'details' },
    date: { type: 'string', format: 'date', 'x-testbench-row': 'details' },
    note: { type: 'string', 'x-testbench-visible': true },
    extra: { type: 'string' }
  } };
  const form = createSchemaForm({ container, schema, flattenRoot: true, value: { amount: 1, date: '2027-01-01' } });
  const nodes = container.walk();
  const row = nodes.filter(node => node.className?.split(' ').includes('half'));
  assert.deepEqual(row.map(node => JSON.parse(node.dataset.schemaPath)[0]), ['amount', 'date']);
  const note = nodes.find(node => node.dataset.schemaPath === '["note"]');
  const extra = nodes.find(node => node.dataset.schemaPath === '["extra"]');
  assert.equal(note.parent.className, 'fields');
  assert.equal(note.parent.hidden, undefined);
  assert.equal(extra, undefined);
  assert.ok(nodes.find(node => node.dataset.optionalPath === '["extra"]'));
  assert.equal(form.validate().valid, true);
  assert.equal(nodes.find(node => node.tag === 'input' && node.inputMode === 'decimal')['aria-required'], 'true');
  assert.equal(note.walk().find(node => node.tag === 'input')['aria-required'], undefined);
});

test('lookup inference requires one matching collection with no required parameters and respects overrides', () => {
  const collection = {
    get: { responses: { 200: { content: {
      'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Account' } } }
    } } } }
  };
  const doc = { paths: { '/accounts': collection }, components: { schemas: { Account: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } };
  const context = { document: doc, resolve: schema => resolveSchema(schema, doc), kind: schema => schema.type };
  assert.deepEqual(inferLookup(context, { type: 'string' }, 'debitAccountId'), { url: '/accounts', valueField: 'id', labelField: 'name' });
  const override = { url: '/custom', valueField: 'key', labelField: 'label' };
  assert.equal(inferLookup(context, { type: 'string', 'x-lookup': override }, 'accountId'), override);
  doc.paths['/v2/accounts'] = collection;
  assert.equal(inferLookup(context, { type: 'string' }, 'accountId'), undefined);
  delete doc.paths['/v2/accounts'];
  doc.paths['/accounts'] = { ...collection, parameters: [{ name: 'scope', in: 'query', required: true }] };
  assert.equal(inferLookup(context, { type: 'string' }, 'accountId'), undefined);
  doc.paths['/accounts'] = { ...collection, parameters: [{ name: 'search', in: 'query' }] };
  assert.equal(inferLookup(context, { type: 'string' }, 'accountId').searchParam, 'search');
});

test('inferred lookup is rendered and ambiguous lookup stays a native input', async () => {
  const container = new Node('div');
  const priorLocation = globalThis.location;
  const priorFetch = globalThis.fetch;
  const requests = [];
  globalThis.location = new URL('https://example.test/bench/');
  globalThis.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => [{ id: 'a', name: 'Example' }] };
  };
  try {
    const collection = { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } } } } } };
    const document = { paths: { '/accounts': collection } };
    const schema = { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' } } };
    createSchemaForm({ container, schema, document });
    // A lookup loads its options as it renders, so its status line can count them.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, ['https://example.test/accounts']);
    assert.ok(container.walk().some(node => node.className === 'picked'));
    assert.ok(container.walk().some(node => node.role === 'combobox' && node.className.includes('lk')));
    document.paths['/v2/accounts'] = collection;
    createSchemaForm({ container, schema, document });
    assert.ok(container.walk().some(node => node.tag === 'input' && node.type === 'text'));
    assert.equal(requests.length, 1);
  } finally {
    globalThis.location = priorLocation;
    globalThis.fetch = priorFetch;
  }
});

test('amount and currency are paired only when names and types are unambiguous', () => {
  const container = new Node('div');
  const schema = { type: 'object', required: ['amount', 'currency'], properties: { amount: { type: 'number' }, currency: { type: 'string', enum: ['EUR', 'USD'] } } };
  const form = createSchemaForm({ container, schema, value: { amount: 2, currency: 'EUR' } });
  assert.ok(container.walk().some(node => node.role === 'combobox' && node['aria-label'] === 'Currency'));
  assert.deepEqual(form.getValue(), { amount: 2, currency: 'EUR' });
  schema.properties.Currency = { type: 'string' };
  createSchemaForm({ container, schema, value: {} });
  assert.ok(!container.walk().some(node => node.role === 'combobox' && node['aria-label'] === 'Currency'));
});

test('samples use examples and respect basic length and exclusive numeric bounds', () => {
  assert.deepEqual(sampleValue({ type: 'object', properties: {
    message: { type: 'string' }, email: { type: 'string', format: 'email' },
    short: { type: 'string', maxLength: 2 },
  } }), { message: 'value', email: 'person@example.com', short: 'va' });
  assert.equal(sampleValue({ type: 'string', examples: ['first', 'second'] }), 'first');
  assert.equal(sampleValue({ type: 'string', minLength: 5 }).length, 5);
  assert.equal(sampleValue({ type: 'integer', maximum: -1.5 }), -2);
  const numeric = sampleValue({ type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 1.005 });
  assert.ok(numeric > 1 && numeric < 1.005);
  assert.equal(sampleValue({ type: 'integer', minimum: 4, exclusiveMinimum: true }), 5);
});

test('variant selection retains fields and validates the chosen discriminator', () => {
  const container = new Node('div');
  const schema = { discriminator: { propertyName: 'kind' }, oneOf: [
    { title: 'Card', type: 'object', required: ['kind', 'card'], properties: { kind: { const: 'card', type: 'string' }, card: { type: 'string' } } },
    { title: 'Cash', type: 'object', required: ['kind', 'notes'], properties: { kind: { const: 'cash', type: 'string' }, notes: { type: 'string' } } }
  ] };
  const form = createSchemaForm({ container, schema, value: { kind: 'card', card: '123', notes: 'keep' } });
  const selector = container.walk().find(node => node.role === 'combobox' && node['aria-label'] === 'Schema variant');
  selector.choose('Cash');
  assert.deepEqual(form.getValue(), { kind: 'cash', card: '123', notes: 'keep' });
  assert.equal(form.validate().valid, true);
  form.setValue({ kind: 'card', card: 'again' });
  assert.equal(form.validate().valid, true);
});

test('lookups use same-origin credentials and retain the chosen typed value', async () => {
  const container = new Node('div');
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = new URL('https://example.test/tool');
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => [{ id: 42, name: 'Operating', iban: 'IBAN' }] };
  };
  try {
    const form = createSchemaForm({ container, basePath: '/tenant', schema: { type: 'integer', 'x-lookup': { url: '/accounts', valueField: 'id', labelField: 'name', detailField: 'iban' } } });
    const control = container.walk().find(node => node.role === 'combobox');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0].url, 'https://example.test/tenant/accounts');
    assert.equal(calls[0].options.credentials, 'same-origin');
    control.choose(42);
    assert.equal(form.getValue(), 42);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(container.walk().some(node => node.textContent === 'Operating'), 'the control names the chosen record');
    assert.ok(container.walk().some(node => node.textContent === 'IBAN'), 'with its detail');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});

test('binary upload preserves File identity through change, get and validation', () => {
  const container = new Node('div');
  const changes = [];
  const schema = { type: 'object', required: ['attachment'], properties: { attachment: { type: 'string', format: 'binary' } } };
  const form = createSchemaForm({ container, schema, onChange: value => changes.push(value) });
  const input = container.walk().find(node => node.type === 'file');
  const file = new File(['invoice'], 'invoice.txt', { type: 'text/plain' });
  input.files = [file];
  input.events.change();
  assert.equal(form.getValue().attachment, file);
  assert.equal(changes.at(-1).attachment, file);
  assert.equal(form.validate().valid, true);
  form.setValue(form.getValue());
  assert.equal(form.getValue().attachment, file);
  assert.ok(container.walk().some(node => node.textContent === 'invoice.txt'));
});

test('optional chips open independently and present values stay visible', () => {
  const container = new Node('div');
  const schema = { type: 'object', required: ['first', 'second'], properties: {
    first: { type: 'object', properties: { detail: { type: 'string' } } },
    second: { type: 'object', properties: { detail: { type: 'string' } } }
  } };
  const form = createSchemaForm({ container, schema, value: { first: { detail: 'a' }, second: {} } });
  const chip = container.walk().find(node => node.dataset.optionalPath);
  assert.equal(chip.dataset.optionalPath, '["second","detail"]');
  chip.events.click();
  assert.ok(!container.walk().some(node => node.dataset.optionalPath));
  form.setValue(form.getValue());
  assert.ok(!container.walk().some(node => node.dataset.optionalPath));
  assert.deepEqual(form.getValue(), { first: { detail: 'a' }, second: {} });
});

test('date-time edits emit an ISO instant and reject cross-origin lookups', async () => {
  const container = new Node('div');
  const form = createSchemaForm({ container, schema: { type: 'string', format: 'date-time' }, value: '2026-11-20T12:30:00Z' });
  const input = container.walk().find(node => node.tag === 'input');
  assert.equal(input.type, 'datetime-local');
  input.value = '2026-11-20T12:30';
  input.events.input();
  assert.equal(form.getValue(), new Date('2026-11-20T12:30').toISOString());

  const previous = globalThis.location;
  globalThis.location = new URL('https://example.test/tool');
  try {
    createSchemaForm({ container, schema: { type: 'string', 'x-lookup': { url: 'https://other.test/accounts' } } });
    const control = container.walk().find(node => node.role === 'combobox');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(control.lookupStatus(), 'Lookup URL must be same-origin.');
  } finally { globalThis.location = previous; }
});

test('format, type, and constraint validation applies to present optional values', () => {
  const schema = { type: 'object', properties: {
    email: { type: 'string', format: 'email' },
    amount: { type: 'number', minimum: 1 },
    date: { type: 'string', format: 'date' },
    instant: { type: 'string', format: 'date-time' }
  } };
  assert.deepEqual(validateSchemaValue({ schema, value: {} }), []);
  const errors = validateSchemaValue({ schema, value: { email: 'kk', amount: 'g', date: '2026-02-30', instant: 'not-an-instant' } });
  assert.deepEqual(errors.map(error => error.path), ['email', 'amount', 'date', 'instant']);
  assert.match(errors[0].message, /email/i);
  assert.match(errors[1].message, /number/i);
});

test('an empty required object reports its required children', () => {
  const errors = validateSchemaValue({
    schema: { type: 'object', required: ['email', 'password'], properties: {
      email: { type: 'string', format: 'email' }, password: { type: 'string' }
    } },
    value: undefined,
    required: true
  });
  assert.deepEqual(errors.map(error => error.path), ['email', 'password']);
});

test('missing required objects with optional or recursive children remain bounded', () => {
  const optionalObject = { type: 'object', properties: { note: { type: 'string' } } };
  assert.deepEqual(validateSchemaValue({ schema: optionalObject, value: undefined, required: true }).map(error => error.path), ['']);
  assert.deepEqual(validateSchemaValue({ schema: optionalObject, value: {} }), []);

  const recursive = { type: 'object', required: ['child'], properties: {} };
  recursive.properties.child = recursive;
  const errors = validateSchemaValue({ schema: recursive, value: undefined, required: true });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].path.split('.').length <= 21);
});

test('invalid numeric drafts stay visible in the form value and live validation blocks them', () => {
  const container = new Node('div');
  const form = createSchemaForm({ container, schema: { type: 'object', properties: { amount: { type: 'number' } } }, value: {} });
  container.walk().find(node => node.dataset.optionalPath).events.click();
  const input = container.walk().find(node => node.inputMode === 'decimal');
  input.value = 'g';
  input.events.input();
  assert.equal(form.getValue().amount, 'g');
  assert.equal(form.validate().valid, false);
  input.value = '';
  input.events.input();
  assert.equal(form.validate().valid, true);
});

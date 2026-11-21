import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchemaValue } from './schema.js';

const validate = (schema, value, document) => validateSchemaValue({ schema, value, document });

test('numeric bounds retain both OpenAPI 3.0 and JSON Schema 2020-12 semantics', () => {
  const legacy = { type: 'number', minimum: 1, exclusiveMinimum: true, maximum: 4, exclusiveMaximum: true };
  assert.equal(validate(legacy, 1)[0].message, 'Must be greater than 1.');
  assert.equal(validate(legacy, 4)[0].message, 'Must be less than 4.');
  assert.deepEqual(validate(legacy, 2), []);

  const modern = { minimum: -2, maximum: 5, exclusiveMinimum: -1, exclusiveMaximum: 4 };
  assert.equal(validate(modern, -1)[0].message, 'Must be greater than -1.');
  assert.equal(validate(modern, 4)[0].message, 'Must be less than 4.');
  assert.deepEqual(validate(modern, 'ignored for text'), []);

  const amount = { type: 'number', multipleOf: 0.01 };
  assert.deepEqual(validate(amount, -0.29), []);
  assert.match(validate(amount, 1.005)[0].message, /multiple of 0\.01/);
  assert.match(validate({ multipleOf: 3 }, 10000000000000000)[0].message, /multiple of 3/);
  assert.match(validate({ type: 'integer', format: 'int32' }, 2147483648)[0].message, /2147483647/);
});

test('property presence, JSON null, nullable, and a union of types are independent', () => {
  const schema = {
    required: ['present', 'nullable'],
    properties: {
      present: { type: 'string' },
      nullable: { type: ['integer', 'string', 'null'] },
      optional: { type: 'boolean' },
    },
  };
  assert.deepEqual(validate(schema, { present: '', nullable: null, optional: false }), []);
  assert.deepEqual(validate(schema, { present: '', nullable: 0 }), []);
  assert.deepEqual(validate(schema, { nullable: true, optional: null }).map(error => error.path), ['present', 'nullable', 'optional']);
  assert.deepEqual(validate({ const: null }, null), []);
  assert.equal(validate({ type: 'null' }, 0)[0].message, 'Use null.');
  assert.deepEqual(validate({ minLength: 4 }, null), []);
  assert.equal(validate({ type: 'string', nullable: true, enum: ['active'] }, null)[0].message, 'Choose an allowed value: "active".');
  assert.deepEqual(validate({ type: 'string', nullable: true }, null, { openapi: '3.0.3' }), []);
  assert.match(validate({ type: 'string', nullable: true }, null, { openapi: '3.1.1' })[0].message, /null/);
  assert.match(validate(false, { anything: true })[0].message, /not allowed/);
  assert.deepEqual(validate(true, null), []);
});

test('Unicode length, schema patterns and deep JSON equality use the actual value', () => {
  assert.deepEqual(validate({ maxLength: 1, pattern: '^.$' }, '🎉'), []);
  assert.equal(validate({ minLength: 2 }, '🎉')[0].message, 'Use at least 2 characters.');
  assert.equal(validate({ pattern: '^[A-Z]{3}$' }, 'ab1')[0].message, 'Use the format shown in the example.');
  assert.match(validate({ pattern: '^[A-Z]{3}$', example: 'ABC' }, 'ab1')[0].message, /ABC/);
  assert.deepEqual(validate({ pattern: '[' }, 'malformed schema pattern'), []);

  const option = { a: [-0, ['first', 'second']], b: true };
  assert.deepEqual(validate({ enum: [option], const: option }, { b: true, a: [0, ['first', 'second']] }), []);
  assert.match(validate({ const: option }, { b: true, a: [0, ['second', 'first']] })[0].message, /Use \{"a"/);
  const errors = validate({ uniqueItems: true }, [option, { b: true, a: [0, ['first', 'second']] }]);
  assert.deepEqual(errors, [{ path: '1', message: 'Remove or change this item. It duplicates item 1.' }]);
});

test('named properties, multiple matching patterns, and extra property schemas each apply', () => {
  const schema = {
    type: 'object',
    required: ['declared', 'undeclared'],
    minProperties: 2,
    maxProperties: 5,
    properties: { declared: { minimum: 2 } },
    patternProperties: { '^d': { multipleOf: 2 }, 'red$': { maximum: 4 } },
    propertyNames: { pattern: '^[a-z]+$' },
    additionalProperties: { type: 'boolean' },
  };
  const errors = validate(schema, { declared: 5, 'bad-name': 'false' });
  assert.deepEqual(errors.map(error => error.path), ['undeclared', 'declared', 'declared', 'bad-name', 'bad-name']);
  assert.match(errors[3].message, /true or false/);
  assert.match(errors[4].message, /Rename property "bad-name"/);
  assert.match(validate({ additionalProperties: false }, { extra: 0 })[0].message, /Remove property "extra"/);
  assert.match(validate(schema, {})[0].message, /at least 2 properties/);
  assert.match(validate(schema, { one: true, two: true, three: true, four: true, five: true, six: true })[0].message, /at most 5 properties/);
  assert.deepEqual(validate(schema, { declared: 4, undeclared: true }), []);
});

test('optional nested properties trigger dependent requirements, schemas and conditions when present', () => {
  const schema = {
    properties: {
      payment: {
        dependentRequired: { card: ['holder'] },
        dependentSchemas: { card: { properties: { card: { minLength: 4 } } } },
        if: { required: ['card'] },
        then: { properties: { amount: { minimum: 1 } } },
        else: { properties: { amount: { maximum: 1 } } },
        dependencies: { invoice: ['reference'] },
      },
    },
  };
  assert.deepEqual(validate(schema, {}), []);
  const errors = validate(schema, { payment: { card: '', amount: 0, invoice: false } });
  assert.deepEqual(errors.map(error => error.path), ['payment.amount', 'payment.reference', 'payment.holder', 'payment.card']);
  assert.match(errors[1].message, /required when "invoice"/);
  assert.match(errors[2].message, /required when "card"/);
  assert.equal(validate(schema, { payment: { amount: 2 } })[0].message, 'Must be at most 1.');
  assert.deepEqual(validate(schema, { payment: { card: '1234', amount: 1, holder: 'A' } }), []);
});

test('array tuple, contains cardinality and unevaluated indices preserve item paths', () => {
  const tuple = { prefixItems: [{ type: 'boolean' }, { type: 'integer' }], items: false, minItems: 2, maxItems: 3 };
  assert.deepEqual(validate(tuple, [false, 0]), []);
  assert.equal(validate(tuple, [true])[0].message, 'Use at least 2 items.');
  const errors = validate(tuple, [true, '0', 3, 4]);
  assert.deepEqual(errors.map(error => error.path), ['', '1', '2', '3']);
  assert.match(errors[2].message, /Remove this item/);
  assert.deepEqual(validate({ items: [{ const: 1 }], additionalItems: false }, [1, 2]).map(error => error.path), ['1']);

  const schema = { prefixItems: [{ type: 'string' }], contains: { const: 5 }, minContains: 1, maxContains: 2, unevaluatedItems: false };
  assert.deepEqual(validate(schema, ['', 5]), []);
  assert.equal(validate(schema, ['start'])[0].message, 'Use at least 1 item equal to 5.');
  assert.equal(validate(schema, ['start', 5, 5, 5])[0].message, 'Use at most 2 items equal to 5.');
  assert.deepEqual(validate(schema, ['start', 5, 6]).map(error => error.path), ['2']);
  assert.deepEqual(validate({ contains: false, minContains: 0 }, [false]), []);
});

test('composition validates branch cardinality, applies base constraints and honors keyword scope', () => {
  const oneOf = { oneOf: [{ title: 'Whole', type: 'integer' }, { title: 'Below five', maximum: 5 }] };
  assert.match(validate(oneOf, 2)[0].message, /matches Whole, Below five/);
  assert.deepEqual(validate(oneOf, 6), []);
  assert.deepEqual(validate({ anyOf: oneOf.oneOf, maximum: 1 }, 2).map(error => error.message), ['Must be at most 1.']);
  assert.match(validate({ not: { title: 'Zero', const: 0 } }, 0)[0].message, /does not match Zero/);
  assert.match(validate({ allOf: [{ minimum: 10 }, { minimum: 2 }] }, 4)[0].message, /at least 10/);

  const closed = {
    allOf: [
      { properties: { a: {} }, additionalProperties: false },
      { properties: { b: {} } },
    ],
  };
  assert.deepEqual(validate(closed, { a: 1, b: 2 }).map(error => error.path), ['b']);

  const composable = {
    anyOf: [{ required: ['a'], properties: { a: { type: 'string' } } }, { properties: { b: {} } }],
    unevaluatedProperties: false,
  };
  assert.deepEqual(validate(composable, { a: 'ok', b: 2 }), []);
  assert.deepEqual(validate(composable, { a: 1, b: 2 }).map(error => error.path), ['a']);
});

test('discriminator hints surface the relevant branch fix and leave schema matching authoritative', () => {
  const schema = {
    discriminator: { propertyName: 'kind' },
    oneOf: [
      { title: 'Card', required: ['card'], properties: { kind: { const: 'card' }, card: { type: 'string' } } },
      { title: 'Cash', required: ['amount'], properties: { kind: { const: 'cash' }, amount: { minimum: 1 } } },
    ],
  };
  const errors = validate(schema, { kind: 'cash', amount: 0 });
  assert.deepEqual(errors.map(error => error.path), ['amount', '']);
  assert.equal(errors[0].message, 'Must be at least 1.');
  assert.match(errors[1].message, /Card, Cash/);
  const omitted = { discriminator: { propertyName: 'kind' }, oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validate(omitted, 0), []);
});

test('local references preserve schemas, dialect siblings and read-only handling', () => {
  const document = { openapi: '3.1.1', components: { schemas: {
    'A/B ~ value': { type: 'string', minLength: 4 },
    ServerField: { type: 'integer', readOnly: true },
  } } };
  const reference = { $ref: '#/components/schemas/A~1B%20~0%20value', minLength: 2 };
  assert.equal(validate(reference, 'abc', document)[0].message, 'Use at least 4 characters.');
  const strictSibling = { ...reference, minLength: 6 };
  assert.equal(validate(strictSibling, 'abcd', document)[0].message, 'Use at least 6 characters.');
  assert.deepEqual(validate(strictSibling, 'abcd', { ...document, openapi: '3.0.3' }), []);
  const combined = {
    allOf: [
      { required: ['id', 'client'] },
      { properties: { id: { $ref: '#/components/schemas/ServerField' }, client: { type: 'string' } } },
    ],
  };
  assert.deepEqual(validate(combined, { client: 'A' }, document), []);
  assert.deepEqual(validate(combined, {}, document).map(error => error.path), ['client']);
  assert.match(validate({ $defs: { blocked: false }, $ref: '#/$defs/blocked' }, 1)[0].message, /not allowed/);
  assert.match(validate({ $defs: { amount: { $anchor: 'amount', minimum: 3 } }, $ref: '#amount' }, 1)[0].message, /at least 3/);

  const recursive = {
    $ref: '#/$defs/Node',
    $defs: { Node: { properties: { child: { $ref: '#/$defs/Node' }, name: { minLength: 2 } } } },
  };
  let value = { name: 'x' };
  for (let depth = 0; depth < 25; depth++) value = { child: value };
  assert.equal(validate(recursive, value)[0].path, 'child.'.repeat(25) + 'name');
});

test('recognized formats accept real values and report a correction for invalid values', () => {
  const cases = [
    ['email', 'ops@acme.dev', 'ops..team@acme.dev', /email address/],
    ['idn-email', '用户@例子.中国', '用户@-例子.中国', /email address/],
    ['date', '2024-02-29', '2026-02-29', /YYYY-MM-DD/],
    ['date-time', '2026-01-01t09:30:00+02:00', '2026-02-30T09:30:00Z', /time zone/],
    ['time', '00:59:60+01:00', '09:30:00+24:00', /time zone/],
    ['duration', 'P1DT30M', 'P1W2D', /duration/],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000', 'not-a-uuid', /UUID/],
    ['hostname', 'api.example.com', '-api.example.com', /hostname/],
    ['idn-hostname', '例子.中国', '例子/.中国', /hostname/],
    ['ipv4', '192.0.2.1', '192.0.2.256', /IPv4/],
    ['ipv6', '2001:db8::192.0.2.1', '2001:::1', /IPv6/],
    ['url', 'https://example.com/a', '/a', /URL/],
    ['uri', 'urn:example:abc', 'https://example.com/%zz', /URI/],
    ['uri-reference', '../items/42?q=1', '/a b', /relative path/],
    ['iri', 'https://example.com/café', 'café', /absolute IRI/],
    ['iri-reference', '/café', '/café#one#two', /relative path/],
    ['uri-template', '/items/{id}{?filter,limit}', '/items/{filter,,limit}', /URI template/],
    ['json-pointer', '/items/a~1b', '/items/~2', /JSON Pointer/],
    ['relative-json-pointer', '1/items', '01/items', /relative JSON Pointer/],
    ['regex', '^[A-Z]+$', '[', /regular expression/],
    ['byte', 'SGVsbG8=', 'SGVsbG8_', /Base64/],
  ];
  for (const [format, valid, invalid, hint] of cases) {
    const schema = { type: 'string', format };
    assert.deepEqual(validate(schema, valid), [], format);
    assert.match(validate(schema, invalid)[0]?.message ?? '', hint, format);
  }
  assert.deepEqual(validate({ type: 'string', format: 'custom-id' }, 'a-123'), []);
  assert.match(validate({ format: 'uri' }, 'https://')[0].message, /absolute URI/);
  assert.deepEqual(validate({ format: 'uri' }, 'file:///tmp/example.txt'), []);
});

test('a missing required value says what to enter for the kind of field', () => {
  const schema = {
    type: 'object',
    required: ['debitAccountId', 'amount', 'count', 'valueDate', 'email', 'currency', 'active', 'tags', 'note'],
    properties: {
      debitAccountId: { type: 'string', 'x-lookup': { url: '/accounts' } },
      amount: { type: 'number' },
      count: { type: 'integer' },
      valueDate: { type: 'string', format: 'date' },
      email: { type: 'string', format: 'email' },
      currency: { type: 'string', enum: ['EUR', 'USD'] },
      active: { type: 'boolean' },
      tags: { type: 'array', minItems: 2, items: { type: 'string' } },
      note: { type: 'string' },
    },
  };
  assert.deepEqual(Object.fromEntries(validate(schema, {}).map(error => [error.path, error.message])), {
    debitAccountId: 'Choose a debit account',
    amount: 'Enter a number, like 1,250.00',
    count: 'Enter a whole number, like 1,250',
    valueDate: 'Enter a date, like 23/11/2026',
    email: 'Enter an email address, like ops@acme.dev',
    currency: 'Choose one of EUR or USD',
    active: 'Choose true or false',
    tags: 'Add at least 2 items',
    note: 'Enter a note',
  });
});

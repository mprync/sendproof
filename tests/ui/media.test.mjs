import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeRequestBody, makeRequest, operations } from '../../ui/api.js';

test('multipart preserves files and repeated fields and lets fetch generate the boundary', () => {
  const headers = new Headers({ 'Content-Type': 'multipart/form-data' });
  const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
  const data = encodeRequestBody({ file, tags: ['a', 'b'] }, 'multipart/form-data', headers);
  assert.equal(headers.has('Content-Type'), false);
  assert.equal(data.get('file').name, file.name);
  assert.deepEqual(data.getAll('tags'), ['a', 'b']);
});

test('JSON, text and URL-encoded requests use their declared media type', () => {
  const headers = {};
  assert.equal(encodeRequestBody({ a: 4 }, 'application/custom+json', headers), '{"a":4}');
  assert.equal(headers['Content-Type'], 'application/custom+json');
  assert.equal(encodeRequestBody('x,y', 'text/csv', headers), 'x,y');
  const form = encodeRequestBody({ name: 'M & M' }, 'application/x-www-form-urlencoded', headers);
  assert.equal(form.toString(), 'name=M+%26+M');
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('operation-specific parameters supersede path-level references', () => {
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const local = { ...id, schema: { type: 'integer' } };
  const [operation] = operations({
    components: { parameters: { Id: id } },
    paths: { '/items/{id}': { parameters: [{ $ref: '#/components/parameters/Id' }], get: { parameters: [local] } } },
  });
  assert.deepEqual(operation.parameters, [local]);
});

test('a spec cannot direct the prepared request outside the mounted API', () => {
  globalThis.location = new URL('https://example.test/team/sendproof/');
  for (const path of ['//other.test/path', '/../private']) {
    assert.throws(() => makeRequest({ method: 'GET', path }, [], undefined, {}, '/team/'));
  }
});

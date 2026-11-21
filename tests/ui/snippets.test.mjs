import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRequest, snippetFormats } from '../../ui/snippets.js';

const request = {
  method: 'post',
  url: 'https://api.test/sendproof/_preview/payments?custom-auth=private-value&filter=pending',
  headers: { Authorization: 'Bearer private-value', Prefer: 'tx=rollback', 'Content-Type': 'application/json' },
  body: JSON.stringify({ note: "Alice's invoice", settings: { password: 'private-value' } }),
};

for (const { id } of snippetFormats) {
  test(id + ' preserves Preview and redacts credentials from all request locations', () => {
    const result = formatRequest(id, request, ['custom-auth']);
    assert.doesNotMatch(result, /private-value/);
    assert.match(result, /_preview\/payments/);
    assert.match(result, /filter=pending/);
    assert.match(result, /tx=rollback/);
    assert.match(result, /REDACTED/);
  });
}

test('cURL quotes apostrophes and treats an at-sign body as literal text', () => {
  const result = formatRequest('curl', { ...request, headers: {}, body: "@Alice's" });
  assert.ok(result.endsWith("--data-raw '@Alice'\\''s'"));
});

test('.http export keeps the original JSON bytes when masking is unnecessary', () => {
  const body = '{ "amount": 4.00 }';
  assert.ok(formatRequest('http', { ...request, body }).endsWith('\n\n' + body));
});

test('file bodies fail explicitly instead of exporting a different request', () => {
  assert.throws(() => formatRequest('curl', { ...request, body: new Blob(['text']) }), /binary/);
});

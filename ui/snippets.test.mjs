import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRequest, pickerFormats, snippetFormats } from './snippets.js';
import { checkSnippets, fixtures } from '../tools/snippet-check.mjs';

// A body whose strings contain a quote of every kind, a newline, a backslash, unicode, a dollar,
// a Ruby interpolation, a backtick and a credential in a field and a header.
const awkward = { note: 'Alice\'s "quoted" invoice\nline 2 \\ back é 😀 $schema #{x} `tick`', amount: 4.5, nested: { password: 'private-value' } };
const request = {
  method: 'post',
  url: 'https://api.test/sendproof/_preview/payments?custom-auth=private-value&filter=pending',
  headers: { Authorization: 'Bearer private-value', Prefer: 'tx=rollback', 'Content-Type': 'application/json', Cookie: 'session=private-value' },
  body: JSON.stringify(awkward),
};
const ids = pickerFormats.map(format => format.id);

test('the picker offers every adapter language and .http stays export-only', () => {
  assert.deepEqual(ids, ['curl', 'fetch', 'python', 'csharp', 'go', 'java', 'kotlin', 'php', 'ruby', 'rust', 'powershell']);
  assert.deepEqual(snippetFormats.filter(format => format.hidden).map(format => format.id), ['http']);
  for (const format of snippetFormats) assert.ok(format.label && format.library && format.icon && format.lexer, `${format.id} names its language, library, mark and grammar`);
});

for (const { id } of snippetFormats) {
  test(`${id} preserves Preview and redacts credentials from every request location`, () => {
    const result = formatRequest(id, request, ['custom-auth']);
    assert.doesNotMatch(result, /private-value/);
    assert.match(result, /_preview\/payments/);
    assert.match(result, /filter=pending/);
    assert.match(result, /tx=rollback/);
    assert.match(result, /REDACTED/);
    assert.match(result, /"password": "REDACTED"|password.*REDACTED/s);
  });
}

test('every language puts one statement per line and indents the JSON body', () => {
  for (const id of ids.filter(format => format !== 'curl')) {
    const lines = formatRequest(id, request, []).split('\n');
    assert.ok(lines.length >= 8, `${id} spans several lines`);
    assert.ok(lines.every(line => line.length <= 130 || /https:\/\/|note/.test(line)), `${id} has no crammed line`);
    assert.ok(lines.some(line => /^\s+"note": /.test(line)), `${id} indents the body one key per line`);
  }
  // The old C# sample put several statements on a line.
  assert.ok(formatRequest('csharp', request, []).split('\n').every(line => (line.match(/;/g) ?? []).length <= 1 || /for|\{ .* \}/.test(line)));
});

test('JavaScript output runs and sends exactly the request, quotes, newlines and unicode intact', async () => {
  const code = formatRequest('fetch', request, ['custom-auth']);
  let call;
  const run = new (Object.getPrototypeOf(async () => {}).constructor)('fetch', 'console', code);
  await run((url, init) => { call = { url, init }; return { status: 200, text: async () => 'ok' }; }, { log() {} });
  assert.equal(call.url, 'https://api.test/sendproof/_preview/payments?custom-auth=REDACTED&filter=pending');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.headers.Authorization, 'REDACTED');
  assert.deepEqual(JSON.parse(call.init.body), { ...awkward, nested: { password: 'REDACTED' } });
});

test('JavaScript keeps a __proto__ key and a non-JSON body as strings', () => {
  const proto = formatRequest('fetch', { ...request, body: '{"__proto__":{"x":1}}' }, []);
  assert.match(proto, /body: "\{\\n {2}\\"__proto__\\"/);
  assert.match(formatRequest('fetch', { ...request, headers: { 'Content-Type': 'text/plain' }, body: 'a "b"\nc' }, []), /body: "a \\"b\\"\\nc"/);
});

test('cURL quotes apostrophes and treats an at-sign body as literal text', () => {
  const result = formatRequest('curl', { ...request, headers: {}, body: "@Alice's" });
  assert.ok(result.endsWith("--data-raw '@Alice'\\''s'"));
  assert.match(formatRequest('curl', request, []), /Alice'\\''s/);
});

test('Python uses a raw triple-quoted body unless it would break the quotes', () => {
  assert.match(formatRequest('python', request, []), /payload = r"""\{\n {4}"note"/);
  assert.match(formatRequest('python', request, []), /data=payload\.encode\("utf-8"\)/);
  const tricky = formatRequest('python', { ...request, headers: {}, body: 'say """hi"""\nnow' }, []);
  assert.match(tricky, /payload = "say \\"\\"\\"hi\\"\\"\\"\\nnow"/);
  assert.match(formatRequest('python', { ...request, headers: {}, body: 'a\nb"' }, []), /payload = "a\\nb\\""/);
});

test('C# uses a raw string literal, StringContent with the media type and no stray Content-Type header', () => {
  const result = formatRequest('csharp', request, []);
  assert.match(result, /var body = """\n {4}\{\n/);
  assert.match(result, /\n"""\;/, 'the closing fence lines up with the statement');
  assert.match(result, /new StringContent\(body, Encoding\.UTF8, "application\/json"\)/);
  assert.doesNotMatch(result, /TryAddWithoutValidation\("Content-Type"/);
  assert.match(result, /HttpMethod\.Post/);
  // A quote run in the body lengthens the fence, so the literal can never end early.
  assert.match(formatRequest('csharp', { ...request, headers: {}, body: 'a """ b\nc' }, []), /var body = """"\n/);
  assert.match(formatRequest('csharp', { ...request, method: 'query' }, []), /new HttpMethod\("QUERY"\)/);
  assert.match(formatRequest('csharp', { ...request, headers: {}, body: 'one "line"\u2028' }, []), /var body = "one \\"line\\"\\u2028";/);
});

test('C# sends Content-* headers with the content and skips them when there is no body', () => {
  const withBody = formatRequest('csharp', { ...request, headers: { 'Content-Type': 'text/plain', 'Content-Language': 'de' }, body: 'x' }, []);
  assert.match(withBody, /request\.Content\.Headers\.TryAddWithoutValidation\("Content-Language", "de"\)/);
  const without = formatRequest('csharp', { method: 'get', url: 'https://api.test/a', headers: { 'Content-Language': 'de', Accept: 'text/plain' } }, []);
  assert.doesNotMatch(without, /Content-Language/);
  assert.match(without, /request\.Headers\.TryAddWithoutValidation\("Accept", "text\/plain"\)/);
});

test('Go writes a backtick body, method constants, tabs, and escapes when a backtick is in the body', () => {
  const result = formatRequest('go', { ...request, body: '{"a":"b\\n"}' }, []);
  assert.match(result, /\tpayload := `\{\n\t\t"a": /);
  assert.match(result, /\n\t\}`\n\tbody := strings\.NewReader\(payload\)/);
  assert.match(result, /http\.NewRequest\(http\.MethodPost, /);
  assert.match(result, /\n\treq\.Header\.Set\("Prefer", "tx=rollback"\)/);
  const withTick = formatRequest('go', { ...request, headers: {}, body: '{\n"a":"`x`"\n}' }, []);
  assert.match(withTick, /payload := `\{\n"a":"` \+ "`" \+ `x` \+ "`" \+ `"\n\}`\n/);
  assert.match(formatRequest('go', { ...request, headers: {}, body: 'one "line"\u0001' }, []), /payload := "one \\"line\\"\\u0001"\n/);
  assert.doesNotMatch(formatRequest('go', { method: 'get', url: 'https://api.test/a', headers: {} }, []), /strings/);
});

test('Java uses a text block with escaped backslashes and falls back for trailing blanks', () => {
  const result = formatRequest('java', request, []);
  assert.match(result, /String body = """\n {12}\{\n/);
  assert.match(result, /\n {8}""";/);
  assert.match(result, /\\\\"quoted\\\\"/);
  assert.match(result, /\.POST\(BodyPublishers\.ofString\(body\)\)/);
  assert.match(formatRequest('java', { ...request, headers: {}, body: 'a \nb' }, []), /String body = "a \\nb";/);
  assert.match(formatRequest('java', { method: 'get', url: 'https://api.test/a', headers: {} }, []), /\.GET\(\)/);
  assert.match(formatRequest('java', { method: 'patch', url: 'https://api.test/a', headers: {}, body: 'x' }, []), /\.method\("PATCH", BodyPublishers\.ofString\(body\)\)/);
});

test('Kotlin escapes the dollar sign in raw and regular strings and sets the content type separately', () => {
  const result = formatRequest('kotlin', request, []);
  assert.match(result, /\$\{'\$'\}schema/);
  assert.match(result, /\.trimIndent\(\)/);
  assert.match(result, /contentType\(ContentType\.parse\("application\/json"\)\)/);
  assert.doesNotMatch(result, /header\("Content-Type"/);
  assert.match(formatRequest('kotlin', { ...request, headers: {}, body: 'cost $5' }, []), /val body = "cost \\\$5"/);
});

test('PHP uses a nowdoc, single-quoted strings and avoids a marker the body contains', () => {
  const result = formatRequest('php', request, []);
  assert.match(result, /'body' => <<<'JSON'\n {8}\{\n/);
  assert.match(result, /\n {4}JSON,\n/);
  assert.match(result, /'Prefer' => 'tx=rollback'/);
  assert.match(formatRequest('php', { ...request, headers: {}, body: 'a\nJSON\nb' }, []), /<<<'BODY1'/);
  assert.match(formatRequest('php', { ...request, headers: { 'X-Q': "it's" }, body: '$x\n\ty' }, []), /'X-Q' => 'it\\'s'/);
  assert.match(formatRequest('php', { ...request, headers: {}, body: 'cost $5\n\ttab' }, []), /'body' => "cost \\\$5\\n\\ttab"/);
});

test('Ruby uses a single-quoted heredoc with chomp and escapes interpolation in strings', () => {
  const result = formatRequest('ruby', request, []);
  assert.match(result, /request\.body = <<~'JSON'\.chomp\n {2}\{\n/);
  assert.match(result, /\nJSON\n/);
  assert.match(result, /Net::HTTP::Post\.new\(uri\)/);
  const indented = formatRequest('ruby', { ...request, headers: {}, body: '  indented #{x}\n  more' }, []);
  assert.match(indented, /request\.body = "  indented \\#\{x\}\\n  more"/);
  assert.match(formatRequest('ruby', { ...request, method: 'query' }, []), /Net::HTTPGenericRequest\.new\("QUERY", true, true, uri\)/);
});

test('Rust uses a raw string with enough hashes, and escapes with Rust syntax otherwise', () => {
  const result = formatRequest('rust', request, []);
  assert.match(result, /let body = r#"\{\n {8}"note"/);
  assert.match(result, /\n {4}\}"#;\n/);
  assert.match(result, /\.body\(body\)/);
  assert.match(formatRequest('rust', { ...request, headers: {}, body: 'a "# b\nc' }, []), /let body = r##"a "# b\nc"##;/);
  assert.match(formatRequest('rust', { ...request, headers: {}, body: 'tab\there\u0001' }, []), /let body = "tab\\there\\u\{1\}";/);
  assert.match(formatRequest('rust', { ...request, method: 'query' }, []), /Method::from_bytes\("QUERY"\.as_bytes\(\)\)/);
});

test('PowerShell uses a here-string, doubles quotes and moves Content-Type to -ContentType', () => {
  const result = formatRequest('powershell', request, []);
  assert.match(result, /\$body = @'\n {2}\{\n/);
  assert.match(result, /\n'@\n/);
  assert.match(result, /ContentType = 'application\/json'/);
  assert.doesNotMatch(result, /'Content-Type' =/);
  assert.match(formatRequest('powershell', { ...request, headers: { 'X-Q': "it's" }, body: 'a\u2019b\'c' }, []), /'X-Q' = 'it''s'[\s\S]*\$body = 'a\u2019\u2019b''c'/);
  assert.match(formatRequest('powershell', { ...request, headers: {}, body: "x\n'@\ny" }, []), /\$body = 'x\n''@\ny'/);
});

test('the Cookie header can be found in every language so Try it can show a placeholder there', async () => {
  const { default: source } = await import('node:fs').then(fs => ({ default: fs.readFileSync(new URL('./request-editor.js', import.meta.url), 'utf8') }));
  const pattern = new RegExp(/const COOKIE_VALUE = \/(.*)\/;/.exec(source)[1]);
  for (const id of ids) {
    const sample = formatRequest(id, { method: 'get', url: 'https://api.test/a', headers: { Cookie: 'session' } }, []);
    assert.match(sample, pattern, `${id} writes Cookie where the placeholder replaces it`);
  }
});

test('.http export keeps the original JSON bytes when masking is unnecessary', () => {
  const body = '{ "amount": 4.00 }';
  assert.ok(formatRequest('http', { ...request, body }).endsWith('\n\n' + body));
});

test('file bodies and unknown formats fail explicitly instead of exporting a different request', () => {
  for (const id of ids) assert.throws(() => formatRequest(id, { ...request, body: new Blob(['text']) }), /binary/);
  assert.throws(() => formatRequest('cobol', request), /Unsupported request format/);
  assert.throws(() => formatRequest('curl', { ...request, method: 'get;rm' }), /Unsupported HTTP method/);
});

test('every generated sample passes the syntax checker of each installed toolchain', () => {
  const { checked, failures } = checkSnippets();
  assert.deepEqual(failures, []);
  assert.ok(checked.size > 0, 'at least one toolchain was available');
  assert.ok(Object.keys(fixtures).length >= 7);
});

// Where each language's body literal opens and closes. `start` is the statement that opens it and
// `end` the line that closes it; every line between must sit deeper than the statement and the
// closing line must line up with it, so the sample reads as indented code.
const literals = {
  curl: { start: /^ {2}--data-raw '\{$/, end: /^ {2}\}'$/ },
  fetch: { start: /^ {2}body: JSON\.stringify\(\{$/, end: /^ {2}\}\),$/ },
  python: { start: /^payload = r"""\{$/, end: /^\}"""$/ },
  csharp: { start: /^var body = """$/, end: /^""";$/ },
  go: { start: /^\tpayload := `\{$/, end: /^\t\}`$/ },
  java: { start: /^ {8}String body = """$/, end: /^ {8}""";$/ },
  kotlin: { start: /^ {4}val body = """$/, end: /^ {4}""".trimIndent\(\)$/ },
  php: { start: /^ {4}'body' => <<<'JSON'$/, end: /^ {4}JSON,$/ },
  ruby: { start: /^request\.body = <<~'JSON'\.chomp$/, end: /^JSON$/ },
  rust: { start: /^ {4}let body = r#"\{$/, end: /^ {4}\}"#;$/ },
  powershell: { start: /^\$body = @'$/, end: /^'@$/ },
};
const indentOf = line => line.length - line.trimStart().length;

test('an embedded JSON body sits one level inside its statement and closes level with it, in every language', () => {
  assert.deepEqual(Object.keys(literals).sort(), ids.filter(id => id !== 'powershell').concat('powershell').sort(), 'every language is covered');
  for (const [id, { start, end }] of Object.entries(literals)) {
    const lines = formatRequest(id, request, []).split('\n');
    const from = lines.findIndex(line => start.test(line));
    const to = lines.findIndex((line, index) => index > from && end.test(line));
    assert.ok(from >= 0 && to > from, `${id}: the body literal is where the table says (${from}..${to})`);
    for (const line of lines.slice(from + 1, to).filter(Boolean)) {
      assert.ok(indentOf(line) > indentOf(lines[from]), `${id}: "${line}" is indented less than its statement`);
    }
    assert.equal(indentOf(lines[to]), indentOf(lines[from]), `${id}: the closing line lines up with the statement`);
    // Nested JSON levels step inwards, so the structure reads as indentation too.
    const keys = lines.slice(from + 1, to).filter(line => /^\s*"(note|amount|nested)"/.test(line));
    assert.equal(new Set(keys.map(indentOf)).size, 1, `${id}: sibling keys share one indent`);
  }
});

test('re-indenting never changes the JSON a sample sends', () => {
  const value = { note: 'a "quoted" \\ é\nline', n: [1, { b: 2 }], $ref: 'x' };
  const simple = { ...request, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
  for (const id of ['rust', 'python', 'go', 'csharp', 'php', 'ruby', 'powershell', 'kotlin', 'java']) {
    const lines = formatRequest(id, simple, []).split('\n');
    const from = lines.findIndex(line => literals[id].start.test(line));
    const to = lines.findIndex((line, index) => index > from && literals[id].end.test(line));
    let text = ['rust', 'python', 'go'].includes(id) ? '{\n' + lines.slice(from + 1, to).join('\n') + '\n}' : lines.slice(from + 1, to).join('\n');
    // Each language's own escaping, undone: Java doubles backslashes, Kotlin writes a dollar as ${'$'}.
    if (id === 'java') text = text.replaceAll('\\\\', '\\');
    if (id === 'kotlin') text = text.replaceAll("${'$'}", '$');
    assert.deepEqual(JSON.parse(text), value, `${id} sends the same JSON`);
  }
});

test('a body that is not JSON is never re-indented', () => {
  const text = { ...request, headers: { 'Content-Type': 'text/plain' }, body: 'a\n  b\n"""c' };
  assert.match(formatRequest('rust', text, []), /let body = r#"a\n {2}b\n"""c"#;/);
  assert.match(formatRequest('python', text, []), /payload = "a\\n {2}b\\n\\"\\"\\"c"/);
  assert.match(formatRequest('go', text, []), /payload := `a\n {2}b\n"""c`\n/);
  assert.match(formatRequest('curl', text, []), /--data-raw 'a\n {2}b\n"""c'$/);
});

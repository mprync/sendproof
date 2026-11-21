import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightJson, highlightSnippet } from './highlight.js';
import { formatRequest, pickerFormats, snippetFormats } from './snippets.js';
import { fixtures } from '../tools/snippet-check.mjs';

const request = {
  method: 'post', url: 'https://api.test/sendproof/payments?x=1',
  headers: { Authorization: 'Bearer private', 'Content-Type': 'application/json' },
  body: JSON.stringify({ note: 'a <b> & "c" \'d\'', amount: 4.5, ok: true, none: null, tags: ['x'] }),
};
const lexer = id => snippetFormats.find(format => format.id === id).lexer;
const html = id => highlightSnippet(formatRequest(id, request, []), lexer(id));
/** The text of highlighted HTML: tags removed, entities decoded. */
const plain = markup => markup.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const has = (markup, kind, text) => markup.includes(`<span class="tok-${kind}">${text}</span>`);

test('colouring never changes the text, for every language and every awkward request', () => {
  for (const { id } of snippetFormats) {
    for (const [name, fixture] of Object.entries(fixtures)) {
      const text = formatRequest(id, fixture, []);
      assert.equal(plain(highlightSnippet(text, lexer(id))), text, `${id} / ${name} round-trips`);
    }
  }
});

test('markup in a request can never become markup in the sample', () => {
  const hostile = { ...request, url: 'https://api.test/x?q=<script>alert(1)</script>', headers: { 'X-A': '"><img src=x onerror=alert(1)>' }, body: '<script>"</script>' };
  for (const { id } of snippetFormats) {
    const out = highlightSnippet(formatRequest(id, hostile, []), lexer(id));
    assert.doesNotMatch(out.replace(/<\/?span[^>]*>/g, ''), /<(?!\/?span)/, `${id} has no stray tags`);
    assert.doesNotMatch(out, /<script|<img/);
  }
});

test('cURL colours the command, flags, URLs, strings and the JSON body', () => {
  const out = html('curl');
  assert.ok(has(out, 'f', 'curl'));
  for (const flag of ['--request', '--url', '--header', '--data-raw']) assert.ok(has(out, 'fl', flag), flag);
  assert.ok(has(out, 'u', 'https://api.test/sendproof/payments?x=1'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'n', '4.5'));
  assert.ok(has(out, 'b', 'true') && has(out, 'b', 'null'));
  assert.match(out, /<span class="tok-s">&#39;Content-Type: application\/json&#39;<\/span>/);
});

test('cURL keeps a body with apostrophes together as JSON', () => {
  const out = highlightSnippet(formatRequest('curl', { ...request, body: JSON.stringify({ note: "it's" }) }, []), 'bash');
  assert.ok(has(out, 'k', '&quot;note&quot;'));
  assert.match(out, /tok-s">&quot;it&#39;\\&#39;&#39;s&quot;/);
});

test('JavaScript colours keywords, calls, object keys, strings, URLs and numbers', () => {
  const out = html('fetch');
  for (const word of ['const', 'await']) assert.ok(has(out, 'kw', word), word);
  assert.ok(has(out, 'f', 'fetch') && has(out, 'f', 'stringify'));
  assert.ok(has(out, 'k', '&quot;Content-Type&quot;'));
  assert.ok(has(out, 'u', 'https://api.test/sendproof/payments?x=1'));
  assert.ok(has(out, 'n', '4.5') && has(out, 'b', 'true'));
});

test('JavaScript template literals and comments', () => {
  const out = highlightSnippet('// hi\nconst a = `x ${1}`; /* b */', 'javascript');
  assert.ok(has(out, 'c', '// hi') && has(out, 'c', '/* b */'));
  assert.ok(has(out, 's', '`x ${1}`'));
});

test('Python colours its comment, raw triple quotes with embedded JSON, and dictionary keys', () => {
  const out = html('python');
  assert.ok(has(out, 'c', '# pip install requests'));
  assert.ok(has(out, 'kw', 'import'));
  assert.ok(has(out, 's', 'r&quot;&quot;&quot;') && has(out, 's', '&quot;&quot;&quot;'));
  assert.ok(has(out, 'k', '&quot;Authorization&quot;'));
  assert.ok(has(out, 'k', '&quot;amount&quot;') && has(out, 'n', '4.5'));
  assert.ok(has(highlightSnippet('x = None or True', 'python'), 'b', 'None'));
});

test('C# colours raw string literals (with JSON), verbatim strings, keywords and types', () => {
  const out = html('csharp');
  assert.ok(has(out, 'kw', 'using') && has(out, 'kw', 'var') && has(out, 'kw', 'await'));
  assert.ok(has(out, 't', 'HttpMethod') && has(out, 'f', 'SendAsync'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  const verbatim = highlightSnippet('var a = @"C:\\dir ""x""";', 'csharp');
  assert.ok(has(verbatim, 's', '@&quot;C:\\dir &quot;&quot;x&quot;&quot;&quot;'));
});

test('Go colours its raw backtick string with JSON, package, func and nil', () => {
  const out = html('go');
  assert.ok(has(out, 'kw', 'package') && has(out, 'kw', 'func') && has(out, 'kw', 'defer'));
  assert.ok(has(out, 'b', 'nil'));
  assert.ok(has(out, 's', '`') && has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'f', 'NewRequest'));
});

test('Java colours text blocks, annotations of types and calls', () => {
  const out = html('java');
  assert.ok(has(out, 'kw', 'public') && has(out, 'kw', 'class') && has(out, 'kw', 'throws'));
  assert.ok(has(out, 't', 'HttpClient') && has(out, 'f', 'newBuilder'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
});

test('Kotlin colours val, fun, raw strings and calls', () => {
  const out = html('kotlin');
  assert.ok(has(out, 'kw', 'fun') && has(out, 'kw', 'val') && has(out, 'kw', 'import'));
  assert.ok(has(out, 'f', 'trimIndent') && has(out, 'f', 'setBody'));
  assert.ok(has(out, 'c', '// Gradle: implementation(&quot;io.ktor:ktor-client-cio:3.0.0&quot;)'));
});

test('PHP colours the open tag, variables, a nowdoc with JSON and single-quoted strings', () => {
  const out = html('php');
  assert.ok(has(out, 'kw', '&lt;?php'));
  assert.ok(has(out, 'v', '$client') && has(out, 'v', '$response'));
  assert.ok(has(out, 's', '&lt;&lt;&lt;&#39;JSON&#39;'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'b', 'false'));
});

test('Ruby colours heredocs with JSON, the chomp call, keywords and puts', () => {
  const out = html('ruby');
  assert.ok(has(out, 'kw', 'require') && has(out, 'kw', 'do') && has(out, 'kw', 'end'));
  assert.ok(has(out, 's', '&lt;&lt;~&#39;JSON&#39;'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'f', 'puts'));
});

test('Rust colours raw strings with JSON, macros and keywords', () => {
  const out = html('rust');
  assert.ok(has(out, 'kw', 'fn') && has(out, 'kw', 'let') && has(out, 'kw', 'use'));
  assert.ok(has(out, 's', 'r#&quot;') && has(out, 's', '&quot;#'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'f', 'println'));
  assert.ok(has(out, 'c', '// Cargo.toml: reqwest = { version = &quot;0.12&quot;, features = [&quot;blocking&quot;] }'));
});

test('PowerShell colours variables, cmdlets, here-strings with JSON and hashtable keys', () => {
  const out = html('powershell');
  assert.ok(has(out, 'v', '$headers') || has(out, 'v', '$body'));
  assert.ok(has(out, 'f', 'Invoke-RestMethod'));
  assert.ok(has(out, 's', '@&#39;'));
  assert.ok(has(out, 'k', '&quot;amount&quot;'));
  assert.ok(has(out, 'k', 'ContentType'));
  const extra = highlightSnippet('<# note #>\n$x = $true # why\nGet-Item -Path .', 'powershell');
  assert.ok(has(extra, 'c', '&lt;# note #&gt;') && has(extra, 'c', '# why'));
  assert.ok(has(extra, 'b', '$true') && has(extra, 'fl', '-Path'));
});

test('.http colours the method, URL, header names and JSON body', () => {
  const out = highlightSnippet(formatRequest('http', request, []), 'http');
  assert.ok(has(out, 'kw', 'POST') && has(out, 'u', 'https://api.test/sendproof/payments?x=1'));
  assert.ok(has(out, 'k', 'content-type') && has(out, 'p', ':'));
  assert.ok(has(out, 'n', '4.5'));
});

test('strings holding JSON are coloured as JSON, other strings stay strings', () => {
  assert.ok(has(highlightSnippet('x = r"""{"a": 1}"""', 'python'), 'k', '&quot;a&quot;'));
  assert.equal(has(highlightSnippet('x = "{not json}"', 'python'), 'k', '&quot;a&quot;'), false);
  assert.ok(has(highlightSnippet('x = "{not json}"', 'python'), 's', '&quot;{not json}&quot;'));
});

test('the Try it placeholders survive: zzph tokens stay in one piece with their quotes', () => {
  const out = highlightSnippet(formatRequest('python', { ...request, headers: { Cookie: 'zzph0zz' } }, []).replace('REDACTED', 'zzph0zz'), 'python');
  assert.match(out, /(?:&quot;|")?zzph(\d+)zz(?:&quot;|")?/);
  assert.match(out.replace(/(?:&quot;|&#39;|")?zzph(\d+)zz(?:&quot;|")?/g, '<ph>'), /<ph>/);
  // A placeholder inside a URL stays inside the URL token.
  assert.ok(has(highlightSnippet("curl 'https://api.test/a/zzph1zz'", 'bash'), 'u', 'https://api.test/a/zzph1zz'));
});

test('without a grammar only the JSON body is coloured, as before', () => {
  const out = highlightSnippet('curl x\n{\n  "a": 1\n}');
  assert.ok(out.startsWith('curl x') && has(out, 'k', '&quot;a&quot;') && has(out, 'n', '1'));
  assert.equal(highlightSnippet('plain <b>', undefined), 'plain &lt;b&gt;');
  assert.equal(highlightSnippet('plain <b>', 'cobol'), 'plain &lt;b&gt;');
});

test('highlightJson still marks keys, strings, numbers, literals and punctuation', () => {
  const out = highlightJson('{"a": [1, "x", true, null]}');
  assert.ok(has(out, 'k', '&quot;a&quot;') && has(out, 'n', '1') && has(out, 's', '&quot;x&quot;') && has(out, 'b', 'true') && has(out, 'p', '['));
});

test('every picker language has a grammar that colours something', () => {
  for (const { id, lexer: grammar } of pickerFormats) assert.match(highlightSnippet(formatRequest(id, request, []), grammar), /tok-kw|tok-f|tok-fl/, id);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_FALSE_LANGUAGES, bindingOf, chooseLanguage, chosenLanguage, previewFalseSnippet } from './preview-false.js';
import { blockedMarkup } from './result-blocked.js';

const reason = 'Preview unavailable: clears the Redis session';
const route = { method: 'delete', path: '/sessions/{id}' };

test('every binding language has an idiomatic preview: false snippet carrying the reason', () => {
  const snippets = Object.fromEntries(PREVIEW_FALSE_LANGUAGES.map(({ id }) => [id, previewFalseSnippet({ language: id, reason, ...route })]));
  assert.equal(snippets.dotnet, '[SendproofPreview(Enabled = false, Reason = "Clears the Redis session")]');
  assert.equal(snippets.node, `bench.unavailable('DELETE', '/sessions/{id}', { reason: 'Clears the Redis session' }, handler);`);
  assert.equal(snippets.python, '@preview(False, reason="Clears the Redis session")');
  assert.equal(snippets.java, '@SendproofPreview(enabled = false, reason = "Clears the Redis session")');
  assert.equal(snippets.kotlin, 'sendproofPreview(enabled = false, reason = "Clears the Redis session") { delete("/sessions/{id}") { … } }');
  assert.equal(snippets.go, 'bench.HandleUnavailable(mux, "DELETE /sessions/{id}", "Clears the Redis session", handler)');
  assert.equal(snippets.php, `Route::delete('/sessions/{id}', $action)->sendproofPreview(false, 'Clears the Redis session');`);
  assert.equal(snippets.ruby, 'sendproof_no_preview only: :action, reason: "Clears the Redis session"');
  assert.equal(snippets.rust, '.preview_unavailable("DELETE", "/sessions/{id}", "Clears the Redis session")');
  assert.equal(new Set(Object.values(snippets)).size, PREVIEW_FALSE_LANGUAGES.length, 'no two languages share a snippet');
});

test('the framework picks between a language’s idioms', () => {
  const snippet = (language, framework) => previewFalseSnippet({ language, framework, reason, ...route });
  assert.match(snippet('dotnet', 'ASP.NET Core minimal APIs'), /^\.WithSendproofPreview\(enabled: false, reason: "Clears/);
  assert.match(snippet('dotnet', 'ASP.NET Core MVC'), /^\[SendproofPreview\(Enabled = false/);
  assert.match(snippet('node', 'NestJS'), /^@SendproofPreview\('DELETE', '\/sessions\/\{id\}', \{ enabled: false, reason: 'Clears/);
  assert.match(snippet('node', 'Fastify'), /^app\.sendproof\.unavailable\('DELETE'/);
  assert.match(snippet('node', 'Express'), /^bench\.unavailable\('DELETE'/);
  assert.match(snippet('php', 'Symfony'), /^#\[AllowPreview\(false, reason: 'Clears the Redis session'\)\]$/);
  assert.match(snippet('php', 'Laravel'), /->sendproofPreview\(false, /);
});

test('a reason is quoted for the language it is written in', () => {
  const tricky = 'Writes "cache" for $user, it\'s #{x}\nnext';
  assert.equal(previewFalseSnippet({ language: 'node', reason: tricky }), `bench.unavailable('POST', '/path', { reason: 'Writes "cache" for $user, it\\'s #{x}\\nnext' }, handler);`);
  assert.match(previewFalseSnippet({ language: 'kotlin', reason: tricky, method: 'POST', path: '/a/${b}' }), /reason = "Writes \\"cache\\" for \\\$user.*"\) \{ post\("\/a\/\\\$\{b\}"\)/);
  assert.match(previewFalseSnippet({ language: 'ruby', reason: tricky }), /reason: "Writes \\"cache\\" for \$user, it's \\#\{x\}\\nnext"$/);
  assert.match(previewFalseSnippet({ language: 'java' }), /reason = "Writes to a store that can’t roll back"/, 'no reason reads a generic one');
});

test('bindingOf trusts only a known language', () => {
  assert.deepEqual(bindingOf({ binding: { language: 'go', framework: ' chi ' } }), { language: 'go', framework: 'chi' });
  assert.deepEqual(bindingOf({ binding: { language: 'rust' } }), { language: 'rust', framework: '' });
  assert.equal(bindingOf({ binding: { language: 'cobol', framework: 'x' } }), null);
  assert.equal(bindingOf({ binding: 'node' }), null);
  assert.equal(bindingOf({}), null);
  assert.equal(bindingOf(undefined), null);
});

test('the language switch remembers its choice and ignores unknown ids', () => {
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    assert.equal(chosenLanguage(), 'dotnet');
    chooseLanguage('python');
    assert.equal(chosenLanguage(), 'python');
    chooseLanguage('cobol');
    assert.equal(chosenLanguage(), 'python');
  } finally {
    if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original;
  }
});

const blocked = { blocked: { store: 'redis', operation: 'DEL', detail: 'Preview unavailable: this operation writes to Redis' }, status: 409, body: {} };
const op = { method: 'DELETE', path: '/sessions/{id}' };

test('the 409 shows the host’s own snippet when capabilities carry a binding', () => {
  const html = blockedMarkup(blocked, { op, capabilities: { binding: { language: 'python', framework: 'FastAPI' } } });
  assert.match(html, /<span class="blk-lang" data-blk-lang>FastAPI<\/span>/);
  assert.match(html, /<pre lang="en" data-blk-snippet>@preview\(False, reason=&quot;This operation writes to Redis&quot;\)<\/pre>/);
  assert.doesNotMatch(html, /data-blk-lang-select/, 'a known host needs no switch');
});

test('the 409 falls back to a language switch, on .NET until one is chosen', () => {
  const html = blockedMarkup(blocked, { op, capabilities: {} });
  assert.match(html, /<select class="blk-lang-select ltr" data-blk-lang-select aria-label="Language">/);
  assert.match(html, /<option value="dotnet" selected>\.NET<\/option>/);
  assert.equal([...html.matchAll(/<option /g)].length, PREVIEW_FALSE_LANGUAGES.length);
  assert.match(html, /\[SendproofPreview\(Enabled = false/);
  const unknown = blockedMarkup(blocked, { op, capabilities: { binding: { language: 'cobol', framework: 'x' } } });
  assert.match(unknown, /data-blk-lang-select/, 'an unknown language falls back to the switch');
});

test('the capabilities schema and the workbench agree on the binding languages and database.system', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(await readFile(new URL('../spec/capabilities.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.binding.properties.language.enum, PREVIEW_FALSE_LANGUAGES.map(language => language.id));
  assert.deepEqual(schema.properties.binding.required, ['language', 'framework']);
  const object = schema.properties.database.oneOf.find(option => option.type === 'object');
  assert.equal(object.properties.system.type, 'string');
  assert.ok(schema.properties.database.oneOf.some(option => Array.isArray(option.type) && option.type.includes('string')), 'the string form stays valid');
  assert.ok(!schema.required.includes('binding'), 'binding is optional');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { codePicker, getCodeFormat, setCodeFormat } from './code-picker.js';
import { langIcon, langIconIds } from './lang-icons.js';
import { pickerFormats } from './snippets.js';

/** Runs `body` with a fake localStorage (or none) and restores the global afterwards. */
function withStorage(storage, body) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try { return body(); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage;
  }
}
const memory = (initial = {}) => { const data = { ...initial }; return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, data }; };

test('the chosen language is remembered, and only a language the picker offers is accepted', () => {
  assert.equal(withStorage(memory(), getCodeFormat), 'curl');
  const store = memory();
  withStorage(store, () => { setCodeFormat('python'); assert.equal(getCodeFormat(), 'python'); });
  assert.equal(store.data['sendproof-code-language'], 'python');
  assert.equal(withStorage(memory({ 'sendproof-code-language': 'http' }), getCodeFormat), 'curl', '.http is not a picker language');
  assert.equal(withStorage(memory({ 'sendproof-code-language': 'cobol' }), getCodeFormat), 'curl');
});

test('blocked storage only forgets the choice', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  withStorage(blocked, () => { assert.equal(getCodeFormat(), 'curl'); assert.doesNotThrow(() => setCodeFormat('go')); });
});

test('the trigger has the same markup for every language, so it never changes size', () => {
  const shape = markup => markup.replace(/>[^<]*</g, '><').replace(/> </g, '><').replace(/data-lang-icon="[^"]*"/, '').replace(/<path[^>]*>|<g[\s\S]*?<\/g>|<rect[^>]*>/g, '<shape>').replace(/aria-label="[^"]*"|title="[^"]*"/g, '');
  const shapes = new Set(pickerFormats.map(format => shape(codePicker({ id: 'p', value: format.id }))));
  assert.equal(shapes.size, 1, 'one structure for all languages');
  for (const format of pickerFormats) {
    const markup = codePicker({ id: 'p', value: format.id });
    assert.match(markup, /aria-haspopup="listbox"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.ok(markup.includes(format.label));
    assert.ok(markup.includes(format.library));
    assert.match(markup, new RegExp(`aria-label="Language: ${format.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${format.library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
});

test('every language has a decorative mark that paints with currentColor', () => {
  for (const format of pickerFormats) assert.ok(langIconIds.includes(format.icon), `${format.id} has the ${format.icon} mark`);
  for (const id of langIconIds) {
    const svg = langIcon(id);
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /focusable="false"/);
    assert.match(svg, /fill="currentColor"/);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|rgb\(|oklch\(/i, `${id} hard-codes no colour`);
  }
  assert.match(langIcon('no-such-language'), /<svg/, 'an unknown id still draws a generic mark');
});

test('the picker text is localised in English, German and Arabic', async () => {
  for (const id of ['en', 'de', 'ar']) {
    const { strings } = (await import(`./locales/${id}.js`)).default;
    assert.match(strings['code.languageValue'], /\{name\} \{library\}/, id);
  }
});

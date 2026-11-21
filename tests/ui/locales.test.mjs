import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOGUES, LANGUAGES } from '../../ui/i18n.js';

// Every UI catalogue must be complete and safe to format: it has every English key, keeps the
// same {placeholders}, offers every plural form its language needs, keeps shortcut glyphs and
// carries its direction, button widths and date letters. Missing keys would silently fall back
// to English; a lost placeholder would print "{n}" to the user.
const load = id => import(`../../ui/locales/${id}.js`).then(module => module.default);
const en = await load('en');
const names = value => [...new Set(String(value).match(/\{\w+\}/g) ?? [])].filter(name => name !== '{article}').sort();
const glyphs = value => [...String(value).matchAll(/[⌘⌥⇧↵⌫⎋]/g)].map(match => match[0]).sort().join('');

test('the language list has 34 languages, each with a catalogue', () => {
  assert.equal(LANGUAGES.length, 34);
  assert.equal(new Set(LANGUAGES.map(language => language.id)).size, 34, 'ids are unique');
  for (const language of LANGUAGES) {
    assert.ok(CATALOGUES.includes(language.catalogue), `${language.id} names a catalogue`);
    assert.equal(language.dir, ['ar', 'fa', 'he'].includes(language.catalogue) ? 'rtl' : 'ltr', `${language.id} direction`);
  }
});

for (const id of CATALOGUES.filter(id => id !== 'en')) {
  test(`the ${id} catalogue has every English key with the same placeholders`, async () => {
    const catalogue = await load(id);
    const language = LANGUAGES.find(item => item.catalogue === id);
    assert.equal(catalogue.dir, language.dir, `${id} declares dir ${language.dir}`);
    for (const platform of ['mac', 'win']) for (const button of ['preview', 'send']) {
      assert.match(catalogue.widths?.[platform]?.[button] ?? '', /^\d+(\.\d+)?em$/, `${id} widths.${platform}.${button}`);
    }
    assert.ok(catalogue.dateLetters?.day && catalogue.dateLetters?.month && catalogue.dateLetters?.year, `${id} dateLetters`);
    const categories = new Intl.PluralRules(language.id).resolvedOptions().pluralCategories;
    const strings = catalogue.strings;
    const missing = Object.keys(en.strings).filter(key => !Object.hasOwn(strings, key));
    assert.deepEqual(missing, [], `${id} has every key`);
    for (const [key, value] of Object.entries(en.strings)) {
      const own = strings[key];
      if (typeof value === 'string') {
        assert.equal(typeof own, 'string', `${id} ${key} is text`);
        assert.deepEqual(names(own), names(value), `${id} ${key} keeps its placeholders`);
        assert.equal(glyphs(own), glyphs(value), `${id} ${key} keeps its shortcut glyphs`);
      } else {
        assert.equal(typeof own, 'object', `${id} ${key} is a plural entry`);
        for (const category of categories) assert.equal(typeof own[category], 'string', `${id} ${key} has the "${category}" form`);
        // The "other" form carries every placeholder; a "one" form may spell out the number.
        assert.deepEqual(names(own.other), names(value.other), `${id} ${key} keeps its placeholders`);
        for (const [form, text] of Object.entries(own)) {
          for (const name of names(text)) assert.ok(names(value.other).includes(name), `${id} ${key}.${form} uses only known placeholders (${name})`);
        }
      }
    }
  });
}

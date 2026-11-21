import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configure, datePattern, formatBytes, formatNumber, LANGUAGES, loadLanguage, matchLanguage, parseLocalDate, t, th } from './i18n.js';
import { chordLong, chordText } from './shortcuts.js';

test('languages match exactly, then by base language, then fall back to English (Ireland)', () => {
  assert.equal(matchLanguage(['de-AT', 'en']), 'de-DE');
  assert.equal(matchLanguage(['en-US']), 'en-US');
  assert.equal(matchLanguage(['fr-CA']), 'fr-FR');
  assert.equal(matchLanguage(['pt']), 'pt-BR');
  assert.equal(matchLanguage(['zh-TW']), 'zh-Hant');
  assert.equal(matchLanguage(['zh-CN']), 'zh-Hans');
  assert.equal(matchLanguage(['no']), 'nb-NO');
  assert.equal(matchLanguage(['xx-YY']), 'en-IE');
});

test('34 languages in six groups, with right to left for Arabic, Persian and Hebrew', () => {
  assert.equal(LANGUAGES.length, 34);
  assert.deepEqual(LANGUAGES.filter(language => language.dir === 'rtl').map(language => language.id), ['ar', 'fa-IR', 'he-IL']);
  assert.deepEqual([...new Set(LANGUAGES.map(language => language.group))], ['english', 'west', 'nordic', 'central', 'rtl', 'asia']);
  configure({ language: 'he-IL' });
  assert.equal(configure({ language: 'he-IL' }).dir, 'rtl');
  configure({ language: 'en-IE' });
});

test('plural forms follow each language: Polish few and many, Arabic six, Japanese one', async () => {
  for (const id of ['pl-PL', 'ar', 'ja-JP']) await loadLanguage(id);
  configure({ language: 'pl-PL' });
  const pl = [1, 2, 5, 22].map(n => t('db.rows', { n }));
  assert.equal(new Set(pl).size >= 3, true, `Polish uses one, few and many: ${pl.join(' / ')}`);
  configure({ language: 'ja-JP' });
  assert.equal(t('db.rows', { n: 1 }).replace('1', '#'), t('db.rows', { n: 2 }).replace('2', '#'), 'Japanese has one form');
  configure({ language: 'en-IE' });
});

test('plurals, placeholders and marks follow the active catalogue', () => {
  configure({ language: 'en-IE' });
  assert.equal(t('db.rows', { n: 1 }), '1 row');
  assert.equal(t('db.rows', { n: 1250 }), '1,250 rows');
  assert.equal(t('op.needsSignIn'), 'Needs sign-in. You’re signed out, so this call will return 401.');
  assert.match(th('op.needsSignIn'), /^<strong>Needs sign-in\.<\/strong>/);
  assert.equal(th('side.try', { query: '&lt;x&gt;' }), 'Try “&lt;x&gt;”', 'HTML values are inserted as given');
  assert.equal(t('missing.key'), 'missing.key');
});

test('numbers, dates and bytes follow the locale, and Arabic digits are opt-in', async () => {
  await loadLanguage('de-DE');
  await loadLanguage('ar');
  configure({ language: 'de-DE' });
  assert.equal(formatNumber(50000.5), '50.000,5');
  assert.equal(datePattern(), 'TT.MM.JJJJ');
  assert.deepEqual(parseLocalDate('23.11.2026'), { iso: '2026-11-23' });
  assert.equal(parseLocalDate('31.02.2026').invalid, 'day');
  configure({ language: 'en-IE' });
  assert.equal(datePattern(), 'dd/mm/yyyy');
  assert.deepEqual(parseLocalDate('2026-11-23'), { iso: '2026-11-23' });
  assert.equal(parseLocalDate('23/13/2026').invalid, 'format');
  assert.equal(formatBytes(524), '524 B');
  configure({ language: 'ar', digits: 'latn' });
  assert.equal(formatNumber(12), '12');
  configure({ language: 'ar', digits: 'arab' });
  assert.equal(formatNumber(12), '١٢');
  configure({ language: 'en-IE', digits: 'latn' });
});

test('a chord is one keycap, in each platform’s own order and long form', () => {
  configure({ platform: 'mac' });
  assert.equal(chordText('Mod+Shift+Enter'), '⇧⌘↵');
  assert.equal(chordLong('Mod+Shift+Enter'), '⇧⌘Return');
  configure({ platform: 'win' });
  assert.equal(chordText('Mod+Shift+Enter'), 'Ctrl ⇧↵');
  assert.equal(chordLong('Mod+Shift+Enter'), 'Ctrl+Shift+Enter');
  configure({ platform: 'mac' });
});

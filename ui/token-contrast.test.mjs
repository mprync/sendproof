import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Every syntax colour must reach WCAG AA (4.5:1 for normal text) on every surface a code view or
// sample sits on, in both themes. The colours are read from the shipped stylesheets, so a new or
// retuned token that fails breaks this test.
const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const [styles, views, app] = ['styles.css', 'views.css', 'app.css'].map(read);

/** Converts an OKLCH colour to clamped linear sRGB. */
function oklchToLinear(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180);
  const b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map(value => Math.min(1, Math.max(0, value)));
}
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (x, y) => { const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
const parseOklch = text => { const [L, C, h] = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text).slice(1).map(Number); return oklchToLinear(L, C, h); };

/** The custom properties declared in the :root block (light) or the [data-theme="dark"] block. */
function variables(selector) {
  const start = styles.indexOf(`${selector} {`);
  const block = styles.slice(start, styles.indexOf('\n}', start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}
const themes = { light: variables(':root'), dark: variables('[data-theme="dark"]') };
const resolve = (value, theme) => value.startsWith('var(') ? resolve(themes[theme][/var\((--[\w-]+)\)/.exec(value)[1]], theme) : value;

/** Token colours: `.tok-x { color: ... }` for light and `[data-theme="dark"] .tok-x { ... }` for dark. */
function tokenColours(theme) {
  const css = views + app;
  // Rules that start a line only: `.viewer mark .tok-p { color: inherit }` is a search-highlight override.
  const pattern = theme === 'dark' ? /^\[data-theme="dark"\] \.tok-(\w+) \{ color: ([^;]+);/gm : /^\.tok-(\w+) \{ color: ([^;]+);/gm;
  const found = new Map();
  for (const match of css.matchAll(pattern)) found.set(match[1], match[2].trim());
  return found;
}

const SURFACES = ['--raised', '--panel', '--sunken', '--hover', '--selected'];
const KINDS = ['k', 's', 'n', 'b', 'p', 'kw', 'c', 'f', 'fl', 'u', 'v', 't'];

for (const theme of ['light', 'dark']) {
  test(`every syntax colour meets WCAG AA on every code surface in the ${theme} theme`, () => {
    const colours = tokenColours(theme);
    for (const kind of KINDS) {
      // Dark inherits the light value only where the stylesheet defines no dark one (tok-p, tok-c use var()).
      const value = colours.get(kind) ?? tokenColours('light').get(kind);
      assert.ok(value, `.tok-${kind} has a ${theme} colour`);
      const colour = parseOklch(resolve(value, theme));
      for (const surface of SURFACES) {
        const ratio = contrast(colour, parseOklch(resolve(themes[theme][surface], theme)));
        assert.ok(ratio >= 4.5, `.tok-${kind} on ${surface} (${theme}) is ${ratio.toFixed(2)}:1, needs 4.5:1`);
      }
    }
  });
}

test('the contrast arithmetic agrees with known values', () => {
  assert.ok(Math.abs(contrast([0, 0, 0], [1, 1, 1]) - 21) < 1e-9);
  assert.ok(Math.abs(contrast(parseOklch('oklch(1 0 0)'), parseOklch('oklch(0 0 0)')) - 21) < 0.2);
});

// v5 colour tokens. Text tokens need 4.5:1 on every surface they sit on, including their own
// soft background; non-text marks (radio dots, presence dots, borders that carry state) 3:1.
const TEXT_PAIRS = [
  ...['--info', '--required', '--fact', '--t-string', '--t-number', '--t-boolean', '--t-object', '--t-enum', '--accent-text', '--ok', '--warn', '--danger']
    .map(token => [token, ['--bg', '--panel', '--raised']]),
  ['--info', ['--info-soft']], ['--ok', ['--ok-soft']], ['--warn', ['--warn-soft']], ['--danger', ['--danger-soft']], ['--accent-text', ['--accent-soft']],
  ['--text', ['--code-bg', '--accent-soft', '--info-soft', '--warn-soft']], ['--text-2', ['--code-bg', '--info-soft', '--warn-soft']],
  ...['path', 'query', 'header', 'cookie'].map(where => [`--in-${where}`, [`--in-${where}-bg`]]),
];
const MARK_PAIRS = [['--accent', ['--raised', '--accent-soft']], ['--text-3', ['--raised', '--sunken']], ['--ok', ['--raised', '--panel']], ['--warn', ['--raised', '--warn-soft']], ['--danger-line', ['--raised']], ['--mark', ['--panel', '--bg']]];

for (const theme of ['light', 'dark']) {
  test(`every v5 colour token meets WCAG AA in the ${theme} theme`, () => {
    const colour = name => parseOklch(resolve(themes[theme][name] ?? themes.light[name], theme));
    for (const [pairs, minimum] of [[TEXT_PAIRS, 4.5], [MARK_PAIRS, 3]]) {
      for (const [fg, surfaces] of pairs) {
        for (const surface of surfaces) {
          const ratio = contrast(colour(fg), colour(surface));
          assert.ok(ratio >= minimum, `${fg} on ${surface} (${theme}) is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
        }
      }
    }
  });
}

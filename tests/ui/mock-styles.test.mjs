import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const stylesheets = html => [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match => match[1]);

// The approved mocks are the source of truth: the workbench ships their stylesheets unchanged,
// and workbench-only rules live in ui/app.css.
test('the workbench uses the approved mock stylesheets byte for byte', async () => {
  for (const name of ['styles.css', 'views.css']) {
    const [ui, mock] = await Promise.all([read(`ui/${name}`), read(`mocks/${name}`)]);
    assert.equal(ui, mock, `ui/${name} matches mocks/${name}`);
  }
});

test('the v4 rules live in styles.css and views.css, with no separate v4.css', async () => {
  for (const folder of ['mocks', 'ui']) {
    const files = await readdir(new URL(`../../${folder}/`, import.meta.url));
    assert.deepEqual(files.filter(name => /^v4\.css$/i.test(name)), [], `${folder} has no v4.css`);
  }
});

test('the mock page and the workbench load only the shared stylesheets', async () => {
  assert.deepEqual(stylesheets(await read('mocks/workbench.html')), ['styles.css', 'views.css']);
  assert.deepEqual(stylesheets(await read('ui/index.html')), ['styles.css', 'views.css', 'app.css', 'dialog.css']);
});

// An earlier crumb reserves min(--crumb-parent-min, its own width): a flat 5rem floor left a gap
// before the chevron when the text was shorter. CSS cannot measure text (min() takes no
// max-content and calc-size() is missing from Firefox and Safari), so ui/crumb-fit.js sets --nat.
test('an earlier crumb reserves at most its measured natural width, with the flat stub until measured', async () => {
  const css = await read('ui/app.css');
  assert.match(css, /\.ctx-bar \.crumbs li:not\(:last-child\) \{ flex: 0 1000 auto; min-inline-size: min\(var\(--crumb-parent-min\), var\(--nat, var\(--crumb-parent-min\)\)\); \}/);
  assert.doesNotMatch(css, /calc-size/, 'one mechanism: the measurement, not a browser-specific path');
});

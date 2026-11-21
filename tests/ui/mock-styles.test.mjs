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
  assert.deepEqual(stylesheets(await read('ui/index.html')), ['styles.css', 'views.css', 'app.css']);
});

// An earlier crumb reserves min(--crumb-parent-min, its own width): a flat 5rem floor left a gap
// before the chevron when the text was shorter (min() cannot take max-content, calc-size() can).
test('an earlier crumb reserves at most its own width, with the flat floor as the fallback', async () => {
  const css = await read('ui/app.css');
  const floor = css.match(/\.ctx-bar \.crumbs li:not\(:last-child\) \{[^}]*min-inline-size: var\(--crumb-parent-min\)/);
  assert.ok(floor, 'the flat floor stays as the fallback');
  assert.match(css, /@supports \(min-inline-size: calc-size\(max-content, size\)\)\s*\{\s*\.ctx-bar \.crumbs li:not\(:last-child\) \{ min-inline-size: calc-size\(max-content, min\(size, var\(--crumb-parent-min\)\)\); \}/);
});

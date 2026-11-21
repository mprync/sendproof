import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LARGE_LINES, buildJsonLines, codeLine, jsonView, labelOf, visibleLines } from './json-view.js';

const payment = { id: 'a', number: 'PAY-2026-0042', amount: 5, debit: { name: 'Operating EUR', iban: 'IE29', tags: [{ k: 1 }] }, history: [{ at: 1, by: { name: 'Ada' } }] };

test('every object and array is open by default, with a fold for each below the root', () => {
  const model = buildJsonLines({ body: payment });
  assert.equal(model.large, false);
  assert.equal(model.initiallyFolded.size, 0);
  assert.ok(model.branches.size >= 4);
  assert.equal(visibleLines(model.lines, model.initiallyFolded).length, model.lines.length);
});

test('a body over the line limit starts collapsed below the second level', () => {
  const items = Array.from({ length: 400 }, (_, index) => ({ id: index, number: `PAY-${index}`, debit: { name: 'Operating EUR', iban: 'IE29', tags: [1, 2, 3, 4] } }));
  const model = buildJsonLines({ body: { items, page: 1 } });
  assert.ok(model.lines.length > LARGE_LINES);
  assert.equal(model.large, true);
  const folded = [...model.initiallyFolded].map(id => model.lines.find(line => line.id === id));
  assert.ok(folded.length > 0 && folded.every(line => line.depth >= 2), 'only nodes at depth 2 and below fold');
  const open = model.lines.filter(line => line.fold && !model.initiallyFolded.has(line.id));
  assert.ok(open.every(line => line.depth <= 1), 'the root and its direct children stay open');
  assert.ok(visibleLines(model.lines, model.initiallyFolded).length < model.lines.length / 2);
  const view = jsonView({ items, page: 1 });
  assert.match(view.html, /Large response \(/);
  assert.match(view.html, /objects below the second level start collapsed/);
  assert.equal(view.large, true);
});

test('a collapsed node shows its size and a label', () => {
  const model = buildJsonLines({ body: { rows: Array.from({ length: 800 }, (_, index) => ({ number: `PAY-${index}`, parts: { a: 1, b: 2 }, more: [1] })) } });
  const folded = model.lines.find(line => line.path?.join('.') === 'rows.0.parts');
  assert.ok(model.initiallyFolded.has(folded.id));
  assert.equal(folded.folded.find(token => token.kind === 'folded').text, '2 keys');
  const row = model.lines.find(line => line.path?.join('.') === 'rows.0');
  assert.match(row.folded.find(token => token.kind === 'folded').text, /^3 keys · PAY-0$/);
  const array = model.lines.find(line => line.path?.join('.') === 'rows.0.more');
  assert.equal(array.fold, undefined, 'a short list of scalars is one line with nothing to fold');
});

test('labels come from number, name, reference, display name, IBAN or id, in that order', () => {
  assert.equal(labelOf({ id: 'x', iban: 'IE29', name: 'Operating', number: 'N-1' }), 'N-1');
  assert.equal(labelOf({ id: 'x', iban: 'IE29', name: 'Operating' }), 'Operating');
  assert.equal(labelOf({ id: 'x', iban: 'IE29' }), 'IE29');
  assert.equal(labelOf({ id: 7 }), '7');
  assert.equal(labelOf({ other: 1 }), '');
  assert.equal(labelOf([1, 2]), '');
});

test('a static viewer renders open and offers Collapse all only when something can fold', () => {
  const view = jsonView(payment, { label: 'Example' });
  assert.equal(view.foldable, true);
  assert.doesNotMatch(view.html, /class="folded"/);
  assert.match(view.html, /aria-label="Collapse debit"/);
  assert.equal(jsonView({ a: 1 }).foldable, false);
});

test('line numbers are generated content, never text a selection or copy could pick up', () => {
  const [line] = buildJsonLines({ body: { a: 1 } }).lines;
  const markup = codeLine(line, 12, false, 'x');
  assert.match(markup, /<span class="no" data-n="12" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(markup.replace(/<[^>]+>/g, ''), /12/, 'the number is not in the text content');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { INDENT, joinCodeLines, selectedCode } from './code-copy.js';

test('copied lines are joined with newlines and get their indentation back', () => {
  const lines = [{ text: '{', depth: 0, whole: true }, { text: '"id": 1,', depth: 1, whole: true }, { text: '"tags": [', depth: 1, whole: true },
    { text: '"a"', depth: 2, whole: true }, { text: ']', depth: 1, whole: true }, { text: '}', depth: 0, whole: true }];
  assert.equal(joinCodeLines(lines), '{\n  "id": 1,\n  "tags": [\n    "a"\n  ]\n}');
  assert.equal(INDENT, '  ');
});

test('a selection that starts in the middle of a line keeps that line unindented', () => {
  assert.equal(joinCodeLines([{ text: '1,', depth: 1, whole: false }, { text: '"b": 2', depth: 1, whole: true }]), '1,\n  "b": 2');
});

test('a single line and an empty selection', () => {
  assert.equal(joinCodeLines([{ text: 'x', depth: 0, whole: false }]), 'x');
  assert.equal(joinCodeLines([]), '');
});

test('there is nothing to rebuild without a selection or outside a browser', () => {
  assert.equal(selectedCode(null), null);
  assert.equal(selectedCode({ isCollapsed: true, rangeCount: 0 }), null);
});

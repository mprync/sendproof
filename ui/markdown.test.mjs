import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown } from './markdown.js';

test('a GitHub table renders as a table, with inline markup in its cells', () => {
  const html = markdown('| Role | Can |\n| --- | --- |\n| `admin` | Everything |\n| **support** | Orders and refunds |');
  assert.equal(html, '<div class="md-table"><table><thead><tr><th>Role</th><th>Can</th></tr></thead><tbody>'
    + '<tr><td><code>admin</code></td><td>Everything</td></tr><tr><td><strong>support</strong></td><td>Orders and refunds</td></tr></tbody></table></div>');
});

test('a table right after a paragraph line keeps the paragraph', () => {
  const html = markdown('Roles are the scopes an operation lists:\n| Role | Can |\n|---|---|\n| admin | All |');
  assert.match(html, /^<p>Roles are the scopes an operation lists:<\/p><div class="md-table"><table>/);
  assert.match(html, /<td>admin<\/td><td>All<\/td>/);
});

test('column alignment, escaped pipes, short rows and rows without outer pipes', () => {
  const html = markdown('Name | Rule | Count\n:--- | :---: | ---:\na \\| b | x\nc | y | 3');
  assert.match(html, /<th>Name<\/th><th style="text-align:center">Rule<\/th><th style="text-align:end">Count<\/th>/);
  assert.match(html, /<tr><td>a \| b<\/td><td style="text-align:center">x<\/td><td style="text-align:end"><\/td><\/tr>/);
  assert.match(html, /<td style="text-align:end">3<\/td>/);
});

test('cells are escaped, and text with pipes but no delimiter row stays a paragraph', () => {
  assert.match(markdown('| a |\n| - |\n| <b>x</b> |'), /<td>&lt;b&gt;x&lt;\/b&gt;<\/td>/);
  assert.equal(markdown('a | b\nc | d'), '<p>a | b c | d</p>');
  assert.equal(markdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
});

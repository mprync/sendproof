import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFieldModules } from '../../ui/field-modules.js';

globalThis.location = new URL('https://example.test/team/bench/');

test('trusted host modules register once across repeated sign-in and discovery', async () => {
  const loaded = [];
  const load = async url => {
    loaded.push(url);
    return { fieldRenderers: [{ predicate: () => false, render() {} }] };
  };
  await loadFieldModules(['/team/fields.js', '/team/fields.js'], load);
  await loadFieldModules(['/team/fields.js'], load);
  assert.deepEqual(loaded, ['https://example.test/team/fields.js']);
});

test('rejects an external module before import and explains malformed local exports', async () => {
  await assert.rejects(loadFieldModules(['https://other.test/fields.js'], () => assert.fail()), /API host/);
  await assert.rejects(loadFieldModules(['/broken.js'], async () => ({ fieldRenderers: [{}] })), /fieldRenderers/);
});

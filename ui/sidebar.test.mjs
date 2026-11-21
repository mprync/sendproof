import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNavState, navStorageKey, operationGroups, saveNavState } from './sidebar.js';

const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
};

test('collapsed groups are remembered per API document', () => {
  const storage = memory();
  assert.deepEqual(loadNavState(storage, '/openapi/v1.json'), { ops: {}, models: {} }, 'nothing remembered means every group starts open');
  saveNavState(storage, '/openapi/v1.json', { ops: { Accounts: true, Payments: false }, models: { lists: false } });
  assert.deepEqual(loadNavState(storage, '/openapi/v1.json'), { ops: { Accounts: true, Payments: false }, models: { lists: false } });
  assert.deepEqual(loadNavState(storage, '/openapi/v2.json'), { ops: {}, models: {} }, 'another API has its own state');
  assert.notEqual(navStorageKey('/a'), navStorageKey('/b'));
});

test('unreadable or blocked storage only forgets the choice', () => {
  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadNavState(broken, '/x'), { ops: {}, models: {} });
  assert.doesNotThrow(() => saveNavState(broken, '/x', { ops: {}, models: {} }));
  const odd = memory();
  odd.setItem(navStorageKey('/x'), JSON.stringify({ ops: { A: 'yes', B: true }, models: 7 }));
  assert.deepEqual(loadNavState(odd, '/x'), { ops: { B: true }, models: {} }, 'only booleans are trusted');
  assert.deepEqual(loadNavState(null, '/x'), { ops: {}, models: {} });
});

test('operation groups follow the document\'s tag order, then tags only operations mention', () => {
  const op = (title, group) => ({ title, group });
  const groups = operationGroups([op('a', 'Payments'), op('b', 'Accounts'), op('c', 'Extra'), op('d', 'Accounts')], { tags: [{ name: 'Accounts' }, { name: 'Unused' }, { name: 'Payments' }] });
  assert.deepEqual(groups.map(([name, items]) => [name, items.length]), [['Accounts', 2], ['Payments', 1], ['Extra', 1]]);
});

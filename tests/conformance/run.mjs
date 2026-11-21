import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { parseArgs } from 'node:util';
import { standard, alternates } from './protocol.mjs';
import { platformCommand, root, withFixture } from './host.mjs';
import { engines, withFixtureDatabase } from './database.mjs';
import { dataStores } from './data-stores.mjs';
import { sharedRules } from './shared-rules.mjs';

const manifest = JSON.parse(await readFile(new URL('./bindings.json', import.meta.url), 'utf8'));
const { values, positionals } = parseArgs({ options: {
  list: { type: 'boolean' }, matrix: { type: 'boolean' }, 'port-offset': { type: 'string' },
  database: { type: 'string' },
  'local-tests': { type: 'boolean' },
}, allowPositionals: true });
const portOffset = Number(values['port-offset'] ?? 0);
assert(Number.isSafeInteger(portOffset), '--port-offset must be an integer');
assert(!values.database || engines.has(values.database), 'Unknown database selector');
const candidates = positionals.length
  ? positionals.map(id => {
    const binding = manifest.bindings.find(entry => entry.id === id);
    assert(binding, `Unknown binding: ${id}`);
    return binding;
  })
  : manifest.bindings;
const selected = candidates.filter(entry => !values.database || entry.database === values.database);
assert(selected.length, 'The manifest must contain at least one binding');
assert.equal(new Set(manifest.bindings.map(entry => entry.id)).size, manifest.bindings.length, 'Duplicate binding IDs');
assert.equal(new Set(manifest.bindings.map(entry => entry.port)).size, manifest.bindings.length, 'Duplicate binding ports');
assert(manifest.bindings.every(entry => engines.has(entry.database)), 'A binding is missing a recognized database');

if (values.list) {
  console.log(selected.map(entry => entry.id).join('\n'));
} else if (values.matrix) {
  // `stores` is a comma-separated list so a workflow can start the data-store services with contains().
  console.log(JSON.stringify({ include: selected.map(({ id, toolchain, database, prepare = '', test: testCommand = '', stores = [] }) =>
    ({ id, toolchain, database, prepare, test: testCommand, stores: stores.join(',') })) }));
} else if (values['local-tests']) {
  for (const binding of selected) {
    if (!binding.test) continue;
    await withFixtureDatabase(binding.database, async database => {
      console.log(`Local tests for ${binding.id} (${binding.database})`);
      const child = spawn(platformCommand('bash'), ['-euo', 'pipefail', '-c', binding.test], {
        cwd: root, stdio: 'inherit', env: { ...process.env, ...database.env },
      });
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, `Local tests failed for ${binding.id} (${signal ?? code})`);
    });
  }
} else {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const kind of ['capabilities', 'preview', 'trace']) {
    const filename = `${kind}.schema.json`;
    ajv.addSchema(JSON.parse(await readFile(new URL(`../../spec/${filename}`, import.meta.url), 'utf8')), filename);
  }
  const schemas = { assert(kind, document) {
    const validate = ajv.getSchema(`${kind}.schema.json`);
    assert(validate(document), ajv.errorsText(validate.errors, { separator: '\n' }));
  } };

  for (const entry of selected) {
    const binding = { ...entry, port: entry.port + portOffset };
    assert(Number.isInteger(binding.port) && binding.port >= 1024 && binding.port <= 65535, 'Invalid fixture port');
    await test(binding.id, { timeout: binding.timeoutMs ?? 150000 }, async t => {
      if (binding.profile === 'treasury') {
        const { runTreasury } = await import('./treasury.mjs');
        await withFixture(binding, 'standard', '', request => runTreasury(t, request, schemas));
        return;
      }
      // The data-store reference fixture is not a binding: it implements only the data-store routes and shared rules.
      if (binding.profile === 'data-stores') {
        await dataStores(t, binding, schemas, request => sharedRules(t, request, schemas, binding));
        return;
      }
      await withFixture(binding, 'standard', '/tenant', async (request, database) => {
        await standard(t, request, schemas, binding, database);
        await sharedRules(t, request, schemas, binding, database);
        await database.verify?.();
      });
      await alternates(t, binding, schemas);
      await dataStores(t, binding, schemas);
    });
  }
}

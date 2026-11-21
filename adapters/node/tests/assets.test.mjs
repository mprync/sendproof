import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(exec);
const packer = fileURLToPath(new URL('../../../tools/pack-ui.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the UI bundle is deterministic, verifiable and removes generated files that are no longer present', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sendproof-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pack = () => execFile(process.execPath, [packer, '--out', directory, '--version', '3.2.1']);
  const path = join(directory, 'manifest.json');
  await pack();
  const original = await readFile(path, 'utf8');
  const { version, bundleHash, files } = JSON.parse(original);
  assert.equal(version, '3.2.1');
  assert.equal(bundleHash, hash(JSON.stringify({ version, files })));
  assert(files['index.html'] && files['app.js']);
  assert(!Object.keys(files).some(name => /(?:\.test\.mjs|^package\.json)$/.test(name)));
  for (const [name, entry] of Object.entries(files)) {
    const bytes = await readFile(join(directory, name));
    assert.equal(bytes.length, entry.bytes, name);
    assert.equal(hash(bytes), entry.sha256, name);
  }

  await writeFile(join(directory, 'obsolete.css'), '/* obsolete bundle asset */');
  await writeFile(path, JSON.stringify({ version, files: { ...files, 'obsolete.css': {} } }));
  await pack();
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(readFile(join(directory, 'obsolete.css')), { code: 'ENOENT' });
});

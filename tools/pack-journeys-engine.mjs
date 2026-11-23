// Copies the journey engine (ui/journeys/, pure ES modules) and its vendored libraries
// (ui/vendor/, built by vendor-journeys-libs.mjs) into @sendproof/cli at build, so the CLI, the
// MCP server and the workbench run the exact same engine code (journeys-build.md, Contract 3).
// Nothing here is rewritten: only copied, dropping the engine's own tests and the vendor README.
//
//   node tools/pack-journeys-engine.mjs --out adapters/node/cli/dist/engine
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('Usage: node tools/pack-journeys-engine.mjs --out <directory>');
const out = values.out;

async function copyJsFiles(from, to, skip = () => false) {
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${from} doesn’t exist. Run "npm run vendor-journeys-libs --prefix tools" first.`);
    throw error;
  }
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.js' || skip(entry.name)) continue;
    await writeFile(join(to, entry.name), await readFile(join(from, entry.name)));
    copied++;
  }
  return copied;
}

const journeys = await copyJsFiles(join(root, 'ui/journeys'), join(out, 'journeys'), name => name.endsWith('.test.mjs'));
const vendor = await copyJsFiles(join(root, 'ui/vendor'), join(out, 'vendor'));
console.log(`Packed the journey engine into ${out}: ${journeys} journeys file(s), ${vendor} vendor file(s).`);

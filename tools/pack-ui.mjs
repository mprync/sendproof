import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const { values } = parseArgs({ options: { out: { type: 'string' }, version: { type: 'string' } } });
const version = values.version ?? process.env.PACKAGE_VERSION ?? '0.1.0-alpha.2';
if (!values.out || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) {
  throw new Error('Usage: node tools/pack-ui.mjs --out <directory> [--version <semver>]');
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const output = resolve(values.out);
if (output === resolve(ui) || output.startsWith(`${resolve(ui)}/`)) {
  throw new Error('Bundle output must be outside the UI source directory.');
}

const assets = new Map();
async function collect(directory = '') {
  const entries = await readdir(join(ui, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collect(name);
    } else if (entry.isFile() && !/(?:\.(?:test|spec)\.[^.]+|(?:^|\/)package(?:-lock)?\.json)$/.test(name)) {
      const contentType = mimeTypes[extname(name)];
      if (contentType) assets.set(name, { buffer: await readFile(join(ui, name)), contentType });
    }
  }
}

await collect();
if (!assets.has('index.html') || assets.has('manifest.json')) {
  throw new Error('The UI must supply index.html. The packer reserves manifest.json.');
}

const files = Object.fromEntries([...assets.keys()].sort().map(name => {
  const { buffer, contentType } = assets.get(name);
  return [name, { sha256: sha256(buffer), bytes: buffer.length, contentType }];
}));
const bundleHash = sha256(JSON.stringify({ version, files }));
let previousFiles = {};
try {
  previousFiles = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).files;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const name of Object.keys(previousFiles)) {
  if (assets.has(name) || !name.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes('\\'))) continue;
  await rm(join(output, name), { force: true });
}
for (const [name, { buffer }] of assets) {
  const destination = join(output, name);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
}
await writeFile(join(output, 'manifest.json'), JSON.stringify({ version, bundleHash, files }, null, 2) + '\n');
console.log(`Packed ${assets.size} assets for ${version} (${bundleHash})`);

// npm: the thirteen @sendproof/* workspaces in adapters/node, packed with `npm pack` from stamped copies.
//
// pack    builds the workspaces (strict TypeScript to ESM + .d.ts, UI bundle into core/assets), copies
//         each package's publishable files into ctx.work, stamps version, repository, homepage, bugs and
//         internal dependency versions, checks exports/types/files/engines, and packs a tarball.
// verify  installs every tarball (never the workspace) into a fresh project, type-checks an import of
//         each public entry point with NodeNext resolution, and serves the workbench from Express.

import { copyFile, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exists, output, readJson, removeDir, require, root, run, smokeServe, tempDir, which, writeJson,
} from './lib.mjs';

export const title = 'npm';

const NODE = join(root, 'adapters', 'node');
// Dependency order: everything needs core; drizzle also needs sqlite. The data-store guards (redis,
// dynamodb, mongodb) need only core.
const PACKAGES = ['core', 'sqlite', 'express', 'fastify', 'hono', 'nestjs', 'drizzle', 'knex', 'typeorm', 'prisma',
  'redis', 'dynamodb', 'mongodb'];

/** The npm CLI cache stays in the repository so sandboxed runs never write to the home directory. */
const npmEnv = () => ({ npm_config_cache: process.env.npm_config_cache ?? join(root, 'artifacts', 'npm-cache'),
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' });

export async function available() {
  return which('npm') ? null : 'npm is not on PATH';
}

export async function pack(ctx) {
  const env = { ...npmEnv(), PACKAGE_VERSION: ctx.version };
  if (!await exists(join(NODE, 'node_modules', '.package-lock.json'))) {
    ctx.log('installing workspace dependencies (npm ci)');
    await run('npm', ['ci', '--ignore-scripts'], { cwd: NODE, env, label: 'npm' });
  }
  ctx.log('building TypeScript and the UI bundle');
  await run('npm', ['run', 'build'], { cwd: NODE, env, label: 'npm' });

  const manifests = new Map();
  for (const dir of PACKAGES) manifests.set(dir, await readJson(join(NODE, dir, 'package.json')));
  const files = [];
  for (const dir of PACKAGES) {
    const source = join(NODE, dir);
    const staged = join(ctx.work, dir);
    const manifest = manifests.get(dir);
    checkManifest(dir, manifest, manifests);

    await mkdir(staged, { recursive: true });
    for (const entry of manifest.files) await cp(join(source, entry), join(staged, entry), { recursive: true });
    await copyFile(join(source, 'README.md'), join(staged, 'README.md'));
    await copyFile(join(root, 'LICENSE'), join(staged, 'LICENSE'));
    await removeBuildInfo(staged);
    await writeJson(join(staged, 'package.json'), stamp(ctx, dir, manifest));
    await checkExports(dir, staged, manifest);

    const [packed] = JSON.parse(await output('npm', ['pack', '--json', '--pack-destination', ctx.out], { cwd: staged, env }));
    const names = packed.files.map(file => file.path);
    for (const required of ['package.json', 'README.md', 'LICENSE']) {
      require(names.includes(required), `${packed.filename} is missing ${required}`);
    }
    require(!names.some(name => /^(src|tests?)\//.test(name) || name.endsWith('.tsbuildinfo')),
      `${packed.filename} contains source, tests or build info`);
    if (dir === 'core') require(names.includes('assets/manifest.json') && names.includes('assets/index.html'),
      `${packed.filename} is missing the embedded workbench UI`);
    ctx.log(`${packed.filename} (${packed.entryCount} files, ${packed.size} bytes)`);
    files.push(packed.filename);
  }
  return files;
}

/** Static metadata that must be committed in each workspace manifest. */
function checkManifest(dir, manifest, manifests) {
  const name = `adapters/node/${dir}/package.json`;
  require(manifest.name === `@sendproof/${dir}`, `${name}: unexpected name ${manifest.name}`);
  require(manifest.type === 'module', `${name}: packages are ESM and need "type": "module"`);
  require(typeof manifest.description === 'string' && manifest.description.length > 10, `${name}: missing description`);
  require(manifest.license === 'MIT', `${name}: license must be MIT`);
  require(Array.isArray(manifest.keywords) && manifest.keywords.length >= 3, `${name}: needs keywords`);
  require(Array.isArray(manifest.files) && manifest.files.includes('dist'), `${name}: "files" must list dist`);
  require(manifest.exports?.['.']?.types && manifest.exports['.'].default, `${name}: exports["."] needs types and default`);
  require(manifest.types === manifest.exports['.'].types, `${name}: top-level "types" must match exports["."].types`);
  const floor = minimumNode(manifest.engines?.node);
  require(floor, `${name}: engines.node must set a minimum Node version`);
  for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(id => id.startsWith('@sendproof/'))) {
    const needed = minimumNode(manifests.get(dependency.slice('@sendproof/'.length))?.engines?.node);
    require(needed && compare(floor, needed) >= 0,
      `${name}: engines.node (${manifest.engines.node}) admits Node versions ${dependency} (${needed.join('.')}+) does not support`);
  }
}

/** Lowest Node version a simple engines range (>=X.Y, ^X.Y, alternatives joined by ||) admits. */
function minimumNode(range) {
  if (typeof range !== 'string') return null;
  const floors = range.split('||').map(part => /(?:>=|\^)\s*(\d+)\.(\d+)/.exec(part.trim())).filter(Boolean)
    .map(match => [Number(match[1]), Number(match[2])]);
  return floors.length ? floors.sort(compare)[0] : null;
}

function compare([majorA, minorA], [majorB, minorB]) {
  return majorA - majorB || minorA - minorB;
}

function stamp(ctx, dir, manifest) {
  const { url } = ctx.repository;
  const pin = dependencies => dependencies && Object.fromEntries(Object.entries(dependencies)
    .map(([id, range]) => [id, id.startsWith('@sendproof/') ? ctx.version : range]));
  const { scripts, devDependencies, ...published } = manifest;
  return {
    ...published,
    version: ctx.version,
    author: ctx.metadata.authors.join(', '),
    homepage: `${url}/tree/main/adapters/node/${dir}#readme`,
    repository: { type: 'git', url: `git+${url}.git`, directory: `adapters/node/${dir}` },
    bugs: { url: ctx.metadata.issues },
    dependencies: pin(manifest.dependencies),
    publishConfig: { access: 'public', provenance: true },
  };
}

/** Every export target must exist, and every JavaScript entry point must ship its declarations. */
async function checkExports(dir, staged, manifest) {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    for (const condition of ['types', 'default']) {
      require(typeof target[condition] === 'string', `@sendproof/${dir} exports["${subpath}"] has no ${condition}`);
      require(await exists(join(staged, target[condition])), `@sendproof/${dir} exports["${subpath}"].${condition} (${target[condition]}) is not built`);
    }
    require(target.types.endsWith('.d.ts'), `@sendproof/${dir} exports["${subpath}"].types must be a .d.ts file`);
  }
}

async function removeBuildInfo(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) await rm(join(entry.parentPath, entry.name));
  }
}

export async function verify(ctx) {
  const consumer = await tempDir('npm-consumer');
  try {
    const tarballs = (await readdir(ctx.out)).filter(name => name.endsWith('.tgz')).map(name => join(ctx.out, name));
    require(tarballs.length === PACKAGES.length, `expected ${PACKAGES.length} tarballs in ${ctx.out}`);
    await writeJson(join(consumer, 'package.json'), { name: 'sendproof-npm-consumer', private: true, type: 'module' });
    ctx.log(`installing ${tarballs.length} tarballs and their peers into ${consumer}`);
    // npm installs required peers (Express, Fastify, Nest, Prisma client, ...) automatically.
    await run('npm', ['install', '--no-package-lock', '--ignore-scripts', ...tarballs, 'express@5', 'typescript@5.9.3', '@types/node@22', '@types/express@5'],
      { cwd: consumer, env: npmEnv(), label: 'npm consumer' });

    const installed = await readJson(join(consumer, 'node_modules', '@sendproof', 'core', 'package.json'));
    require(installed.version === ctx.version, `consumer resolved @sendproof/core ${installed.version}, not ${ctx.version}`);

    // Type-check one import per public entry point the way an application compiles it.
    const imports = [];
    for (const dir of PACKAGES) {
      const manifest = await readJson(join(consumer, 'node_modules', '@sendproof', dir, 'package.json'));
      for (const subpath of Object.keys(manifest.exports)) {
        const specifier = `@sendproof/${dir}${subpath === '.' ? '' : subpath.slice(1)}`;
        imports.push(`import * as m${imports.length} from '${specifier}';\nvoid m${imports.length};`);
      }
    }
    await writeFile(join(consumer, 'check.ts'), `${imports.join('\n')}\n`);
    await writeJson(join(consumer, 'tsconfig.json'), { compilerOptions: {
      module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, noEmit: true,
      skipLibCheck: true, types: ['node'] }, files: ['check.ts'] });
    await run(process.execPath, [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
      { cwd: consumer, label: 'tsc consumer' });

    // Every runtime entry point loads, except those that need a generated Prisma client or Nest's reflection setup.
    await writeFile(join(consumer, 'load.mjs'), `${PACKAGES.filter(dir => !['prisma', 'nestjs'].includes(dir))
      .map(dir => `await import('@sendproof/${dir}');`).join('\n')}\nconsole.log('entry points load');\n`);
    await run(process.execPath, ['load.mjs'], { cwd: consumer, label: 'node consumer' });

    await writeFile(join(consumer, 'app.mjs'), `import express from 'express';
import { sendproof } from '@sendproof/express';

const app = express();
app.use(express.json());
app.use(sendproof({ apiName: 'npm consumer', environment: 'development' }));
app.get('/openapi.json', (_request, response) => response.json({
  openapi: '3.1.0', info: { title: 'npm consumer', version: '1.0.0' },
  paths: { '/ping': { get: { responses: { 200: { description: 'pong' } } } } },
}));
app.get('/ping', (_request, response) => response.send('pong'));
app.listen(Number(process.env.PORT), '127.0.0.1');
`);
    await smokeServe({ label: 'npm', command: process.execPath, args: ['app.mjs'], cwd: consumer, env: { NODE_ENV: 'development' } });
    ctx.log('Express consumer served the workbench and its OpenAPI document from the installed tarballs');
  } finally {
    if (!ctx.keep) await removeDir(consumer);
    else ctx.log(`kept ${consumer}`);
  }
}

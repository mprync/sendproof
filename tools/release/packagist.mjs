// Packagist packaging: one ZIP per PHP package, each holding exactly the tree to commit to that
// package's split (mirror) repository root. Packagist reads composer.json from a repository root, so
// the publish job pushes the unzipped tree to the mirror, tags it, and Packagist picks it up.
//
// Output (artifacts/packages/packagist/):
//   testbench-core-<semver>.zip, testbench-laravel-<semver>.zip, testbench-symfony-<semver>.zip
//
// The ZIPs deliberately carry no "version" in composer.json: Packagist takes versions from git tags
// and `composer validate --strict` warns when the field is present. Composer's artifact repository,
// however, needs a version to read from the archive itself, so `verify` rebuilds throwaway copies
// of these ZIPs with the version added and installs from those.

import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  exists, freePort, output, readJson, removeDir, require, root, run, smokeServe, stage, tempDir,
  which, writeJson,
} from './lib.mjs';

export const title = 'Packagist';

/** Packages in dependency order: core first, because laravel and symfony require it. */
const PACKAGES = [
  { dir: 'core', name: 'testbench/core' },
  { dir: 'laravel', name: 'testbench/laravel' },
  { dir: 'symfony', name: 'testbench/symfony' },
];
const SIBLING = 'testbench/core';
const here = fileURLToPath(new URL('.', import.meta.url));

export async function available() {
  if (!which('php')) return 'php is not on PATH (PHP 8.2+ with ext-zip is required)';
  if (!which('composer')) return 'composer is not on PATH (Composer 2.x is required)';
  const zip = await output('php', ['-r', 'echo class_exists("ZipArchive") ? "yes" : "no";']).catch(() => 'no');
  if (zip !== 'yes') return 'PHP is missing the zip extension, which composer archive needs';
  return null;
}

export const registryVersion = versions => versions.semver;

export async function pack(ctx) {
  const archiveName = pkg => `testbench-${pkg.dir}-${ctx.version}.zip`;
  const license = join(root, 'LICENSE');
  require(await exists(license), 'The repository LICENSE file is missing');

  const staged = {};
  for (const pkg of PACKAGES) {
    const target = join(ctx.work, pkg.dir);
    ctx.log(`staging ${pkg.name}`);
    await stage(join(root, 'adapters', 'php', pkg.dir), target, {
      exclude: ['tests', 'phpunit.xml', '.phpunit.result.cache', 'composer.lock'],
    });
    staged[pkg.dir] = target;
    await copyFile(license, join(target, 'LICENSE'));
    await writeFile(join(target, 'README.md'), absoluteLinks(await readFile(join(target, 'README.md'), 'utf8'), pkg, ctx));
    await writeJson(join(target, 'composer.json'), releaseManifest(await readJson(join(target, 'composer.json')), pkg, ctx));
  }

  // The UI bundle is generated and git-ignored, so rebuild it into the staged core rather than trusting
  // whatever copy a developer left in the working tree.
  const ui = join(staged.core, 'resources', 'ui');
  await removeDir(ui);
  ctx.log(`packing the workbench UI ${ctx.version}`);
  await run(process.execPath, [join(root, 'tools', 'pack-ui.mjs'), '--version', ctx.version, '--out', ui], { label: ctx.id });

  const files = [];
  for (const pkg of PACKAGES) {
    ctx.log(`validating ${pkg.name}`);
    await run('composer', ['validate', '--strict', '--no-interaction', '--no-check-lock', '--working-dir', staged[pkg.dir]], { label: ctx.id });
    const file = archiveName(pkg);
    await run('composer', ['archive', '--working-dir', staged[pkg.dir], '--format=zip', `--dir=${ctx.out}`, `--file=${file.replace(/\.zip$/, '')}`, '--no-interaction'], { label: ctx.id });
    await checkArchive(join(ctx.out, file), pkg, ctx);
    files.push(file);
  }
  return files;
}

export async function verify(ctx) {
  const semver = ctx.version;
  const cleanup = [];
  try {
    // 1. Artifact repository: the shipped ZIPs plus the version Composer's artifact repository needs.
    const repository = await tempDir('packagist-repo');
    cleanup.push(repository);
    for (const pkg of PACKAGES) {
      const name = `testbench-${pkg.dir}-${semver}`;
      const extracted = await tempDir(`packagist-${pkg.dir}`);
      cleanup.push(extracted);
      for (const [entry, bytes] of readZip(await readFile(join(ctx.out, `${name}.zip`)))) {
        const target = resolve(extracted, ...entry.split('/'));
        require(target.startsWith(resolve(extracted) + sep), `${name}.zip has an unsafe entry ${entry}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const manifest = await readJson(join(extracted, 'composer.json'));
      await writeJson(join(extracted, 'composer.json'), { ...manifest, version: semver });
      await run('composer', ['archive', '--working-dir', extracted, '--format=zip', `--dir=${repository}`, `--file=${name}`, '--no-interaction'], { label: ctx.id, quiet: true });
    }

    // 2. A fresh Laravel application that depends on testbench/laravel only.
    const project = await tempDir('packagist-consumer');
    cleanup.push(project);
    await cp(join(here, 'consumers', 'packagist'), project, { recursive: true });
    const storage = join(project, 'storage');
    for (const directory of ['framework/cache/data', 'framework/views', 'framework/sessions', 'logs']) {
      await mkdir(join(storage, directory), { recursive: true });
    }
    await mkdir(join(project, 'bootstrap', 'cache'), { recursive: true });
    const database = join(project, 'database.sqlite');
    await writeFile(database, '');
    await writeJson(join(project, 'composer.json'), {
      name: 'test-bench/packagist-consumer',
      type: 'project',
      require: { php: '>=8.2', 'laravel/framework': '^11.0 || ^12.0 || ^13.0', 'testbench/laravel': semver },
      repositories: [{ type: 'artifact', url: repository }],
      config: { 'sort-packages': true, audit: { 'block-insecure': false } },
      'minimum-stability': ctx.versions.prerelease ? 'alpha' : 'stable',
      'prefer-stable': true,
    });
    ctx.log('composer install from the artifact repository');
    await run('composer', ['install', '--no-interaction', '--no-progress', '--prefer-dist', '--working-dir', project], { label: ctx.id });

    // 3. The testbench packages must come from the local ZIPs, never from Packagist.
    const lock = await readJson(join(project, 'composer.lock'));
    for (const pkg of PACKAGES.filter(entry => entry.name !== 'testbench/symfony')) {
      const locked = lock.packages.find(entry => entry.name === pkg.name);
      require(locked, `composer.lock has no ${pkg.name}`);
      const archive = `testbench-${pkg.dir}-${semver}.zip`;
      require(locked.version === semver, `${pkg.name} resolved to ${locked.version}, expected ${semver}`);
      require(locked.dist?.type === 'zip' && !/^[a-z]+:\/\//i.test(locked.dist.url) && locked.dist.url.replaceAll('\\', '/').endsWith(`/${archive}`),
        `${pkg.name} was not installed from ${archive} in the artifact repository (dist: ${JSON.stringify(locked.dist)})`);
      require(!locked.source, `${pkg.name} has a source reference; it was not installed from the artifact repository`);
    }
    require(await exists(join(project, 'vendor', 'testbench', 'core', 'resources', 'ui', 'manifest.json')), 'The installed testbench/core has no embedded UI manifest');

    // 4. Serve it.
    const port = await freePort();
    ctx.log(`serving the consumer on 127.0.0.1:${port}`);
    await smokeServe({
      label: 'packagist consumer',
      command: 'php',
      args: ['-S', `127.0.0.1:${port}`, '-t', 'public', 'public/index.php'],
      cwd: project,
      port,
      env: {
        APP_ENV: 'development',
        APP_DEBUG: 'false',
        APP_KEY: `base64:${Buffer.alloc(32).toString('base64')}`,
        TESTBENCH_ENABLED: 'true',
        TESTBENCH_ENVIRONMENTS: 'development',
        CONSUMER_STORAGE: storage,
        DB_CONNECTION: 'sqlite',
        DB_DATABASE: database,
        CACHE_STORE: 'array',
        SESSION_DRIVER: 'array',
        LOG_CHANNEL: 'stderr',
      },
    });
  } finally {
    if (ctx.keep) ctx.log(`kept ${cleanup.join(', ')}`);
    else for (const directory of cleanup) await removeDir(directory);
  }
}

/**
 * Turns a tracked composer.json into the one that ships in the mirror repository: no path repositories,
 * no dev tooling, siblings pinned to this release, and the repository links stamped from ctx.
 */
function releaseManifest(source, pkg, ctx) {
  const manifest = structuredClone(source);
  delete manifest.repositories;
  delete manifest['require-dev'];
  delete manifest['autoload-dev'];
  delete manifest.scripts;
  for (const [name, constraint] of Object.entries(manifest.require ?? {})) {
    if (name.startsWith('testbench/')) manifest.require[name] = ctx.version;
    else require(!/dev-/.test(constraint), `${pkg.name} requires ${name} ${constraint}, which is not a release constraint`);
  }
  manifest.keywords = [...new Set([...(manifest.keywords ?? []), ...ctx.metadata.keywords])];
  manifest.license = ctx.metadata.license;
  manifest.authors = ctx.metadata.authors.map(name => ({ name, homepage: ctx.repository.url }));
  manifest.homepage = ctx.metadata.homepage;
  manifest.support = { source: ctx.repository.url, issues: ctx.metadata.issues };

  // Rebuild in the conventional key order so the shipped file reads like a hand-written one.
  const order = ['name', 'description', 'type', 'license', 'keywords', 'homepage', 'authors', 'support', 'require', 'suggest',
    'autoload', 'extra', 'archive', 'config', 'minimum-stability', 'prefer-stable'];
  const ordered = {};
  for (const key of order) if (key in manifest) ordered[key] = manifest[key];
  for (const key of Object.keys(manifest)) if (!(key in ordered)) ordered[key] = manifest[key];
  return ordered;
}

/** Rewrites relative README links to absolute repository URLs, since the mirror repo has no ../../spec. */
function absoluteLinks(readme, pkg, ctx) {
  const ref = ctx.commit ?? 'HEAD';
  return readme.replace(/\]\(((?!https?:|mailto:|#|\/)[^)\s]+)\)/g, (_, target) => {
    const [path, hash = ''] = target.split(/(?=#)/);
    return `](${ctx.repository.url}/blob/${ref}/${posix.normalize(posix.join('adapters/php', pkg.dir, path))}${hash})`;
  });
}

/** Asserts a built ZIP is exactly an installable release tree. */
async function checkArchive(path, pkg, ctx) {
  const entries = readZip(await readFile(path));
  const names = [...entries.keys()];
  const has = name => entries.has(name);
  const label = `${pkg.dir} ZIP`;
  for (const required of ['composer.json', 'LICENSE', 'README.md']) require(has(required), `${label} is missing ${required}`);
  require(names.some(name => name.startsWith('src/')), `${label} has no src/`);
  if (pkg.dir === 'core') {
    for (const required of ['resources/ui/manifest.json', 'resources/ui/index.html']) require(has(required), `${label} is missing ${required}`);
  }
  const unwanted = names.filter(name => /(^|\/)(vendor|tests|\.git|\.phpunit\.cache)(\/|$)/.test(name) || /(^|\/)(composer\.lock|phpunit\.xml|\.phpunit\.result\.cache)$/.test(name));
  require(!unwanted.length, `${label} contains files that must not ship: ${unwanted.slice(0, 5).join(', ')}`);

  const manifest = JSON.parse(entries.get('composer.json').toString('utf8'));
  require(manifest.name === pkg.name, `${label}: composer.json is named ${manifest.name}`);
  for (const field of ['version', 'repositories', 'require-dev', 'autoload-dev', 'scripts']) {
    require(!(field in manifest), `${label}: composer.json must not contain "${field}"`);
  }
  require(manifest.license === 'MIT' && manifest.description && manifest.keywords?.length, `${label}: composer.json lacks licence, description or keywords`);
  require(manifest.homepage === ctx.metadata.homepage, `${label}: homepage is ${manifest.homepage}`);
  require(manifest.support?.source === ctx.repository.url && manifest.support?.issues === ctx.metadata.issues, `${label}: support links are wrong`);
  require(manifest.authors?.some(author => author.name === ctx.metadata.authors[0]), `${label}: authors are missing`);
  if (pkg.name !== SIBLING) require(manifest.require?.[SIBLING] === ctx.version, `${label}: ${SIBLING} must be required at exactly ${ctx.version}`);
  require(!JSON.stringify(manifest).includes('dev-main'), `${label}: composer.json still mentions dev-main`);
  // Placeholder repository URLs that used to be hard-coded in manifests must never reappear.
  const stale = /github\.com\/(test-bench|testbench)\/test-bench/;
  if (!stale.test(ctx.repository.url)) {
    for (const [name, bytes] of entries) {
      if (/\.(json|md)$/.test(name)) require(!stale.test(bytes.toString('utf8')), `${label}: ${name} carries a placeholder repository URL`);
    }
  }
}

/** Reads a ZIP into a Map of file name to contents (stored or deflated entries; directories skipped). */
function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  require(end >= 0, 'Not a ZIP archive: no end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    require(buffer.readUInt32LE(offset) === 0x02014b50, 'Corrupt ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    require(method === 0 || method === 8, `ZIP entry ${name} uses unsupported compression ${method}`);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
  }
  return entries;
}

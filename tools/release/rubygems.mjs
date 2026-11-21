// RubyGems.org: builds testbench-core, testbench-activerecord and testbench-rails as .gem files and
// proves they install and serve the workbench in a fresh Rails application.
//
// pack:   stages adapters/ruby into ctx.work, stamps the version and repository URL into the staged
//         copy only, packs the shared UI into the staged core gem, then runs `gem build` per gem.
// verify: creates a Rails API app outside the repository whose Gemfile resolves the three gems from
//         vendor/cache (the archives in ctx.out), installs with Bundler, and probes /bench/.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  exists, freePort, listFiles, output, removeDir, require, root, run, sha256, smokeServe, stage, tempDir, which,
} from './lib.mjs';

export const title = 'RubyGems';

const ruby = join(root, 'adapters', 'ruby');
const consumerTemplates = join(root, 'tools', 'release', 'consumers', 'rubygems');
const inspectScript = join(consumerTemplates, 'inspect_gem.rb');

/** Build order matters only for readability: both adapters depend on testbench-core. */
const GEMS = [
  { name: 'testbench-core', dir: 'testbench', requires: [] },
  { name: 'testbench-activerecord', dir: 'testbench-activerecord', requires: ['testbench-core'] },
  { name: 'testbench-rails', dir: 'testbench-rails', requires: ['testbench-core'] },
];

/** Oldest Ruby the gemspecs claim to support (`required_ruby_version`). */
const MINIMUM_RUBY = [3, 3];

export const registryVersion = versions => versions.rubygems;

export async function available() {
  for (const tool of ['ruby', 'gem', 'bundle', 'node']) {
    if (!which(tool)) return `${tool} is not on PATH (RubyGems packaging needs Ruby ${MINIMUM_RUBY.join('.')}+, RubyGems, Bundler and Node)`;
  }
  const version = await output('ruby', ['-e', 'print RUBY_VERSION']);
  const [major, minor] = version.split('.').map(Number);
  if (major < MINIMUM_RUBY[0] || (major === MINIMUM_RUBY[0] && minor < MINIMUM_RUBY[1])) {
    return `Ruby ${version} is too old; the gems require Ruby ${MINIMUM_RUBY.join('.')}+`;
  }
  return null;
}

export async function pack(ctx) {
  const { versions, repository, metadata } = ctx;
  const staged = join(ctx.work, 'ruby');
  // Tests, examples and previously built output never belong in a gem; `ui` is regenerated below.
  await stage(ruby, staged, { exclude: ['pkg', '.bundle', 'examples', 'test', 'ui'] });

  await stampVersion(join(staged, 'testbench', 'lib', 'testbench', 'version.rb'), versions);
  for (const gem of GEMS) await stampReadme(join(staged, gem.dir, 'README.md'), repository.url);

  const ui = join(staged, 'testbench', 'lib', 'testbench', 'ui');
  ctx.log(`packing the UI bundle ${versions.semver}`);
  await run(process.execPath, [join(root, 'tools', 'pack-ui.mjs'), '--version', versions.semver, '--out', ui], { label: ctx.id });

  const env = { TESTBENCH_REPOSITORY_URL: repository.url };
  // gem build is reproducible when SOURCE_DATE_EPOCH is fixed: use the commit time when there is one.
  if (ctx.commit) {
    try { env.SOURCE_DATE_EPOCH = await output('git', ['show', '-s', '--format=%ct', ctx.commit]); } catch { /* not a checkout */ }
  }

  const files = [];
  for (const gem of GEMS) {
    const file = `${gem.name}-${versions.rubygems}.gem`;
    await run('gem', ['build', `${gem.name}.gemspec`, '--output', join(ctx.out, file)], {
      cwd: join(staged, gem.dir), env, label: ctx.id,
    });
    await checkGem(ctx, gem, join(ctx.out, file));
    files.push(file);
  }
  ctx.log(`built ${files.join(', ')}`);
  return files;
}

/** Rewrites VERSION and UI_VERSION in the staged copy of version.rb. */
async function stampVersion(path, versions) {
  let text = await readFile(path, 'utf8');
  const before = text;
  text = text.replace(/^(\s*)VERSION = "[^"]*"/m, `$1VERSION = "${versions.rubygems}"`);
  text = text.replace(/^(\s*)UI_VERSION = "[^"]*"/m, `$1UI_VERSION = "${versions.semver}"`);
  require(text !== before || (text.includes(`"${versions.rubygems}"`) && text.includes(`"${versions.semver}"`)),
    `Could not stamp ${path}: VERSION and UI_VERSION lines were not found`);
  await writeFile(path, text);
}

/** Points the README's project link at the canonical repository (a no-op when it already does). */
async function stampReadme(path, url) {
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/https:\/\/github\.com\/test-?bench\/test-?bench(?=[)\s/#]|$)/g, url));
}

/** Reads a built gem back and fails loudly on missing or wrong metadata. */
async function checkGem(ctx, gem, path) {
  const spec = JSON.parse(await output('ruby', [inspectScript, path]));
  const { versions, repository, metadata } = ctx;
  const fail = message => { throw new Error(`${gem.name}: ${message}`); };

  if (spec.name !== gem.name) fail(`built as ${spec.name}`);
  if (spec.version !== versions.rubygems) fail(`version is ${spec.version}, expected ${versions.rubygems}`);
  if (!spec.licenses.includes(metadata.license)) fail(`licence is ${JSON.stringify(spec.licenses)}, expected ${metadata.license}`);
  for (const author of metadata.authors) if (!spec.authors.includes(author)) fail(`missing author ${author}`);
  if (!spec.summary || !spec.description) fail('summary or description is empty');
  if (spec.homepage !== repository.url) fail(`homepage is ${spec.homepage}, expected ${repository.url}`);

  const expected = {
    source_code_uri: repository.url,
    bug_tracker_uri: metadata.issues,
    changelog_uri: `${repository.url}/releases`,
    documentation_uri: `${repository.url}/tree/main/adapters/ruby#readme`,
    rubygems_mfa_required: 'true',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (spec.metadata[key] !== value) fail(`metadata ${key} is ${JSON.stringify(spec.metadata[key])}, expected ${value}`);
  }
  if (JSON.stringify(spec).includes('test-bench/test-bench') && repository.url !== 'https://github.com/test-bench/test-bench') {
    fail('a hard-coded repository URL survived stamping');
  }

  const needed = ['LICENSE', 'README.md', `lib/${gem.name}.rb`];
  if (gem.name === 'testbench-core') needed.push('lib/testbench.rb', 'lib/testbench/version.rb', 'lib/testbench/ui/manifest.json', 'lib/testbench/ui/index.html', 'lib/testbench/ui/app.js');
  for (const file of needed) if (!spec.files.includes(file)) fail(`archive does not contain ${file}`);
  const stray = spec.files.filter(file => !/^(lib\/|LICENSE$|README\.md$)/.test(file));
  if (stray.length) fail(`unexpected files in the archive: ${stray.join(', ')}`);
  if (gem.name !== 'testbench-core' && spec.files.some(file => file.startsWith('lib/testbench/ui/'))) fail('only testbench-core carries the UI');

  // Sibling gems are pinned to exactly this release, so a mixed install can never resolve.
  for (const dependency of gem.requires) {
    const pin = spec.dependencies.find(entry => entry.name === dependency);
    if (pin?.requirement !== `= ${versions.rubygems}`) fail(`${dependency} dependency is ${pin?.requirement ?? 'missing'}, expected = ${versions.rubygems}`);
  }
  ctx.log(`${gem.name} ${spec.version}: ${spec.files.length} files, licence ${spec.licenses.join(',')}, deps ${spec.dependencies.map(d => `${d.name} ${d.requirement}`).join('; ')}`);
}

export async function verify(ctx) {
  const project = await tempDir('rubygems');
  try {
    const version = ctx.versions.rubygems;
    const gems = GEMS.map(gem => `${gem.name}-${version}.gem`);

    // The gems live only in vendor/cache; the public index has no testbench-* gems to fall back on.
    await mkdir(join(project, 'vendor', 'cache'), { recursive: true });
    for (const file of gems) await cp(join(ctx.out, file), join(project, 'vendor', 'cache', file));
    const template = await readFile(join(consumerTemplates, 'Gemfile.template'), 'utf8');
    await writeFile(join(project, 'Gemfile'), template.replaceAll('__VERSION__', version));
    for (const file of ['app.rb', 'config.ru']) await cp(join(consumerTemplates, file), join(project, file));

    // Everything Bundler reads or writes stays inside the throwaway project.
    const env = {
      BUNDLE_GEMFILE: join(project, 'Gemfile'),
      BUNDLE_APP_CONFIG: join(project, '.bundle'),
      BUNDLE_PATH: join(project, 'bundle'),
      BUNDLE_FROZEN: 'false',
      BUNDLE_DEPLOYMENT: 'false',
      RAILS_ENV: 'development',
      RACK_ENV: 'development',
    };
    ctx.log(`installing ${gems.join(', ')} into a fresh Rails app`);
    await run('bundle', ['install', '--prefer-local', '--no-cache', '--jobs', '4'], { cwd: project, env, label: ctx.id });

    await checkInstalled(ctx, project, gems);

    const port = await freePort();
    ctx.log(`starting the consumer on 127.0.0.1:${port}`);
    const result = await smokeServe({
      label: ctx.id, command: 'bundle',
      args: ['exec', 'puma', '--bind', `tcp://127.0.0.1:${port}`, '--threads', '1:4', '--quiet', 'config.ru'],
      cwd: project, env, port,
    });
    ctx.log(`served /bench/ and ${result.capabilities.openApiUrl}`);
  } finally {
    if (ctx.keep) ctx.log(`kept ${project}`);
    else await removeDir(project);
  }
}

/** The installed gems must be the archives from ctx.out, byte for byte. */
async function checkInstalled(ctx, project, gems) {
  const lock = await readFile(join(project, 'Gemfile.lock'), 'utf8');
  for (const gem of GEMS) {
    require(lock.includes(`    ${gem.name} (${ctx.versions.rubygems})`), `Gemfile.lock does not resolve ${gem.name} ${ctx.versions.rubygems}`);
  }
  const cached = (await listFiles(join(project, 'bundle'))).filter(file => /\/cache\/testbench-[^/]+\.gem$/.test(file));
  for (const file of gems) {
    const installed = cached.find(entry => entry.endsWith(`/cache/${file}`));
    require(installed, `Bundler did not install ${file}`);
    const [expected, actual] = await Promise.all([readFile(join(ctx.out, file)), readFile(join(project, 'bundle', installed))]);
    require(sha256(expected) === sha256(actual), `The installed ${file} is not the archive in ${ctx.out}`);
  }
  require(await exists(join(project, 'Gemfile.lock')), 'Bundler wrote no Gemfile.lock');
}

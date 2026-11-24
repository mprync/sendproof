#!/usr/bin/env node
// Uploads one registry's verified packages. Used only by the publish jobs in .github/workflows/check.yml,
// after the packages were built once by the platform job and downloaded as an artifact.
//
//   node tools/release/publish.mjs <registry> <artifact directory> --tag v1.2.3 [--dry-run]
//
// Before anything is uploaded it re-checks SHA256SUMS, that RELEASE.json names the tag's version and
// the repository this workflow runs in, and that the commit matches. Credentials come only from the
// environment the job's login step prepares (OIDC where the registry supports it). --dry-run prints
// the upload commands instead of running them, for local checks.
//
// Packages are uploaded in the order RELEASE.json lists them, which pack-all writes in dependency
// order. A registry never lets a version be replaced, so npm and crates.io skip a version that is
// already there and a failed run is recovered by re-running the job, never by rebuilding.
//
// npm and crates.io accept trusted publishing only for a package that already exists, so for those two
// every package name must already be on the registry. The check runs in --dry-run too, which CI does on
// every push, so a new package name fails before it reaches a release.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  listFiles, output, parseRepository, readJson, releaseVersions, require, root, run, sha256, tempDir, verifyChecksums,
} from './lib.mjs';
import { GROUP as MAVEN_GROUP } from './maven.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tag: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, project: { type: 'string' } },
});
const [registry, directory] = positionals;
require(registry && directory && values.tag, 'Usage: publish.mjs <registry> <artifact directory> --tag vX.Y.Z [--dry-run] [--project <pypi project>]');
require(!values.project || registry === 'pypi', '--project applies to the pypi registry only');
const dryRun = values['dry-run'];
const versions = releaseVersions(values.tag.replace(/^v/, ''));

// 1. The artifact is exactly what the platform job built and verified.
await verifyChecksums(directory);
const release = await readJson(join(directory, 'RELEASE.json'));
require(release.registry === registry, `RELEASE.json is for ${release.registry}, not ${registry}`);
require(release.version === versions.semver, `Packages are version ${release.version}, but the tag is ${values.tag}`);
if (process.env.GITHUB_REPOSITORY) {
  const running = parseRepository(`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`);
  const problems = [];
  if (release.repository.toLowerCase() !== running.url.toLowerCase()) {
    problems.push(`Packages name ${release.repository}, but this workflow runs in ${running.url}`);
  }
  if (release.commit && release.commit !== process.env.GITHUB_SHA) {
    problems.push(`Packages were built from ${release.commit}, not ${process.env.GITHUB_SHA}`);
  }
  // A dry run on a fork or before MODULE_PATH names the real repository reports these but continues.
  for (const problem of problems) console.warn(`${dryRun ? 'warning' : 'error'}: ${problem}`);
  require(dryRun || !problems.length, 'Refusing to publish');
}
console.log(`Publishing ${release.files.length} ${registry} files for ${versions.semver}${dryRun ? ' (dry run)' : ''}`);

// Runs an upload command; `secrets` are replaced by *** wherever the command is printed.
const exec = async (command, args, { secrets = [], ...options } = {}) => {
  const shown = secrets.reduce((text, secret) => secret ? text.split(secret).join('***') : text, [command, ...args].join(' '));
  if (dryRun) { console.log(`would run: ${shown}`); return; }
  console.log(`$ ${shown}`);
  await run(command, args, { label: registry, secrets, ...options });
};
const files = release.files.map(file => join(directory, file));

// 2. Trusted publishing can't create a package, so every npm and crates.io name must already exist.
const packageName = {
  npm: file => `@sendproof/${basename(file).slice('sendproof-'.length, -`-${versions.semver}.tgz`.length)}`,
  crates: file => basename(file, `-${versions.semver}.crate`),
}[registry];
if (packageName) {
  const extension = registry === 'npm' ? '.tgz' : '.crate';
  const names = files.filter(path => path.endsWith(extension)).map(packageName);
  const missing = [];
  for (const name of names) if (!await published(name)) missing.push(name);
  require(!missing.length, `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on ${registry} yet, and trusted `
    + 'publishing cannot create a package. Ship the code inside an existing package instead (docs/publishing.md).');
  console.log(`All ${names.length} ${registry} package names exist, so trusted publishing can upload them`);
}

const publishers = {
  async npm() {
    // npm 11.5.1+ exchanges the job's OIDC token itself (trusted publishing) and adds provenance.
    for (const file of files.filter(path => path.endsWith('.tgz'))) {
      const name = packageName(file);
      if (await published(name, versions.semver)) { console.log(`${name} ${versions.semver} is already on npm`); continue; }
      await exec('npm', ['publish', file, '--access', 'public', '--provenance', '--tag', versions.npmTag]);
    }
  },

  async pypi() {
    // pypa/gh-action-pypi-publish uploads a directory of distributions only.
    const dist = join(root, 'artifacts', 'pypi-upload');
    await rm(dist, { recursive: true, force: true });
    await mkdir(dist, { recursive: true });
    // PyPI wants one trusted publisher (and so one GitHub environment) per project, so each publish job uploads only
    // its own project's wheel and sdist. File names carry the normalized project name: sendproof-core is sendproof_core-*.
    const project = values.project;
    const known = ['sendproof-core', 'sendproof-sqlalchemy', 'sendproof-fastapi', 'sendproof-flask', 'sendproof-django'];
    require(!project || known.includes(project), `Unknown PyPI project ${project}; expected one of ${known.join(', ')}`);
    const prefix = project && `${project.replace(/[-_.]+/g, '_')}-`;
    const selected = files.filter(path => /\.(whl|tar\.gz)$/.test(path)
      && (!prefix || basename(path).toLowerCase().startsWith(prefix)));
    require(!project || selected.length === 2, `Expected one wheel and one sdist for ${project}, found ${selected.length}`);
    for (const file of selected) await copyFile(file, join(dist, basename(file)));
    console.log(`Prepared ${(await readdir(dist)).length} distributions${project ? ` for ${project}` : ''} in ${dist}`);
  },

  async nuget() {
    // Pushing a .nupkg also pushes its adjacent .snupkg. NuGet/login exchanged the OIDC token for this key.
    const key = dryRun ? 'NUGET_API_KEY' : requireEnv('NUGET_API_KEY');
    for (const file of files.filter(path => path.endsWith('.nupkg'))) {
      await exec('dotnet', ['nuget', 'push', file, '--api-key', key, '--source', 'https://api.nuget.org/v3/index.json'], { secrets: [key] });
    }
  },

  async rubygems() {
    for (const file of files.filter(path => path.endsWith('.gem'))) await exec('gem', ['push', file]);
  },

  async crates() {
    // cargo can only publish a source directory, so each verified .crate is unpacked and published from
    // there without rebuilding (--no-verify). The unpacked Cargo.toml is the normalised manifest cargo
    // wrote at pack time, so the upload carries the same files. Order: a crate after its dependencies.
    const work = await tempDir('crates-publish');
    const crates = [];
    for (const file of files.filter(path => path.endsWith('.crate'))) {
      await run('tar', ['-xzf', file, '-C', work], { quiet: true });
      const dir = join(work, basename(file, '.crate'));
      const manifest = await readFile(join(dir, 'Cargo.toml'), 'utf8');
      const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(manifest)[1];
      const deps = [...manifest.matchAll(/^\[(?:dependencies|build-dependencies)\.([\w-]+)\]/gm)].map(match => match[1]);
      crates.push({ name, dir, deps });
    }
    const done = new Set();
    while (done.size < crates.length) {
      const next = crates.find(crate => !done.has(crate.name)
        && crate.deps.every(dep => done.has(dep) || !crates.some(other => other.name === dep)));
      require(next, 'The crates have a dependency cycle');
      done.add(next.name);
      if (await published(next.name, versions.semver)) { console.log(`${next.name} ${versions.semver} is already on crates.io`); continue; }
      // The packed Cargo.lock pins sibling crates to the checksums of cargo package's temporary local
      // registry, which differ from the archives crates.io serves, so cargo publish would refuse it.
      // cargo writes a fresh lock file against crates.io while publishing. Cargo.toml.orig is a name cargo
      // reserves for the copy it writes itself, so the unpacked one goes too; Cargo.toml is unchanged.
      for (const reserved of ['Cargo.lock', 'Cargo.toml.orig']) await rm(join(next.dir, reserved), { force: true });
      // cargo publish waits until the index serves the new version before returning.
      await exec('cargo', ['publish', '--no-verify', '--allow-dirty'], { cwd: next.dir });
    }
  },

  async maven() {
    await publishMaven(directory, release);
  },

  async packagist() {
    await publishPackagist(files);
  },

  async go() {
    await publishGo(directory);
  },
};

require(publishers[registry], `Unknown registry ${registry}`);
await publishers[registry]();
console.log(`${registry}: done`);

function requireEnv(name) {
  const value = process.env[name];
  require(value, `${name} is not set; the job's login step must provide it`);
  return value;
}

/**
 * Maven Central (Central Portal): sign every artifact with the release GPG key, add MD5 and SHA-1
 * checksums, zip the repository layout into a bundle and upload it for automatic publication.
 * Secrets: MAVEN_GPG_PRIVATE_KEY (armored), MAVEN_GPG_PASSPHRASE, MAVEN_CENTRAL_USERNAME and
 * MAVEN_CENTRAL_PASSWORD (a Central Portal user token).
 */
async function publishMaven(source, release) {
  const { createHash } = await import('node:crypto');
  const work = await tempDir('maven-bundle');
  const layout = join(work, 'repository');
  await mkdir(layout, { recursive: true });
  // The repository layout is the group ID as a path (io.github.mprync is io/github/mprync/...).
  const groupPath = MAVEN_GROUP.replaceAll('.', '/');
  const artifacts = (await listFiles(source)).filter(file => file.startsWith(`${groupPath}/`));
  require(artifacts.length, `No Maven artifacts under ${groupPath}/`);
  for (const file of artifacts) {
    await mkdir(join(layout, file, '..'), { recursive: true });
    await copyFile(join(source, file), join(layout, file));
  }

  const gnupg = join(work, 'gnupg');
  await mkdir(gnupg, { recursive: true, mode: 0o700 });
  const gpg = ['--batch', '--yes', '--homedir', gnupg];
  if (!dryRun) {
    await run('gpg', [...gpg, '--import'], { input: requireEnv('MAVEN_GPG_PRIVATE_KEY'), quiet: true });
  }
  for (const file of artifacts) {
    const path = join(layout, file);
    if (dryRun) console.log(`would sign: ${file}`);
    else {
      await run('gpg', [...gpg, '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--armor', '--detach-sign', '--output', `${path}.asc`, path],
        { input: requireEnv('MAVEN_GPG_PASSPHRASE'), quiet: true });
    }
    const bytes = await readFile(path);
    await writeFile(`${path}.md5`, createHash('md5').update(bytes).digest('hex'));
    await writeFile(`${path}.sha1`, createHash('sha1').update(bytes).digest('hex'));
  }
  const bundle = join(work, `sendproof-${release.version}.zip`);
  await run('zip', ['-qr', bundle, groupPath.split('/')[0]], { cwd: layout });
  console.log(`Bundle ${basename(bundle)}: ${artifacts.length} artifacts, sha256 ${sha256(await readFile(bundle))}`);
  if (dryRun) { console.log('would upload the bundle to https://central.sonatype.com/api/v1/publisher/upload'); return; }

  const authorization = `Bearer ${Buffer.from(`${requireEnv('MAVEN_CENTRAL_USERNAME')}:${requireEnv('MAVEN_CENTRAL_PASSWORD')}`).toString('base64')}`;
  const form = new FormData();
  form.append('bundle', new Blob([await readFile(bundle)]), basename(bundle));
  const name = encodeURIComponent(`Sendproof ${release.version}`);
  const upload = await fetch(`https://central.sonatype.com/api/v1/publisher/upload?publishingType=AUTOMATIC&name=${name}`,
    { method: 'POST', headers: { Authorization: authorization }, body: form });
  const deployment = (await upload.text()).trim();
  require(upload.ok, `Central Portal rejected the upload (${upload.status}): ${deployment}`);
  console.log(`Central Portal deployment ${deployment}`);
  // Validation and publication are asynchronous; wait for a final state (up to 60 minutes).
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(30000);
    const response = await fetch(`https://central.sonatype.com/api/v1/publisher/status?id=${deployment}`,
      { method: 'POST', headers: { Authorization: authorization } });
    const status = await response.json();
    console.log(`deployment ${status.deploymentState}`);
    if (status.deploymentState === 'PUBLISHED') return;
    require(status.deploymentState !== 'FAILED', `Central Portal validation failed: ${JSON.stringify(status.errors ?? status)}`);
  }
  throw new Error(`Deployment ${deployment} did not reach PUBLISHED within 60 minutes; check central.sonatype.com`);
}

/**
 * Packagist reads composer.json at a repository root, so each PHP package is released to its own
 * mirror repository (as Symfony and Laravel do): the release tree from the verified ZIP becomes one
 * commit on the mirror's main branch, tagged with the version. Packagist's GitHub hook on each mirror
 * picks the tag up. Mirrors: <owner>/<repo>-php-<package>, overridable with PACKAGIST_SPLIT_PREFIX
 * (e.g. "mprync/sendproof-php-"). Needs GH_SPLIT_TOKEN with contents:write on the mirrors.
 */
async function publishPackagist(zips) {
  const repository = parseRepository(`${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? 'owner/repo'}`);
  const prefix = process.env.PACKAGIST_SPLIT_PREFIX || `${repository.owner}/${repository.name}-php-`;
  const token = dryRun ? 'TOKEN' : requireEnv('GH_SPLIT_TOKEN');
  for (const zip of zips.filter(path => path.endsWith('.zip'))) {
    const pkg = /^sendproof-(.+)-\d+\.\d+\.\d+.*\.zip$/.exec(basename(zip))?.[1];
    require(pkg, `Unexpected Packagist archive name ${basename(zip)}`);
    const mirror = `${prefix}${pkg}`;
    const work = await tempDir(`split-${pkg}`);
    console.log(`${basename(zip)} -> github.com/${mirror} tag v${versions.semver}`);
    if (dryRun) continue;
    // The token travels as an HTTP header set through git's environment config, never in the remote URL,
    // .git/config or a command line that an error message could print.
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
    const git = (...args) => run('git', args, { cwd: work, env, label: `split ${pkg}` });
    await git('init', '-q', '-b', 'main');
    await git('remote', 'add', 'origin', `https://github.com/${mirror}.git`);
    // Keep the mirror's history when it exists; an empty mirror starts at this release.
    try { await git('fetch', '-q', '--depth', '1', 'origin', 'main'); await git('reset', '-q', '--soft', 'FETCH_HEAD'); } catch { /* empty mirror */ }
    await run('git', ['rm', '-rq', '--cached', '--ignore-unmatch', '.'], { cwd: work, quiet: true });
    await run('unzip', ['-q', '-o', zip, '-d', work]);
    // A VCS package takes its version from the tag, so the release tree must not name one.
    const manifest = JSON.parse(await readFile(join(work, 'composer.json'), 'utf8'));
    require(!('version' in manifest), `${basename(zip)}: composer.json must not set "version" for a split repository`);
    await git('add', '-A');
    await git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-q', '--allow-empty', '-m', `Release ${versions.semver} from ${process.env.GITHUB_REPOSITORY}@${process.env.GITHUB_SHA}`);
    await git('tag', `v${versions.semver}`);
    await git('push', '-q', 'origin', 'HEAD:main', `refs/tags/v${versions.semver}`);
  }
}

/**
 * Go: push the path-prefixed tags from tags.txt at the tagged commit (core first, so the others can
 * resolve it), then ask the public proxy for each module so the release is cached immediately.
 */
async function publishGo(source) {
  const tags = (await readFile(join(source, 'tags.txt'), 'utf8')).trim().split('\n');
  const modulePath = (await readFile(join(root, 'adapters', 'go', 'MODULE_PATH'), 'utf8')).trim();
  const sha = process.env.GITHUB_SHA ?? await output('git', ['rev-parse', 'HEAD']);
  for (const tag of tags) {
    await exec('git', ['tag', tag, sha]);
    await exec('git', ['push', 'origin', `refs/tags/${tag}`]);
  }
  for (const tag of tags) {
    const [module, version] = [tag.slice(0, tag.lastIndexOf('/')), tag.slice(tag.lastIndexOf('/') + 1)];
    const path = modulePath.replace(/\/adapters\/go$/, `/${module}`);
    const url = `https://proxy.golang.org/${path.toLowerCase().replace(/[A-Z]/g, c => `!${c.toLowerCase()}`)}/@v/${version}.info`;
    if (dryRun) { console.log(`would fetch ${url}`); continue; }
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(url);
      if (response.ok) { console.log(`proxy.golang.org serves ${path}@${version}`); break; }
      if (attempt === 9) throw new Error(`proxy.golang.org did not serve ${path}@${version} (${response.status})`);
      await delay(15000);
    }
  }
}

/**
 * Whether this registry (npm or crates.io) has the package, or with `version`, that version of it. Lets a
 * re-run after a partial upload skip what made it, and the pre-check above find names that don't exist.
 */
async function published(name, version) {
  let url;
  if (registry === 'npm') {
    url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
  } else {
    const lower = name.toLowerCase();
    url = `https://index.crates.io/${lower.length <= 2 ? `${lower.length}/${lower}`
      : lower.length === 3 ? `3/${lower[0]}/${lower}` : `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`}`;
  }
  const response = await fetch(url, { headers: { 'user-agent': 'sendproof-release' } });
  if (response.status === 404) return false;
  require(response.ok, `${registry} returned ${response.status} for ${name}`);
  if (!version) return true;
  if (registry === 'npm') return version in ((await response.json()).versions ?? {});
  return (await response.text()).split('\n').filter(Boolean).some(line => JSON.parse(line).vers === version);
}

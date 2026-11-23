// crates.io packaging: `cargo package` the nine published Rust crates into .crate archives.
//
// pack   Stages adapters/rust into ctx.work, stamps the release version, repository and homepage into the
//        staged manifests, generates the embedded UI into the staged sendproof-core, then runs
//        `cargo package --workspace` (with Cargo's own verification build) and copies the .crate files.
// verify Extracts the .crate archives from ctx.out into a throwaway project outside the repository, points
//        a minimal Axum application at them with path dependencies plus [patch.crates-io], builds it and
//        checks that it serves the workbench.
//
// Tracked manifests carry no repository URL and no sendproof-* dependency versions; both are stamped here.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  cleanDir, exists, freePort, isWindows, output, removeDir, require, root, run, smokeServe, stage, tempDir, which,
} from './lib.mjs';

export const title = 'crates.io';

/** The published crates in dependency order: sendproof-sqlx's dev-dependencies need axum, actix's need sqlx. */
const CRATES = [
  'sendproof-core', 'sendproof-axum', 'sendproof-sqlx', 'sendproof-actix', 'sendproof-redis', 'sendproof-dynamodb', 'sendproof-mongodb',
  'sendproof-cassandra', 'sendproof-elasticsearch', 'sendproof-journeys',
];
const workspace = join(root, 'adapters/rust');

/**
 * `cargo package --workspace` verifies each crate against its siblings through a temporary local registry,
 * and cargo unpacks registry crates into $CARGO_HOME/registry/src/<registry>/<name>-<version> only once,
 * because a published version can never change. Our unpublished version does change between runs, so an
 * earlier run's unpacked copy would be compiled instead of the new archive. Remove only those copies of
 * our own crates, and only from local (non crates.io) registries; nothing downloaded is touched.
 */
async function forgetUnpackedCrates(ctx) {
  const cargoHome = process.env.CARGO_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cargo');
  for (const kind of ['src', 'cache']) {
    const base = join(cargoHome, 'registry', kind);
    if (!await exists(base)) continue;
    for (const registry of await readdir(base, { withFileTypes: true })) {
      if (!registry.isDirectory() || registry.name.startsWith('index.')) continue;
      for (const entry of await readdir(join(base, registry.name))) {
        if (CRATES.some(name => entry === `${name}-${ctx.version}` || entry === `${name}-${ctx.version}.crate`)) {
          await rm(join(base, registry.name, entry), { recursive: true, force: true });
        }
      }
    }
  }
}

export async function available() {
  if (!which('cargo')) return 'cargo (a Rust toolchain, 1.94 or newer) is not on PATH';
  if (!which('node')) return 'node is not on PATH';
  return null;
}

export function registryVersion(versions) {
  return versions.semver;
}

/** Shared build cache: the workspace's own target directory, unless CARGO_TARGET_DIR says otherwise. */
const cargoTarget = () => process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(workspace, 'target');

// --- TOML stamping ---------------------------------------------------------------------------------------

const quote = value => JSON.stringify(value);

/** Rewrites the staged workspace manifest: members, release version, repository, homepage, sendproof-* versions. */
export function stampWorkspaceManifest(text, ctx) {
  let result = text.replace(/members = \[[^\]]*\]/, `members = [${CRATES.map(quote).join(', ')}]`);
  const before = result;
  result = result.replace(/^version = "[^"]*"$/m, [
    `version = ${quote(ctx.version)}`,
    `repository = ${quote(ctx.repository.url)}`,
    `homepage = ${quote(ctx.metadata.homepage)}`,
  ].join('\n'));
  require(result !== before, 'adapters/rust/Cargo.toml has no [workspace.package] version to stamp');
  let stamped = 0;
  result = result.replace(/^(sendproof-[a-z]+ = \{ path = "[^"]+") \}$/gm, (_, head) => {
    stamped += 1;
    return `${head}, version = ${quote(ctx.version)} }`;
  });
  require(stamped === CRATES.length, `Expected ${CRATES.length} sendproof-* workspace dependencies, stamped ${stamped}`);
  return result;
}

/** Makes a member crate inherit the stamped repository and homepage from the workspace. */
export function stampMemberManifest(text) {
  require(/^\[package\]$/m.test(text), 'Member manifest has no [package] table');
  require(!/^repository/m.test(text), 'Member manifest hard-codes a repository; it must inherit the stamped one');
  return text.replace(/^\[package\]\r?\n/m, '[package]\nrepository.workspace = true\nhomepage.workspace = true\n');
}

// --- tar reading (so extraction needs no tar binary: GNU tar on Windows cannot read `C:\` paths) -------------

/** Reads a gzip-compressed tar archive. Returns [{ name, type, data }] for files and directories. */
export function readCrate(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  let longName = null;
  let pax = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (from, length) => header.toString('utf8', from, from + length).replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const prefix = text(345, 155);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      pax = {};
      for (const match of data.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[match[1]] = match[2];
      continue;
    }
    if (type === 'g') continue;
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    longName = null;
    pax = {};
    entries.push({ name, type: type === '5' ? 'directory' : 'file', data });
  }
  return entries;
}

/** Extracts a .crate into `destination`, refusing any entry that would land outside it. */
async function extractCrate(file, destination) {
  const base = resolve(destination);
  for (const entry of readCrate(await readFile(file))) {
    const target = resolve(base, entry.name);
    require(target === base || target.startsWith(`${base}${isWindows ? '\\' : '/'}`), `${file}: unsafe path ${entry.name}`);
    if (entry.type === 'directory') { await mkdir(target, { recursive: true }); continue; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
}

// --- pack ------------------------------------------------------------------------------------------------

/** Checks one .crate: its normalized Cargo.toml metadata and its contents. */
export function checkCrate(name, ctx, bytes) {
  const entries = new Map(readCrate(bytes).filter(entry => entry.type === 'file').map(entry => [entry.name, entry.data]));
  const root = `${name}-${ctx.version}/`;
  const file = path => entries.get(`${root}${path}`);
  const manifest = file('Cargo.toml')?.toString('utf8');
  require(manifest, `${name}: the .crate has no ${root}Cargo.toml`);
  const field = key => new RegExp(`^${key} = (.+)$`, 'm').exec(manifest)?.[1];
  const label = `${name}-${ctx.version}.crate`;
  require(field('name') === quote(name), `${label}: wrong package name`);
  require(field('version') === quote(ctx.version), `${label}: version is ${field('version')}, expected ${ctx.version}`);
  require(field('license') === quote('MIT'), `${label}: license must be "MIT"`);
  require(field('repository') === quote(ctx.repository.url), `${label}: repository is ${field('repository')}, expected ${ctx.repository.url}`);
  require(field('homepage') === quote(ctx.metadata.homepage), `${label}: homepage is ${field('homepage')}`);
  require(field('readme') === quote('README.md'), `${label}: readme is missing`);
  require(field('authors')?.includes('Sendproof contributors'), `${label}: authors must name "Sendproof contributors"`);
  require(field('description')?.length > 20, `${label}: description is missing`);
  const keywords = /^keywords = \[([^\]]*)\]/m.exec(manifest)?.[1].match(/"[^"]+"/g) ?? [];
  require(keywords.length > 0 && keywords.length <= 5, `${label}: needs 1 to 5 keywords, has ${keywords.length}`);
  require(/^categories = \[\s*"/m.test(manifest), `${label}: categories are missing`);
  for (const section of manifest.split(/^(?=\[)/m)) {
    if (/^\[(?:[\w.-]+\.)?(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]/.test(section) && /^path = /m.test(section)) {
      throw new Error(`${label}: the normalized manifest still has a path dependency\n${section}`);
    }
  }
  for (const required of ['LICENSE', 'README.md', 'Cargo.toml.orig', 'src/lib.rs']) {
    require(file(required), `${label} does not contain ${required}`);
  }
  require(/Permission is hereby granted/.test(file('LICENSE').toString('utf8')), `${label}: LICENSE is not the MIT text`);
  for (const dependency of CRATES.filter(other => other !== name && manifest.includes(`[dependencies.${other}]`))) {
    const section = manifest.slice(manifest.indexOf(`[dependencies.${dependency}]`)).split(/\n\[/)[0];
    require(section.includes(`version = ${quote(`^${ctx.version}`)}`) || section.includes(`version = ${quote(ctx.version)}`),
      `${label}: dependency ${dependency} is not pinned to ${ctx.version}\n${section}`);
  }
  if (name === 'sendproof-core') {
    require(file('build.rs'), `${label} does not contain build.rs`);
    const ui = JSON.parse(file('ui-assets/manifest.json')?.toString('utf8') ?? 'null');
    require(ui, `${label} does not contain ui-assets/manifest.json: the workbench UI would not be embedded`);
    require(file('ui-assets/app.js')?.length > 1000, `${label} does not contain ui-assets/app.js`);
    require(file('ui-assets/index.html'), `${label} does not contain ui-assets/index.html`);
  }
}

export async function pack(ctx) {
  const staged = join(ctx.work, 'rust');
  ctx.log('staging adapters/rust');
  await stage(workspace, staged, { exclude: ['ui-assets', '.gitignore', 'Cargo.lock.bak'] });

  const rootManifest = join(staged, 'Cargo.toml');
  await writeFile(rootManifest, stampWorkspaceManifest(await readFile(rootManifest, 'utf8'), ctx));
  const license = await readFile(join(root, 'LICENSE'));
  for (const name of CRATES) {
    const manifest = join(staged, name, 'Cargo.toml');
    await writeFile(manifest, stampMemberManifest(await readFile(manifest, 'utf8')));
    await writeFile(join(staged, name, 'LICENSE'), license);
  }

  ctx.log(`packing the workbench UI into sendproof-core (${ctx.version})`);
  await run('node', [join(root, 'tools/pack-ui.mjs'), '--version', ctx.version, '--out', join(staged, 'sendproof-core/ui-assets')], { label: 'crates' });

  // `cargo package` writes to <target>/package. Remove our own earlier archives first so a stale file is never collected.
  const target = cargoTarget();
  const packageDirectory = join(target, 'package');
  const files = CRATES.map(name => `${name}-${ctx.version}.crate`);
  for (const file of files) await rm(join(packageDirectory, file), { force: true });
  await forgetUnpackedCrates(ctx);

  // Cargo's verification build compiles every crate from its .crate contents. SENDPROOF_CARGO_NO_VERIFY=1 skips it
  // for machines that cannot compile; CI never sets it.
  const noVerify = process.env.SENDPROOF_CARGO_NO_VERIFY === '1';
  ctx.log(`cargo package --workspace (${noVerify ? 'WITHOUT' : 'with'} verification build; target ${target})`);
  // Cargo also reuses compiled registry crates by version alone, so the verification build gets its own build
  // directory: a shared one would link the sibling crates against an earlier run's sendproof-core.
  await run('cargo', ['package', '--workspace', '--allow-dirty', ...(noVerify ? ['--no-verify'] : [])], {
    cwd: staged, env: { CARGO_TARGET_DIR: target, CARGO_BUILD_BUILD_DIR: join(ctx.work, 'cargo-build') }, label: 'crates',
  });

  for (const file of files) {
    const source = join(packageDirectory, file);
    require(await exists(source), `cargo package did not produce ${file}`);
    checkCrate(file.slice(0, -`-${ctx.version}.crate`.length), ctx, await readFile(source));
    await copyFile(source, join(ctx.out, file));
  }
  ctx.log(`packed ${files.join(', ')}`);
  return files;
}

// --- verify ----------------------------------------------------------------------------------------------

export async function verify(ctx) {
  const project = await tempDir('crates');
  try {
    const crates = join(project, 'crates');
    const paths = {};
    for (const name of CRATES) {
      await extractCrate(join(ctx.out, `${name}-${ctx.version}.crate`), crates);
      paths[name] = `crates/${name}-${ctx.version}`;
    }

    // Inter-crate dependencies name the registry; [patch.crates-io] redirects them to the extracted archives.
    await writeFile(join(project, 'Cargo.toml'), [
      '[package]', 'name = "bench-consumer"', 'version = "0.0.0"', 'edition = "2024"', 'publish = false', '',
      '[dependencies]',
      `sendproof-core = { path = ${quote(paths['sendproof-core'])} }`,
      `sendproof-axum = { path = ${quote(paths['sendproof-axum'])} }`,
      `sendproof-redis = { path = ${quote(paths['sendproof-redis'])} }`,
      `sendproof-dynamodb = { path = ${quote(paths['sendproof-dynamodb'])} }`,
      `sendproof-mongodb = { path = ${quote(paths['sendproof-mongodb'])} }`,
      `sendproof-cassandra = { path = ${quote(paths['sendproof-cassandra'])} }`,
      `sendproof-elasticsearch = { path = ${quote(paths['sendproof-elasticsearch'])} }`,
      `sendproof-journeys = { path = ${quote(paths['sendproof-journeys'])} }`,
      'axum = { version = "0.8", default-features = false, features = ["http1", "tokio", "json"] }',
      'serde_json = "1"',
      'tokio = { version = "1", features = ["rt-multi-thread", "net", "macros"] }', '',
      '[patch.crates-io]',
      ...CRATES.map(name => `${name} = { path = ${quote(paths[name])} }`), '',
    ].join('\n'));
    await mkdir(join(project, 'src'));
    await copyFile(join(root, 'tools/release/consumers/crates/main.rs'), join(project, 'src/main.rs'));

    const target = join(project, 'target');
    ctx.log('building the consumer against the extracted .crate archives');
    await run('cargo', ['build', '--quiet'], { cwd: project, env: { CARGO_TARGET_DIR: target }, label: 'crates' });
    await smokeServe({
      label: 'crates.io consumer',
      command: join(target, 'debug', isWindows ? 'bench-consumer.exe' : 'bench-consumer'),
      cwd: project,
      port: await freePort(),
    });

    // The publish job re-packages each extracted crate with `cargo publish --no-verify`. Make sure Cargo accepts
    // the normalized manifest inside a .crate (no workspace, no path dependencies, no git).
    const listing = await output('cargo', ['package', '--list', '--no-verify', '--allow-dirty'], { cwd: join(project, paths['sendproof-core']) });
    // Cargo prints native separators, so on Windows the entry is ui-assets\manifest.json.
    require(listing.split(/\r?\n/).map(line => line.replaceAll('\\', '/')).includes('ui-assets/manifest.json'), 'Re-packaging the extracted sendproof-core would drop ui-assets/manifest.json');
  } finally {
    if (!ctx.keep) await removeDir(project);
    else ctx.log(`kept ${project}`);
  }
}

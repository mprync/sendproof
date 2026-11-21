#!/usr/bin/env node
// Builds every Sendproof binding into the package format its registry publishes, one directory per
// registry under artifacts/packages/, each with a SHA256SUMS file and a RELEASE.json description.
//
//   node tools/pack-all.mjs                      build every registry whose toolchain is installed
//   node tools/pack-all.mjs --verify             also install each archive into a fresh consumer app
//   node tools/pack-all.mjs --only npm,pypi      build selected registries
//   node tools/pack-all.mjs --release --version 1.2.3   CI tag build: strict, every toolchain required
//
// Version: --version, else $PACKAGE_VERSION, else Directory.Build.props (VersionPrefix-VersionSuffix).
// Repository: adapters/go/MODULE_PATH (change it with tools/set-go-module-path.mjs). Every registry's
// repository, homepage and issue links are stamped from it at pack time, so tracked manifests never
// carry a second copy. Registry modules live in tools/release/<id>.mjs; see tools/release/README.md.

import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  canonicalRepository, cleanDir, defaultVersion, output, parseRepository, releaseVersions, root,
  verifyChecksums, writeChecksums, writeJson,
} from './release/lib.mjs';

const REGISTRIES = ['nuget', 'npm', 'pypi', 'maven', 'crates', 'rubygems', 'packagist', 'go'];

const { values } = parseArgs({
  options: {
    verify: { type: 'boolean', default: false },
    only: { type: 'string' },
    skip: { type: 'string' },
    version: { type: 'string' },
    release: { type: 'boolean', default: false },
    'require-toolchains': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    out: { type: 'string', default: join(root, 'artifacts', 'packages') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: node tools/pack-all.mjs [--verify] [--only ${REGISTRIES.join(',')}] [--skip ...]
       [--version X.Y.Z[-alpha.N]] [--release] [--require-toolchains] [--keep] [--out dir]

  --verify               install each built archive into a throwaway consumer app and probe /sendproof/
  --release              tag build: needs --version or PACKAGE_VERSION, fails on any missing toolchain,
                         and requires GITHUB_REPOSITORY (when set) to match adapters/go/MODULE_PATH
  --require-toolchains   fail instead of skipping a registry whose toolchain is missing
  --keep                 keep consumer and staging directories for inspection`);
  process.exit(0);
}

const list = value => value ? value.split(',').map(entry => entry.trim()).filter(Boolean) : [];
const unknown = [...list(values.only), ...list(values.skip)].filter(id => !REGISTRIES.includes(id));
if (unknown.length) throw new Error(`Unknown registry: ${unknown.join(', ')} (expected ${REGISTRIES.join(', ')})`);
const selected = (values.only ? list(values.only) : REGISTRIES).filter(id => !list(values.skip).includes(id));

const semver = values.version ?? process.env.PACKAGE_VERSION ?? (values.release ? undefined : defaultVersion());
if (!semver) throw new Error('--release needs --version or PACKAGE_VERSION');
const versions = releaseVersions(semver.replace(/^v/, ''));
const repository = canonicalRepository();
const requireToolchains = values.release || values['require-toolchains'];

if (process.env.GITHUB_REPOSITORY) {
  const running = parseRepository(`${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`);
  if (running.url.toLowerCase() !== repository.url.toLowerCase()) {
    const message = `This workflow runs in ${running.url}, but adapters/go/MODULE_PATH names ${repository.url}. ` +
      'Run node tools/set-go-module-path.mjs github.com/<owner>/<repo> and commit the result before releasing.';
    if (values.release) throw new Error(message);
    console.warn(`warning: ${message} Packages are stamped with ${repository.url}.`);
  }
}

let commit = null;
try { commit = await output('git', ['rev-parse', 'HEAD']); } catch { /* not a git checkout */ }

const metadata = {
  authors: ['Sendproof contributors'],
  license: 'MIT',
  homepage: repository.url,
  issues: `${repository.url}/issues`,
  keywords: ['openapi', 'api-testing', 'workbench', 'swagger', 'rollback'],
};

const results = [];
await mkdir(values.out, { recursive: true });
console.log(`Packing Sendproof ${versions.semver} for ${selected.join(', ')} (repository ${repository.url})`);

for (const id of selected) {
  const module = await import(`./release/${id}.mjs`);
  const out = join(values.out, id);
  const work = join(root, 'artifacts', 'release-work', id);
  const ctx = {
    id, root, out, work, versions, version: versions.semver, repository, commit, metadata,
    keep: values.keep, release: values.release,
    log: message => console.log(`[${id}] ${message}`),
  };
  const result = { id, title: module.title, pack: 'skipped', verify: values.verify ? 'skipped' : 'not run', note: '' };
  results.push(result);

  const missing = await module.available(ctx);
  if (missing) {
    result.note = missing;
    if (requireToolchains) {
      result.pack = 'failed';
      console.error(`[${id}] ${missing}`);
    } else {
      console.warn(`[${id}] skipped: ${missing}`);
    }
    continue;
  }

  try {
    console.log(`\n=== ${module.title}: pack ===`);
    await cleanDir(out);
    await cleanDir(work);
    const files = await module.pack(ctx);
    await writeJson(join(out, 'RELEASE.json'), {
      registry: id, version: versions.semver, registryVersion: module.registryVersion?.(versions) ?? versions.semver,
      repository: repository.url, commit, files: files ?? [],
    });
    await writeChecksums(out);
    result.pack = 'passed';
  } catch (error) {
    result.pack = 'failed';
    result.note = firstLine(error);
    console.error(`[${id}] pack failed:\n${error.stack ?? error}`);
    continue;
  }

  if (values.verify) {
    try {
      console.log(`\n=== ${module.title}: consumer smoke test ===`);
      await module.verify(ctx);
      // The consumer must not have changed what will be uploaded.
      await verifyChecksums(out);
      result.verify = 'passed';
    } catch (error) {
      result.verify = 'failed';
      result.note = firstLine(error);
      console.error(`[${id}] verify failed:\n${error.stack ?? error}`);
    }
  }
  if (!values.keep) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const table = [
  '| Registry | Pack | Consumer smoke test | Note |',
  '| --- | --- | --- | --- |',
  ...results.map(entry => `| ${entry.title} | ${entry.pack} | ${entry.verify} | ${entry.note.replace(/\|/g, '\\|')} |`),
].join('\n');
console.log(`\nSendproof ${versions.semver} packages in ${values.out}\n\n${table}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Packages ${versions.semver}\n\n${table}\n`);
if (results.some(entry => entry.pack === 'failed' || entry.verify === 'failed')) process.exitCode = 1;

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0].slice(0, 160);
}

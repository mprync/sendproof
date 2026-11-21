// Go: modules are released by pushing path-prefixed git tags (adapters/go/vX.Y.Z, adapters/go/chi/vX.Y.Z, ...);
// the module proxy builds its zips from those tags. There is no upload.
//
// pack    adapters/go/scripts/package.sh: checks MODULE_PATH, internal requirements at this version and the
//         embedded UI, runs vet and the race tests, and writes the module zips the proxy will serve plus
//         tags.txt (core first).
// verify  adapters/go/scripts/verify-release.sh: retargets a copy to a placeholder repository and proves a
//         fresh consumer (GOWORK=off, empty module cache) resolves every module from the zips and from the
//         tags, then serves the workbench and its OpenAPI document.
//
// Both scripts are bash; on Windows they run in Git for Windows' bash, which GitHub runners include.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWindows, removeDir, require, root, run, which } from './lib.mjs';

export const title = 'Go modules';

const GO = join(root, 'adapters', 'go');
/** Released modules: core, chi, gin, echo, gorm, and the redisbench, dynamobench and mongobench store modules. */
const MODULE_COUNT = 8;

/** Git for Windows' bash (never the WSL launcher in System32), or bash on PATH elsewhere. */
export function bash() {
  if (isWindows) {
    const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean).map(base => join(base, 'Git', 'bin', 'bash.exe'));
    return candidates.find(path => existsSync(path)) ?? null;
  }
  return which('bash');
}

export const registryVersion = versions => `v${versions.semver}`;

export async function available() {
  if (!bash()) return 'bash is required (Git for Windows on Windows)';
  if (!which('git')) return 'git is not on PATH';
  // go.sh uses a Go on PATH or the pinned toolchain in artifacts/go-toolchain, installing it on demand.
  if (!which('go') && !existsSync(join(root, 'artifacts', 'go-toolchain', 'go', 'bin', 'go')) && !which('curl')) {
    return 'neither Go nor curl (to install the pinned Go toolchain) is available';
  }
  return null;
}

export async function pack(ctx) {
  const version = registryVersion(ctx.versions);
  await run(bash(), [join(GO, 'scripts', 'package.sh'), version, ctx.out], { cwd: root, label: 'go' });
  const tags = (await readFile(join(ctx.out, 'tags.txt'), 'utf8')).trim().split('\n');
  require(tags[0] === `adapters/go/${version}` && tags.length === MODULE_COUNT, `unexpected tags.txt: ${tags.join(', ')}`);
  ctx.log(`tags to push, core first: ${tags.join(' ')}`);
  const zips = (await readdir(ctx.out)).filter(name => name.endsWith('.zip')).sort();
  require(zips.length === MODULE_COUNT, `expected ${MODULE_COUNT} module zips, found ${zips.length}`);
  return ['tags.txt', ...zips];
}

export async function verify(ctx) {
  await run(bash(), [join(GO, 'scripts', 'verify-release.sh'), registryVersion(ctx.versions)], { cwd: root, label: 'go' });
  // The check's copy, fresh module caches and git repository take about 1 GB.
  if (!ctx.keep) await removeDir(join(root, 'artifacts', 'go-release-check'));
}

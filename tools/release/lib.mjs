// Shared helpers for tools/pack-all.mjs and the per-registry modules in tools/release/.
//
// Everything here is cross-platform (Linux, macOS, Windows) and uses only Node built-ins, so the
// release build needs no npm install. Registry modules receive these helpers through `ctx`
// (see pack-all.mjs) and should not spawn processes or write checksums any other way.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const isWindows = process.platform === 'win32';

/** Prerelease labels every registry can express (npm/Cargo/Maven/NuGet SemVer, PEP 440, RubyGems, Composer). */
const PRERELEASE = { alpha: 'a', beta: 'b', rc: 'rc' };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

/**
 * Converts one SemVer release version into each registry's spelling.
 * Only `X.Y.Z` and `X.Y.Z-(alpha|beta|rc).N` are accepted, because those are the forms PEP 440,
 * RubyGems and Composer can all represent without ambiguity.
 */
export function releaseVersions(semver) {
  const match = SEMVER.exec(semver);
  if (!match) {
    throw new Error(`Release version ${JSON.stringify(semver)} must be X.Y.Z or X.Y.Z-(alpha|beta|rc).N`);
  }
  const [, major, minor, patch, label, number] = match;
  const core = `${major}.${minor}.${patch}`;
  return {
    semver,
    prerelease: Boolean(label),
    // PEP 440: 1.2.3a1, 1.2.3b2, 1.2.3rc1
    pep440: label ? `${core}${PRERELEASE[label]}${number}` : core,
    // RubyGems treats any letter segment as a prerelease: 1.2.3.alpha.1
    rubygems: label ? `${core}.${label}.${number}` : core,
    // npm dist-tag: prereleases never become `latest`.
    npmTag: label ? 'next' : 'latest',
  };
}

/** Reads the default version from Directory.Build.props (VersionPrefix + VersionSuffix), as the .NET build does. */
export function defaultVersion() {
  const props = readFileSync(join(root, 'Directory.Build.props'), 'utf8');
  const prefix = /<VersionPrefix>([^<]+)<\/VersionPrefix>/.exec(props)?.[1]?.trim();
  const suffix = /<VersionSuffix>([^<]*)<\/VersionSuffix>/.exec(props)?.[1]?.trim();
  if (!prefix) throw new Error('Directory.Build.props has no VersionPrefix');
  return suffix ? `${prefix}-${suffix}` : prefix;
}

/**
 * The canonical repository is the one adapters/go/MODULE_PATH names, because Go modules can only be
 * consumed from that path. tools/set-go-module-path.mjs changes it, and every other registry's
 * repository URL follows. Returns { url, host, owner, name }.
 */
export function canonicalRepository() {
  const modulePath = readFileSync(join(root, 'adapters/go/MODULE_PATH'), 'utf8').trim();
  const match = /^([^/]+)\/([^/]+)\/([^/]+)\/adapters\/go$/.exec(modulePath);
  if (!match) throw new Error(`adapters/go/MODULE_PATH must be <host>/<owner>/<repo>/adapters/go, got ${modulePath}`);
  const [, host, owner, name] = match;
  return { url: `https://${host}/${owner}/${name}`, host, owner, name, modulePath };
}

/** Parses an https repository URL into { url, host, owner, name }. */
export function parseRepository(value) {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) throw new Error(`Repository URL must look like https://github.com/<owner>/<repo>, got ${value}`);
  const [, host, owner, name] = match;
  return { url: `https://${host}/${owner}/${name}`, host, owner, name };
}

/** Resolves a command on PATH (honouring PATHEXT on Windows). Returns the full path or null. */
export function which(command) {
  if (command.includes('/') || command.includes('\\')) return isFile(command) ? command : null;
  // The bare name goes last on Windows: npm, for one, has an extensionless shell script beside npm.cmd that cannot be spawned.
  const extensions = isWindows ? [...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Finds a Python 3.10+ interpreter: python3, python, then the Windows launcher. */
export function findPython() {
  const candidates = isWindows ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  for (const [command, ...prefix] of candidates) {
    const path = which(command);
    if (!path) continue;
    const result = spawnSync(path, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const [major, minor] = (result.stdout ?? '').trim().split('.').map(Number);
    if (result.status === 0 && (major > 3 || (major === 3 && minor >= 10))) return [path, ...prefix];
  }
  return null;
}

/** Path of the interpreter inside a virtual environment, on any platform. */
export function venvPython(venv) {
  return isWindows ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
}

/**
 * Runs a command and resolves when it exits 0; rejects with the tail of its output otherwise.
 * Output streams to the terminal with a `[label]` prefix so interleaved registries stay readable.
 * Windows `.cmd`/`.bat` shims (npm, gradlew.bat, bundle) are run through cmd.exe with quoted arguments.
 */
export async function run(command, args = [], { cwd = root, env = {}, label, quiet = false, capture = false, input, secrets = [] } = {}) {
  const resolved = which(command) ?? command;
  const viaShell = isWindows && /\.(cmd|bat)$/i.test(resolved);
  const child = spawn(viaShell ? `"${resolved}"` : resolved, viaShell ? args.map(quoteForCmd) : args, {
    cwd, env: { ...process.env, ...env }, shell: viaShell, windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (input !== undefined) child.stdin.end(input);
  const prefix = label ? `[${label}] ` : '';
  let tail = '';
  let stdout = '';
  const forward = (stream, target) => {
    let pending = '';
    stream.on('data', chunk => {
      const text = chunk.toString();
      tail = (tail + text).slice(-8000);
      if (capture && target === process.stdout) stdout += text;
      if (quiet) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
    stream.on('end', () => { if (pending && !quiet) target.write(`${prefix}${pending}\n`); });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  const [code, signal] = await new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, exitSignal) => resolvePromise([exitCode, exitSignal]));
  });
  if (code !== 0) {
    // `secrets` (tokens passed as arguments) never appear in the error message.
    const scrub = text => secrets.reduce((value, secret) => secret ? value.split(secret).join('***') : value, text);
    const error = new Error(scrub(`${[command, ...args].join(' ')} failed (${signal ?? `exit ${code}`}) in ${cwd}\n${quiet ? tail : ''}`));
    error.output = scrub(tail);
    throw error;
  }
  return capture ? stdout : undefined;
}

function quoteForCmd(argument) {
  return /^[\w@%+=:,./\\-]+$/.test(argument) ? argument : `"${argument.replace(/"/g, '""')}"`;
}

/** Runs a command and returns its trimmed standard output. */
export async function output(command, args = [], options = {}) {
  return (await run(command, args, { ...options, capture: true, quiet: true })).trim();
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Lists every file below `directory` as sorted POSIX-style relative paths. */
export async function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join('/'));
  }
  return files.sort();
}

/**
 * Writes SHA256SUMS in `sha256sum --check` format (two spaces, POSIX paths) for every file in
 * `directory` except SHA256SUMS itself. Returns the list of files covered.
 */
export async function writeChecksums(directory) {
  const files = (await listFiles(directory)).filter(file => file !== 'SHA256SUMS');
  if (!files.length) throw new Error(`No packages were written to ${directory}`);
  const lines = [];
  for (const file of files) lines.push(`${sha256(await readFile(join(directory, file)))}  ${file}`);
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return files;
}

/** Re-checks SHA256SUMS in `directory`; throws on a missing, extra or changed file. */
export async function verifyChecksums(directory) {
  const text = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const expected = new Map(text.trim().split('\n').map(line => {
    const [hash, file] = line.split(/ {2}/);
    return [file, hash];
  }));
  const actual = (await listFiles(directory)).filter(file => file !== 'SHA256SUMS');
  for (const file of actual) {
    if (!expected.has(file)) throw new Error(`${file} is not listed in SHA256SUMS`);
    if (sha256(await readFile(join(directory, file))) !== expected.get(file)) throw new Error(`${file} does not match SHA256SUMS`);
  }
  for (const file of expected.keys()) if (!actual.includes(file)) throw new Error(`${file} is listed in SHA256SUMS but missing`);
}

/** Recreates `directory` empty. Refuses anything outside the repository's artifacts/ or the OS temp dir. */
export async function cleanDir(directory) {
  const target = resolve(directory);
  // tempDir() hands out real paths (no 8.3 short names), so the real spelling of the temp dir is allowed too.
  const allowed = [join(root, 'artifacts') + sep, resolve(tmpdir()) + sep, realpathSync(tmpdir()) + sep];
  if (!allowed.some(prefix => target.startsWith(prefix))) throw new Error(`Refusing to clean ${target}`);
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(target, { recursive: true });
  return target;
}

/**
 * Copies a source tree into a staging directory so release metadata can be stamped without touching
 * tracked files. `exclude` holds directory or file names skipped at any depth.
 */
export async function stage(source, destination, { exclude = [] } = {}) {
  const skip = new Set(['node_modules', '.git', '.venv', 'target', '.gradle', 'build', 'vendor', '__pycache__',
    '.pytest_cache', '.phpunit.cache', 'dist', '.cache', ...exclude]);
  await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await cp(source, destination, {
    recursive: true,
    filter: path => !skip.has(path.split(/[\\/]/).pop()) || resolve(path) === resolve(source),
  });
  return destination;
}

/** Creates a throwaway directory outside the repository, so no workspace, go.work or Cargo workspace applies. */
export async function tempDir(name) {
  // realpath expands Windows 8.3 names (C:\Users\RUNNER~1): a program that sees one file under both spellings loads it
  // twice, which breaks ActiveSupport's `with` core extension, among others.
  return realpath(await mkdtemp(join(tmpdir(), `sendproof-${name}-`)));
}

export async function removeDir(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

/** Asks the OS for a free loopback port. */
export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

/** Stops a process and all of its children (process group on POSIX, taskkill /T on Windows). */
export async function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  const closed = once(child, 'close').catch(() => {});
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const timer = delay(5000).then(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    await Promise.race([closed, timer]);
  }
  await closed;
}

/**
 * Starts a consumer application and proves it serves the workbench and its OpenAPI document:
 *
 *   GET {base}/sendproof/                  200, an HTML page
 *   GET {base}/sendproof/app.js            200, the embedded UI script (more than 1 KB)
 *   GET {base}/sendproof/_api/capabilities 200, discovery JSON naming openApiUrl
 *   GET openApiUrl                     200, a JSON document with "openapi": "3.x"
 *
 * The application must listen on 127.0.0.1:$PORT (PORT is set in its environment).
 */
export async function smokeServe({ label, command, args = [], cwd, env = {}, port, base = '', startupMs = 120000 }) {
  port ??= await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const resolved = which(command) ?? command;
  const viaShell = isWindows && /\.(cmd|bat)$/i.test(resolved);
  const child = spawn(viaShell ? `"${resolved}"` : resolved, viaShell ? args.map(quoteForCmd) : args, {
    cwd, detached: !isWindows, windowsHide: true, shell: viaShell,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let failed;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-12000); });
  child.on('error', error => { failed = error; });
  const get = async path => {
    const response = await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
  };
  try {
    const deadline = Date.now() + startupMs;
    let page;
    while (Date.now() < deadline && child.exitCode === null && !failed) {
      try {
        page = await get(`${base}/sendproof/`);
        if (page.status === 200) break;
      } catch (error) {
        if (error.name !== 'TypeError' && error.name !== 'TimeoutError') throw error;
      }
      await delay(250);
    }
    if (page?.status !== 200) {
      throw new Error(`${label}: consumer did not serve ${base}/sendproof/ (${failed?.message ?? (child.exitCode !== null ? `exit ${child.exitCode}` : page ? `status ${page.status}` : 'timed out')})\n${log}`);
    }
    if (!/<html/i.test(page.body)) throw new Error(`${label}: ${base}/sendproof/ is not the workbench page`);
    const script = await get(`${base}/sendproof/app.js`);
    if (script.status !== 200 || script.body.length < 1000) {
      throw new Error(`${label}: ${base}/sendproof/app.js returned ${script.status} with ${script.body.length} bytes; the embedded UI is missing`);
    }
    const discovery = await get(`${base}/sendproof/_api/capabilities`);
    if (discovery.status !== 200) throw new Error(`${label}: capabilities returned ${discovery.status}\n${discovery.body.slice(0, 400)}`);
    const capabilities = JSON.parse(discovery.body);
    if (typeof capabilities.openApiUrl !== 'string') throw new Error(`${label}: capabilities has no openApiUrl`);
    const spec = await get(new URL(capabilities.openApiUrl, `${origin}${base}/sendproof/`).pathname);
    if (spec.status !== 200) throw new Error(`${label}: ${capabilities.openApiUrl} returned ${spec.status}`);
    if (!/^3\./.test(JSON.parse(spec.body).openapi ?? '')) throw new Error(`${label}: ${capabilities.openApiUrl} is not an OpenAPI 3 document`);
    return { port, capabilities };
  } finally {
    await killTree(child);
  }
}

/** Reads and parses a JSON file. */
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Writes JSON with two-space indentation and a trailing newline. */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** True when `path` exists. */
export async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/** Throws with `message` unless `condition` holds. */
export function require(condition, message) {
  if (!condition) throw new Error(message);
}

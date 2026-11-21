import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let host, temp;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function startHost() {
  if (process.env.SENDPROOF_URL) return process.env.SENDPROOF_URL.replace(/\/$/, '').replace(/\/sendproof$/, '');
  temp = await mkdtemp(join(tmpdir(), 'sendproof-browser-'));
  const url = `http://127.0.0.1:${await freePort()}`;
  let output = '';
  const buildArgs = process.argv.includes('--no-build') ? ['--no-build', '--no-restore'] : [];
  host = spawn('dotnet', ['run', '--project', 'examples/TreasuryApi', '-c', 'Release',
    ...buildArgs, '--no-launch-profile', '--urls', url], {
    cwd: root, env: {
      ...process.env, ASPNETCORE_ENVIRONMENT: 'Development',
      DemoDatabasePath: join(temp, 'treasury.db'), DemoKeyDirectory: join(temp, 'keys'),
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stdout.on('data', data => { output += data; });
  host.stderr.on('data', data => { output += data; });
  let exit;
  host.once('error', error => { exit = error; });
  host.once('exit', code => { exit = new Error(`Example host exited (${code})`); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`${exit}\n${output}`);
    try { if ((await fetch(`${url}/sendproof`)).ok) return url; } catch { /* still starting */ }
    await delay(300);
  }
  throw new Error(`Example host did not become ready at ${url}\n${output}`);
}

export async function stopHost() {
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    const ended = new Promise(resolve => host.once('exit', resolve));
    if (process.platform === 'win32') host.kill('SIGTERM');
    else process.kill(-host.pid, 'SIGTERM');
    await Promise.race([ended, delay(5000, undefined, { ref: false })]);
    if (host.exitCode === null && host.signalCode === null) {
      if (process.platform === 'win32') host.kill('SIGKILL');
      else process.kill(-host.pid, 'SIGKILL');
      await ended;
    }
  }
  if (temp) await rm(temp, { recursive: true, force: true });
}


/**
 * With SENDPROOF_UI_DIR set (for example `ui`), serves the workbench files from that directory
 * instead of the host's embedded copy: UI edits can be checked against a host built earlier, and
 * against one that can't be rebuilt right now. The API under /sendproof/_api always comes from the host.
 */
export async function serveUiFromDirectory(context) {
  if (!process.env.SENDPROOF_UI_DIR) return;
  const directory = resolve(root, process.env.SENDPROOF_UI_DIR);
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  };
  await context.route(/\/sendproof\/(?!_api\/)[^?]*(\?.*)?$/, async route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/sendproof\//, '')) || 'index.html';
    const file = resolve(directory, name);
    if (!types[extname(name)] || !file.startsWith(`${directory}/`)) return route.fallback();
    try { await route.fulfill({ body: await readFile(file), contentType: types[extname(name)] }); } catch { await route.fallback(); }
  });
}

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withFixtureDatabase } from './database.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';

/**
 * Resolves a manifest command for this platform. On Windows, `bash` and `sh` mean Git for Windows'
 * shells (never the WSL launcher in System32) and a virtual environment's `bin/` is `Scripts/`.
 */
export function platformCommand(command) {
  if (!windows) return command;
  if (command === 'bash' || command === 'sh') {
    const git = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
      .map(base => join(base, 'Git', 'bin', `${command}.exe`)).find(path => existsSync(path));
    return git ?? command;
  }
  return command.replace(/(^|[\\/])\.venv[\\/]bin[\\/]/, '$1.venv/Scripts/');
}

/** Replaces ${PORT} and ${BENCH_TMP_DIR} in start arguments, so no shell is needed to pass them. */
function expand(argument, values) {
  return argument.replace(/\$\{(PORT|BENCH_TMP_DIR)\}/g, (_match, name) => values[name]);
}

/** Stops the fixture and its children: its process group on POSIX, its process tree on Windows. */
function signalTree(pid, value) {
  if (windows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, value); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function withFixture(binding, scenario, base, run) {
  return withFixtureDatabase(binding.database ?? 'sqlite', database =>
    runFixture(binding, scenario, base, run, database));
}

async function runFixture(binding, scenario, base, run, database) {
  const [command, ...args] = binding.start;
  const origin = `http://127.0.0.1:${binding.port}`;
  const workspace = await mkdtemp(join(tmpdir(), 'sendproof-conformance-'));
  const values = { PORT: String(binding.port), BENCH_TMP_DIR: workspace };
  const host = spawn(platformCommand(command), args.map(argument => expand(argument, values)), {
    cwd: root,
    // A process group lets POSIX stop the fixture's children too; Windows uses taskkill /T instead.
    detached: !windows,
    windowsHide: true,
    env: {
      ...process.env, ...binding.env, ...database.env, PORT: String(binding.port),
      BENCH_PATH_BASE: base, BENCH_SCENARIO: scenario, BENCH_TMP_DIR: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [host.stdout, host.stderr]) {
    stream.on('data', bytes => { output = (output + bytes).slice(-15000); });
  }
  const closed = once(host, 'close').catch(error => [null, error.message]);
  let hostError;
  host.on('error', error => { hostError = error; });

  const request = (path, { method = 'GET', headers = {}, body, cookie } = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error(`Fixture returned an off-origin URL: ${path}`);
    return fetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  try {
    const deadline = Date.now() + (binding.startupMs ?? 30000);
    let ready = false;
    while (Date.now() < deadline && host.exitCode === null && !hostError) {
      try {
        const response = await request(base + binding.readiness);
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch (error) {
        if (error.name !== 'TimeoutError' && error.name !== 'TypeError') throw error;
      }
      await delay(125);
    }
    if (!ready || host.exitCode !== null || hostError) {
      throw new Error(`Fixture ${binding.id} did not start (${hostError?.message ?? host.exitCode ?? 'timed out'}).\n${output}`);
    }

    // The third argument lets the load harness (tests/load) sample the fixture's process group and talk to it directly.
    return await run(request, database, { origin, pid: host.pid, base, output: () => output });
  } finally {
    try {
      if (host.pid) {
        const signal = value => signalTree(host.pid, value);
        signal('SIGTERM');
        const stopping = new AbortController();
        try {
          await Promise.race([
            closed,
            delay(2000, undefined, { signal: stopping.signal }).then(() => signal('SIGKILL')),
          ]);
          await closed;
        } finally {
          stopping.abort();
        }
      }
    } finally {
      // Windows keeps SQLite files locked briefly after the process tree exits.
      await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
}

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withFixtureDatabase } from './database.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));

export function withFixture(binding, scenario, base, run) {
  return withFixtureDatabase(binding.database ?? 'sqlite', database =>
    runFixture(binding, scenario, base, run, database));
}

async function runFixture(binding, scenario, base, run, database) {
  const [command, ...args] = binding.start;
  const origin = `http://127.0.0.1:${binding.port}`;
  const workspace = await mkdtemp(join(tmpdir(), 'test-bench-conformance-'));
  const host = spawn(command, args, {
    cwd: root,
    detached: true,
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

    return await run(request, database);
  } finally {
    try {
      if (host.pid) {
        const signal = value => {
          try { process.kill(-host.pid, value); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        };
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
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

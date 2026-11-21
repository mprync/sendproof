#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { root } from '../conformance/host.mjs';
import { engines } from '../conformance/database.mjs';
import { concurrencyPhase } from './phases/concurrency.mjs';
import { contentionPhase } from './phases/contention.mjs';
import { idlePhase } from './phases/idle.mjs';
import { soakPhase } from './phases/soak.mjs';
import { renderMarkdown } from './lib/report.mjs';

/**
 * Load and performance harness for one conformance binding.
 *
 *   node tests/load/run.mjs <binding-id> [--profile quick|soak] [--only idle,concurrency,soak,contention] [--prepare]
 *
 * It reuses the conformance fixture host (`tests/conformance/host.mjs`) and manifest, so a binding is started, awaited
 * and stopped exactly as the conformance runner does it, with a disposable database. Phases:
 *   idle        cost of the bench on ordinary routes (disabled vs enabled), plus Preview and observed Send cost
 *   concurrency Preview rollback, isolation and observed Send commit-once under concurrent requests
 *   soak        RSS of the fixture over a sustained mixed workload with payloads near the capture limits
 *   contention  PostgreSQL only: effect of running Previews on concurrent normal traffic on the same table
 * `contention` runs only for PostgreSQL bindings. Results go to tests/load/results/<id>-<profile>.{json,md}.
 */
const { values, positionals } = parseArgs({
  options: {
    profile: { type: 'string', default: 'quick' },
    only: { type: 'string' },
    prepare: { type: 'boolean' },
    'port-offset': { type: 'string' },
    out: { type: 'string' },
    'no-docker': { type: 'boolean' },
  },
  allowPositionals: true,
});
const manifest = JSON.parse(await readFile(new URL('../conformance/bindings.json', import.meta.url), 'utf8'));
const config = JSON.parse(await readFile(new URL('./profiles.json', import.meta.url), 'utf8'));
const [id] = positionals;
assert(id, 'Usage: node tests/load/run.mjs <binding-id> [--profile quick|soak] [--only idle,concurrency,soak,contention] [--prepare]');
const entry = manifest.bindings.find(binding => binding.id === id);
assert(entry, `Unknown binding: ${id}. List them with: node tests/conformance/run.mjs --list`);
const plan = config.plans[values.profile];
assert(plan, `Unknown profile: ${values.profile} (use ${Object.keys(config.plans).join(' or ')})`);
const { _comment, ...overrides } = config.overrides;
const binding = { ...entry, ...(overrides[id] ?? {}), port: entry.port + Number(values['port-offset'] ?? 0) };
assert(engines.has(binding.database));

const available = ['idle', 'concurrency', 'soak', ...(binding.database === 'postgresql' ? ['contention'] : [])];
const phases = values.only ? values.only.split(',') : available;
for (const phase of phases) assert(available.includes(phase), `Phase ${phase} is not available for ${id} (available: ${available.join(', ')})`);

const log = message => console.error(`[${id}] ${message}`);

/** Runs a shell command in the repository root, inheriting output. */
async function shell(command) {
  const child = spawn('bash', ['-euo', 'pipefail', '-c', command], { cwd: root, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `Command failed: ${command}`);
}

/**
 * Starts a throwaway PostgreSQL container when no server URL is configured, and removes it afterwards.
 *
 * It uses its own container name and port (55433) so it never touches the conformance compose services, and keeps the data
 * on tmpfs so no volume is left behind. Set BENCH_POSTGRES_URL to use an existing server instead (it receives one random
 * database per fixture, as in the conformance runner).
 */
async function withDatabaseService(run) {
  if (binding.database !== 'postgresql' || process.env.BENCH_POSTGRES_URL || values['no-docker']) return run();
  const name = 'sendproof-load-postgres';
  log(`starting disposable PostgreSQL container ${name} on 127.0.0.1:55433`);
  await shell(`docker rm -f ${name} >/dev/null 2>&1 || true`);
  await shell([
    'docker run -d --rm', `--name ${name}`, '-p 127.0.0.1:55433:5432', '--tmpfs /var/lib/postgresql/data',
    '-e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench_local -e POSTGRES_DB=postgres', 'postgres:17-alpine',
  ].join(' '));
  try {
    await shell(`for i in $(seq 1 60); do docker exec ${name} pg_isready -U bench -d postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`);
    process.env.BENCH_POSTGRES_URL = 'postgresql://bench:bench_local@127.0.0.1:55433/postgres';
    // Docker Desktop's port proxy can reset connections for a little while after a container starts. Wait until the host
    // side answers ten connections in a row, so those resets never show up as load-test errors.
    await shell(`cd tests/conformance && node -e "
      const { Client } = require('pg');
      (async () => {
        let streak = 0;
        for (let attempt = 0; attempt < 120 && streak < 10; attempt++) {
          const client = new Client({ connectionString: process.env.BENCH_POSTGRES_URL });
          client.on('error', () => {});
          try { await client.connect(); await client.query('select 1'); await client.end(); streak++; }
          catch { streak = 0; await new Promise(r => setTimeout(r, 500)); }
        }
        process.exit(streak >= 10 ? 0 : 1);
      })();"`);
    return await run();
  } finally {
    log('removing PostgreSQL container');
    await shell(`docker rm -f ${name} >/dev/null 2>&1 || true`);
    delete process.env.BENCH_POSTGRES_URL;
  }
}

if (values.prepare && binding.prepare) {
  log('preparing: ' + binding.prepare);
  await shell(binding.prepare);
}

/**
 * Waits until few sockets are in TIME_WAIT. Servers that close every connection (some development servers) make a load run
 * burn through the ephemeral port range; the next phase would then see connection errors that are not the app's fault.
 */
async function waitForPorts() {
  for (let attempt = 0; attempt < 90; attempt++) {
    let waiting = 0;
    try { waiting = execFileSync('netstat', ['-an', '-p', 'tcp']).toString().split('\n').filter(line => line.includes('TIME_WAIT')).length; } catch { return; }
    if (waiting < 2500) return;
    if (attempt === 0) log(`waiting for ${waiting} TIME_WAIT sockets to drain`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const result = {
  binding: id, profile: values.profile, database: binding.database, toolchain: binding.toolchain, start: binding.start,
  startedAt: new Date().toISOString(), phases,
  machine: {
    cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version, gitCommit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { return null; } })(),
  },
};

try {
  await withDatabaseService(async () => {
    const runners = { idle: idlePhase, concurrency: concurrencyPhase, soak: soakPhase, contention: contentionPhase };
    for (const phase of phases) {
      await waitForPorts();
      log(`phase: ${phase}`);
      // Host load before and after each phase (1-minute average). Numbers taken while other work saturated the machine are suspect.
      const loadBefore = Number(os.loadavg()[0].toFixed(1));
      result[phase] = await runners[phase](binding, plan[phase], log);
      (result.hostLoad ??= {})[phase] = { before: loadBefore, after: Number(os.loadavg()[0].toFixed(1)) };
    }
  });
} catch (error) {
  // A failure while the disposable database is being dropped must not discard measurements that were already taken.
  if (!phases.every(phase => result[phase])) throw error;
  console.error(`[${id}] warning: cleanup failed after all phases finished: ${error.message}`);
}

// Idle and soak tolerate a handful of failures per thousand requests: SQLite fixtures occasionally time out on the single write lock
// (see docs/performance.md), which is an engine limit rather than a Sendproof fault. Preview and Send correctness checks stay strict.
result.passed = (result.concurrency?.passed ?? true) && (result.contention?.passed ?? true) &&
  (result.soak ? result.soak.memory.bounded !== false && result.soak.load.errorRate < 0.01 : true) &&
  (result.idle ? Object.values(result.idle.comparison).every(row => (row.disabled?.errorRate ?? 0) < 0.001 && (row.enabled?.errorRate ?? 0) < 0.001) : true);

const markdown = renderMarkdown(result);
const directory = new URL(values.out ? `file://${values.out}/` : './results/', import.meta.url);
await mkdir(directory, { recursive: true });
const stem = `${id}-${values.profile}`;
await writeFile(new URL(`${stem}.json`, directory), JSON.stringify(result, null, 2) + '\n');
await writeFile(new URL(`${stem}.md`, directory), markdown);
console.log(markdown);
console.log(`Wrote ${new URL(`${stem}.json`, directory).pathname}`);
process.exitCode = result.passed ? 0 : 1;

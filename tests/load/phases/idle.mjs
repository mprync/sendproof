import { withFixture } from '../../conformance/host.mjs';
import { createClient, drive, round } from '../lib/client.mjs';

const median = values => {
  const sorted = values.filter(value => value !== null && value !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/**
 * Idle overhead: what the bench costs an ordinary route in production.
 *
 * The fixtures offer no build without the bench, so the baseline is the `disabled` scenario: the same app with the bench
 * middleware installed but switched off by environment (the production default). `standard` is the same app with the bench
 * enabled, still receiving ordinary requests that carry no Preview or trace header.
 *
 * Both fixtures run at once on different ports and the harness alternates short bursts between them (A B, B A, A B ...),
 * so machine noise and thermal drift hit both sides equally. Each route and concurrency is reported as the median over
 * `plan.bursts` bursts. A throughput ratio near 1.0 means the middleware is free when it is not asked to do anything.
 *
 * Preview, plain Send and observed Send are measured on the enabled fixture only, as bench feature costs.
 */
export async function idlePhase(binding, plan, log) {
  const enabledBinding = { ...binding, port: binding.port + 600 };
  return withFixture(binding, 'disabled', '', (_a, _b, off) =>
    withFixture(enabledBinding, 'standard', '', async (_c, _d, on) => {
      const sides = {};
      for (const [name, info, scenario] of [['disabled', off, 'disabled'], ['enabled', on, 'standard']]) {
        const client = createClient(info.origin);
        const cookie = await client.signIn();
        const seeded = await client.send('POST', '/items', { cookie, body: { id: 'hot', name: 'Seed' } });
        if (seeded.status !== 201) throw new Error(`Seeding failed (${seeded.status}) ${seeded.text}`);
        sides[name] = { client, cookie, scenario, serial: 0 };
      }
      try {
        const routes = routesFor(sides);
        const bursts = {};
        for (const [route, make] of Object.entries(routes)) {
          for (const concurrency of plan.concurrencies) {
            log(`idle: ${route} at concurrency ${concurrency}`);
            const key = `${route}@${concurrency}`;
            const targets = make.only ? [make.only] : ['disabled', 'enabled'];
            for (const name of targets) {
              await drive(sides[name].client, { concurrency, durationMs: plan.warmupMs, build: () => make(name)() });
            }
            bursts[key] = { disabled: [], enabled: [] };
            for (let burst = 0; burst < plan.bursts; burst++) {
              for (const name of burst % 2 ? [...targets].reverse() : targets) {
                bursts[key][name].push(await drive(sides[name].client, { concurrency, durationMs: plan.burstMs, build: () => make(name)() }));
              }
            }
          }
        }
        return { bursts: plan.bursts, burstMs: plan.burstMs, comparison: compare(bursts) };
      } finally {
        for (const side of Object.values(sides)) side.client.close();
      }
    }));
}

/** Request builders per route. Each returns a function that makes the next request for the named side. */
function routesFor(sides) {
  const next = (name, prefix) => `${prefix}-${name}-${sides[name].serial++}`;
  const route = (builder, only) => Object.assign(name => () => builder(name, sides[name].cookie), { only });
  return {
    ready: route(() => ({ method: 'GET', path: '/ready' })),
    read: route((name, cookie) => ({ method: 'GET', path: '/items/hot', cookie })),
    write: route((name, cookie) => ({ method: 'POST', path: `/items/${next(name, 'w')}/ordinary`, cookie })),
    send: route((name, cookie) => ({ method: 'POST', path: '/items', cookie, ok: [201], body: { id: next(name, 's'), name: 'Send' } }), 'enabled'),
    observedSend: route((name, cookie) => ({
      method: 'POST', path: '/items', cookie, headers: { Prefer: 'trace' }, ok: [201], body: { id: next(name, 'o'), name: 'Observed' },
      check: response => response.headers['x-testbench-trace'] ? undefined : 'observed Send returned no trace ID',
    }), 'enabled'),
    preview: route((name, cookie) => ({
      method: 'POST', path: '/bench/_preview/items', cookie, headers: { Prefer: 'tx=rollback' }, ok: [200],
      body: { id: next(name, 'p'), name: 'Preview' },
      check: response => response.headers['preference-applied'] === 'tx=rollback' ? undefined : 'Preview was not confirmed',
    }), 'enabled'),
  };
}

/** Per-route medians across bursts for each side. */
function compare(bursts) {
  const rows = {};
  for (const [key, sides] of Object.entries(bursts)) {
    const pick = (list, read) => median(list.map(read));
    const stats = list => list.length ? {
      rps: round(pick(list, run => run.rps), 1), p50: pick(list, run => run.latencyMs.p50), p95: pick(list, run => run.latencyMs.p95),
      p99: pick(list, run => run.latencyMs.p99), errors: list.reduce((sum, run) => sum + run.errors, 0), errorRate: round(list.reduce((sum, run) => sum + run.errors, 0) / Math.max(1, list.reduce((sum, run) => sum + run.requests, 0)), 5), failureSamples: list.flatMap(run => run.failureSamples).slice(0, 3),
      spread: round((Math.max(...list.map(run => run.rps)) - Math.min(...list.map(run => run.rps))) / pick(list, run => run.rps), 2),
    } : null;
    const off = stats(sides.disabled); const on = stats(sides.enabled);
    rows[key] = { disabled: off, enabled: on, throughputRatio: off && on ? round(on.rps / off.rps, 3) : null };
  }
  return rows;
}

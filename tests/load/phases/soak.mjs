import { loadavg } from 'node:os';
import { withFixture } from '../../conformance/host.mjs';
import { createClient, drive, sleep } from '../lib/client.mjs';
import { groupRssKiB, judgeMemory, sampleRss } from '../lib/rss.mjs';

const rollback = { Prefer: 'tx=rollback' };
const trace = { Prefer: 'trace' };

/** A JSON item whose `pad` field pushes the request body to about `bytes`, near common framework body limits. */
const padded = (id, bytes) => ({ id, name: 'Padded', pad: 'x'.repeat(bytes) });

/**
 * Memory over a sustained mixed workload.
 *
 * Each iteration of every worker picks one request type by weight. The mix keeps the bench's bounded structures busy:
 *  - Previews and observed Sends of ordinary writes (trace store churn, capture objects),
 *  - Preview of the `capture` operation, which overflows the change, effect and log limits,
 *  - Preview of the `large` operation, whose response exceeds the 1 MiB capture limit and is rejected with 413,
 *  - Previews and observed Sends carrying a request body of about `bodyBytes` (default 90 KiB), just under the 100 KiB
 *    default of most frameworks' JSON parsers.
 * Resident memory of the fixture's process group is sampled on an interval; the run is judged by comparing a mid-run
 * window with the final window (see `judgeMemory`). A final idle period shows whether memory is returned or retained.
 */
export async function soakPhase(binding, plan, log) {
  return withFixture(binding, 'standard', '', async (_request, _database, { origin, pid, output }) => {
    const client = createClient(origin);
    try {
      const admin = await client.signIn();
      await client.send('POST', '/items', { cookie: admin, body: { id: 'hot', name: 'Seed' } });
      const run = Date.now().toString(36);
      let serial = 0;
      const id = prefix => `${prefix}-${run}-${serial++}`;
      const accepts = [200, 201, 400, 413, 422];
      const mix = [
        [35, () => ({ kind: 'preview', method: 'POST', path: '/sendproof/_preview/items', cookie: admin, headers: rollback, ok: [200], body: { id: id('p'), name: 'Preview' } })],
        [15, () => ({ kind: 'send', method: 'POST', path: '/items', cookie: admin, headers: trace, ok: [201], body: { id: id('s'), name: 'Send' } })],
        [25, () => ({ kind: 'read', method: 'GET', path: '/items/hot', cookie: admin, ok: [200] })],
        [5, () => ({ kind: 'capture', method: 'POST', path: `/sendproof/_preview/items/${id('c')}/capture`, cookie: admin, headers: rollback, ok: [200] })],
        [5, () => ({ kind: 'large', method: 'POST', path: `/sendproof/_preview/items/${id('l')}/large`, cookie: admin, headers: rollback, ok: [413] })],
        [5, () => ({ kind: 'previewBody', method: 'POST', path: '/sendproof/_preview/items', cookie: admin, headers: rollback, ok: accepts, body: padded(id('pb'), plan.bodyBytes) })],
        [10, () => ({ kind: 'sendBody', method: 'POST', path: '/items', cookie: admin, headers: trace, ok: accepts, body: padded(id('sb'), plan.bodyBytes) })],
      ];
      const total = mix.reduce((sum, [weight]) => sum + weight, 0);
      const build = () => {
        let pick = Math.random() * total;
        for (const [weight, make] of mix) { if ((pick -= weight) < 0) return make(); }
        return mix[0][1]();
      };

      log(`soak: warm-up ${plan.warmupMs / 1000}s`);
      await drive(client, { concurrency: plan.concurrency, durationMs: plan.warmupMs, build });
      const sampler = sampleRss(pid, plan.sampleMs);
      log(`soak: ${plan.durationMs / 1000}s at concurrency ${plan.concurrency}, sampling RSS every ${plan.sampleMs / 1000}s`);
      // Requests completed per window show whether throughput degrades as the app and trace store age.
      const windowMs = Math.max(5000, plan.durationMs / 12);
      const fullWindows = Math.floor(plan.durationMs / windowMs); // the last, partial window is dropped
      const windows = [];
      /** Mean latency per request type and window: shows which operation slows as the run ages. */
      const kinds = {};
      /** The machine's 1-minute load average when each window ends. A rise that lines up with a throughput dip points at other work on the host, not at the app. */
      const hostLoad = [];
      const loadStarted = Date.now();
      const load = await drive(client, {
        concurrency: plan.concurrency, durationMs: plan.durationMs, build,
        onResponse: (response, request) => {
          const slot = Math.floor((Date.now() - loadStarted) / windowMs);
          if (windows[slot] === undefined) hostLoad[slot - 1] = Number(loadavg()[0].toFixed(1));
          windows[slot] = (windows[slot] ?? 0) + 1;
          const bucket = ((kinds[request.kind] ??= [])[slot] ??= { n: 0, ms: 0 });
          bucket.n++; bucket.ms += response.ms;
        },
      });
      const settleStart = Date.now();
      await sleep(plan.settleMs);
      const afterIdle = (await groupRssKiB(pid)) / 1024;
      const samples = await sampler.stop();
      const loadSamples = samples.filter(sample => sample.t <= plan.durationMs / 1000 + 2);
      return {
        concurrency: plan.concurrency, durationS: plan.durationMs / 1000, bodyBytes: plan.bodyBytes,
        load, windowS: windowMs / 1000, requestsPerWindow: Array.from(windows, count => count ?? 0).slice(0, fullWindows),
        hostLoadPerWindow: Array.from(hostLoad, load => load ?? null).slice(0, fullWindows),
        meanMsPerWindowByKind: Object.fromEntries(Object.entries(kinds).map(([kind, slots]) => [kind, Array.from(slots, bucket => bucket ? Number((bucket.ms / bucket.n).toFixed(2)) : null).slice(0, fullWindows)])), memory: { ...judgeMemory(loadSamples), idleAfterSettleMiB: Number(afterIdle.toFixed(1)), settledS: (Date.now() - settleStart) / 1000 },
        // The end of the fixture's own log, kept only when requests failed, to explain the failures (for example a lock timeout).
        ...(load.errors ? { fixtureLogTail: output().slice(-2500) } : {}),
        samples: samples.map(sample => [Number(sample.t.toFixed(1)), Number(sample.mib.toFixed(1))]),
      };
    } finally {
      client.close();
    }
  });
}

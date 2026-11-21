import { createRequire } from 'node:module';
import { withFixture } from '../../conformance/host.mjs';
import { createClient, drive, round } from '../lib/client.mjs';

const rollback = { Prefer: 'tx=rollback' };
const require = createRequire(new URL('../../conformance/package.json', import.meta.url));

/**
 * Samples how many backends of this database are waiting on a lock, using a separate monitoring connection.
 *
 * The monitor never throws: Docker Desktop's port proxy occasionally resets a new connection under heavy connection churn,
 * so it reconnects (up to a few times) and reports `monitorLost` when it could not keep sampling.
 */
function watchLocks(databaseUrl) {
  const { Client } = require('pg');
  const waiting = [];
  let stopped = false;
  let lost;
  let current;
  const sql = "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'";
  const loop = (async () => {
    for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
      const client = current = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
      client.on('error', () => {});
      try {
        await client.connect();
        while (!stopped) {
          waiting.push((await client.query(sql)).rows[0].n);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        lost = error.message;
        await new Promise(resolve => setTimeout(resolve, 200));
      } finally {
        await client.end().catch(() => {});
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return {
        samples: waiting.length, maxWaiting: Math.max(0, ...waiting),
        meanWaiting: round(waiting.reduce((sum, n) => sum + n, 0) / (waiting.length || 1)),
        sampledAtLeastOneWaiter: waiting.filter(n => n > 0).length, ...(lost && waiting.length < 5 ? { monitorLost: lost } : {}),
      };
    },
  };
}

/**
 * PostgreSQL lock behaviour: what a running Preview does to concurrent normal traffic on the same table.
 *
 * A Preview runs the whole request inside a transaction that is rolled back at the end, so it holds that transaction's
 * row locks, uncommitted unique-index entries and a pooled connection until it finishes. Four conditions are measured
 * with the same normal traffic (an ordinary update of one hot row, ordinary inserts of new rows, and reads):
 *  - `baseline`: no Previews.
 *  - `disjointRows@N`: N concurrent short Previews inserting other rows (no row conflict).
 *  - `hotRow@N`: N concurrent Previews updating the hot row, each holding its row lock until it rolls back.
 *  - `longPreviews@N`: N concurrent Previews of the `capture` operation (about 200 inserts each), which hold a pooled
 *    connection for the whole operation.
 *  N is the low and high value of `previewConcurrencies`: one below and one above a typical pool of 8 connections.
 *  - `sameKey`: for each key a Preview insert and an ordinary insert of the same primary key start together; the ordinary
 *    insert has to wait for the Preview's uncommitted index entry to be rolled back.
 * It also checks isolation: no ordinary read may ever return a Preview's value.
 */
export async function contentionPhase(binding, plan, log) {
  return withFixture(binding, 'standard', '', async (_request, database, { origin, output }) => {
    const client = createClient(origin, { timeoutMs: 60000 });
    try {
      const admin = await client.signIn();
      const run = Date.now().toString(36);
      const seed = await client.send('POST', '/items', { cookie: admin, body: { id: 'hot', name: 'Normal-0' } });
      if (seed.status !== 201) throw new Error(`Seeding failed (${seed.status}) ${seed.text}`);
      let serial = 0;
      let leaked = 0;

      const normal = {
        hotUpdate: () => ({
          method: 'PATCH', path: '/items/hot', cookie: admin, ok: [200],
          body: { name: `Normal-${serial++}` },
        }),
        insert: () => ({ method: 'POST', path: `/items/n-${run}-${serial++}/ordinary`, cookie: admin }),
        read: () => ({
          method: 'GET', path: '/items/hot', cookie: admin, ok: [200],
          check: response => {
            if (/Preview-/.test(response.text)) { leaked++; return 'An ordinary read returned a Preview value'; }
          },
        }),
      };
      const previews = {
        insert: () => ({
          method: 'POST', path: '/sendproof/_preview/items', cookie: admin, headers: rollback, ok: [200],
          body: { id: `pi-${run}-${serial++}`, name: 'Preview-insert' },
        }),
        capture: () => ({ method: 'POST', path: `/sendproof/_preview/items/c-${run}-${serial++}/capture`, cookie: admin, headers: rollback, ok: [200] }),
        hotRow: () => ({
          method: 'PATCH', path: '/sendproof/_preview/items/hot', cookie: admin, headers: rollback, ok: [200],
          body: { name: `Preview-${serial++}` },
        }),
      };

      async function condition(name, previewKind, previewConcurrency = plan.previewConcurrencies[0]) {
        log(`contention: ${name}`);
        const locks = watchLocks(database.env.BENCH_DATABASE_URL);
        const started = Date.now();
        const pools = {
          hotUpdate: drive(client, { concurrency: plan.normalConcurrency, durationMs: plan.durationMs, build: normal.hotUpdate }),
          insert: drive(client, { concurrency: plan.normalConcurrency, durationMs: plan.durationMs, build: normal.insert }),
          read: drive(client, { concurrency: plan.normalConcurrency, durationMs: plan.durationMs, build: normal.read }),
          ...(previewKind ? { previews: drive(client, { concurrency: previewConcurrency, durationMs: plan.durationMs, build: previews[previewKind] }) } : {}),
        };
        const entries = await Promise.all(Object.entries(pools).map(async ([key, value]) => [key, await value]));
        return { previewKind: previewKind ?? null, previewConcurrency: previewKind ? previewConcurrency : 0, elapsedS: (Date.now() - started) / 1000, ...Object.fromEntries(entries), locks: await locks.stop() };
      }

      // A short warm-up so connection pools and plans are ready before the baseline.
      await drive(client, { concurrency: plan.normalConcurrency, durationMs: 1500, build: normal.hotUpdate });
      const [low, high] = plan.previewConcurrencies;
      const conditions = {
        baseline: await condition('baseline', null),
        [`disjointRows@${low}`]: await condition(`short Previews on other rows, ${low} at a time`, 'insert', low),
        [`hotRow@${low}`]: await condition(`Previews updating the hot row, ${low} at a time`, 'hotRow', low),
        [`longPreviews@${low}`]: await condition(`long (capture) Previews, ${low} at a time`, 'capture', low),
        [`hotRow@${high}`]: await condition(`Previews updating the hot row, ${high} at a time`, 'hotRow', high),
        [`longPreviews@${high}`]: await condition(`long (capture) Previews, ${high} at a time`, 'capture', high),
      };

      // Same-key pairs: an ordinary insert races a Preview insert of the same primary key.
      log('contention: same-key insert pairs');
      const locks = watchLocks(database.env.BENCH_DATABASE_URL);
      const keys = Array.from({ length: plan.keyPairs }, (_, index) => `k-${run}-${index}`);
      const latencies = { ordinary: [], baseline: [] };
      const failures = [];
      const raced = async (key, withPreview) => {
        const jobs = [];
        if (withPreview) {
          jobs.push(client.send('POST', '/sendproof/_preview/items', { cookie: admin, headers: rollback, body: { id: key, name: 'Preview-key' } }));
        }
        const ordinary = client.send('POST', '/items', { cookie: admin, body: { id: key, name: 'Ordinary' } });
        jobs.push(ordinary);
        const [first, second] = await Promise.all(jobs);
        const ordinaryResponse = withPreview ? second : first;
        if (ordinaryResponse.status !== 201) failures.push(`ordinary insert ${key}: ${ordinaryResponse.status}`);
        if (withPreview && first.status !== 200) failures.push(`Preview insert ${key}: ${first.status}`);
        return ordinaryResponse.ms;
      };
      for (let start = 0; start < keys.length; start += plan.normalConcurrency) {
        const batch = keys.slice(start, start + plan.normalConcurrency);
        latencies.ordinary.push(...await Promise.all(batch.map(key => raced(key, true))));
      }
      for (let start = 0; start < keys.length; start += plan.normalConcurrency) {
        const batch = keys.slice(start, start + plan.normalConcurrency);
        latencies.baseline.push(...await Promise.all(batch.map(key => raced('b' + key, false))));
      }
      const stats = values => {
        const sorted = [...values].sort((a, b) => a - b);
        const at = fraction => round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
        return { requests: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1]) };
      };
      conditions.sameKey = {
        ordinaryInsertWithRacingPreviewMs: stats(latencies.ordinary), ordinaryInsertAloneMs: stats(latencies.baseline),
        failures: failures.slice(0, 5), failureCount: failures.length, locks: await locks.stop(),
      };

      // Isolation: Previews never changed durable state.
      const hot = JSON.parse((await client.send('GET', '/items/hot', { cookie: admin })).text);
      const failuresList = [];
      if (leaked) failuresList.push(`${leaked} ordinary reads returned a Preview's uncommitted value`);
      if (/^Preview-/.test(hot.name)) failuresList.push('A Preview value was committed to the hot row');
      // Errors under the baseline are failures. Errors under Preview load are reported, not failed: when Previews hold more
      // pooled connections than the pool has, ordinary requests time out waiting for one, which is the behaviour measured.
      const overload = {};
      for (const [name, entry] of Object.entries(conditions)) {
        for (const [pool, stat] of Object.entries(entry)) {
          if (!stat?.errors) continue;
          if (name === 'baseline') failuresList.push(`${name}/${pool}: ${stat.errors} failed requests (${stat.failureSamples?.[0]})`);
          else (overload[name] ??= {})[pool] = { failed: stat.errors, of: stat.requests, sample: stat.failureSamples?.[0]?.slice(0, 160) };
        }
      }
      if (conditions.sameKey.failureCount) failuresList.push(`sameKey: ${conditions.sameKey.failureCount} failed inserts (${conditions.sameKey.failures[0]})`);
      const fixtureLog = Object.keys(overload).length ? output().split('\n').filter(line => /error|exception|timeout|timed out|locked|pool/i.test(line)).slice(-12).join('\n').slice(-2500) : undefined;
      return { conditions, errorsUnderPreviewLoad: overload, fixtureLogOfErrors: fixtureLog, failures: failuresList, passed: failuresList.length === 0, finalHotName: hot.name };
    } finally {
      client.close();
    }
  });
}

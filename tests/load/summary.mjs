#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';

/**
 * Prints cross-binding Markdown tables from the JSON files in tests/load/results.
 *
 *   node tests/load/summary.mjs [profile]     (default: soak)
 *
 * docs/performance.md is assembled from this output plus the findings text.
 */
const profile = process.argv[2] ?? 'soak';
const directory = new URL('./results/', import.meta.url);
const results = [];
for (const name of (await readdir(directory)).sort()) {
  if (name.endsWith(`-${profile}.json`)) results.push(JSON.parse(await readFile(new URL(name, directory), 'utf8')));
}
const table = (headers, rows) => [
  '| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...rows.map(row => '| ' + row.map(cell => cell ?? '-').join(' | ') + ' |'),
].join('\n');
const lat = run => run ? `${run.latencyMs.p50} / ${run.latencyMs.p95} / ${run.latencyMs.p99}` : '-';

const idle = results.filter(result => result.idle);
if (idle.length) {
  console.log('### Idle overhead: enabled vs disabled throughput ratio\n');
  const routes = ['ready@1', 'read@1', 'write@1', 'ready@16', 'read@16', 'write@16'];
  console.log(table(['Binding', ...routes], idle.map(result =>
    [result.binding, ...routes.map(route => result.idle.comparison[route]?.throughputRatio)])), '\n');
  console.log('### Idle overhead: p50 latency (ms), disabled / enabled, concurrency 1\n');
  console.log(table(['Binding', 'ready', 'read', 'write'], idle.map(result => [result.binding, ...['ready@1', 'read@1', 'write@1'].map(route => {
    const row = result.idle.comparison[route]; return row?.disabled ? `${row.disabled.p50} / ${row.enabled.p50}` : null;
  })])), '\n');
  console.log('### Sendproof feature cost at concurrency 16 (rps, p50 / p95 / p99 ms)\n');
  console.log(table(['Binding', 'Send', 'Observed Send', 'Preview'], idle.map(result => [result.binding, ...['send@16', 'observedSend@16', 'preview@16'].map(route => {
    const row = result.idle.comparison[route]?.enabled; return row ? `${row.rps} rps, ${row.p50} / ${row.p95} / ${row.p99}` : null;
  })])), '\n');
}
const concurrency = results.filter(result => result.concurrency);
if (concurrency.length) {
  console.log('### Concurrent Preview and observed Send\n');
  console.log(table(['Binding', 'Result', 'Preview distinct ids', 'Preview same id', 'Preview same row', 'Observed Send', 'Traces readable / issued'],
    concurrency.map(result => {
      const c = result.concurrency;
      const cell = run => `${lat(run)} (${run.errors} failed)`;
      return [result.binding, c.passed ? 'PASS' : 'FAIL', cell(c.checks.previewDistinctIds), cell(c.checks.previewSameId), cell(c.checks.previewSameRow),
        cell(c.checks.observedSend), `${c.checks.observedSend.tracesRetained} / ${c.checks.observedSend.tracesIssued}`];
    })), '\n');
}
const soak = results.filter(result => result.soak);
if (soak.length) {
  console.log('### Memory soak\n');
  console.log(table(['Binding', 'Duration s', 'Start MiB', 'Mid-run MiB', 'Final MiB', 'Peak MiB', 'Slope MiB/min', 'After idle MiB', 'Verdict', 'rps', 'p50 / p95 / p99 ms', 'Failed'],
    soak.map(result => {
      const s = result.soak; const m = s.memory;
      return [result.binding, s.durationS, m.startMiB, m.midMedianMiB, m.finalMedianMiB, m.peakMiB, m.slopeMiBPerMin, m.idleAfterSettleMiB,
        m.bounded === null ? 'n/a' : m.bounded ? 'bounded' : 'GROWING', s.load.rps, lat(s.load), `${s.load.errors} of ${s.load.requests}`];
    })), '\n');
  console.log('### Soak throughput per window (rps)\n');
  console.log(table(['Binding', 'Window s', 'Series'], soak.map(result => [result.binding, result.soak.windowS,
    result.soak.requestsPerWindow.map(count => Math.round(count / result.soak.windowS)).join(', ')])), '\n');
}
const contention = results.filter(result => result.contention);
for (const result of contention) {
  console.log(`### PostgreSQL contention: ${result.binding}\n`);
  const rows = [];
  for (const [name, condition] of Object.entries(result.contention.conditions)) {
    if (name === 'sameKey') continue;
    rows.push([name, lat(condition.hotUpdate), lat(condition.insert), lat(condition.read), condition.previews ? lat(condition.previews) : '-',
      `${condition.locks.maxWaiting} / ${condition.locks.meanWaiting}`]);
  }
  console.log(table(['Condition', 'Hot-row update', 'Insert', 'Read', 'Previews', 'Lock waiters max / mean'], rows), '\n');
  const key = result.contention.conditions.sameKey;
  console.log(`Same-key insert p50 / p99 ms: alone ${key.ordinaryInsertAloneMs.p50} / ${key.ordinaryInsertAloneMs.p99}, racing a Preview ${key.ordinaryInsertWithRacingPreviewMs.p50} / ${key.ordinaryInsertWithRacingPreviewMs.p99}.\n`);
}

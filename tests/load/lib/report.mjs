/**
 * Renders a load result as Markdown. The same text is printed by the CLI and saved next to the JSON.
 */
const fmt = value => value === null || value === undefined ? '-' : String(value);

function table(headers, rows) {
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + row.map(fmt).join(' | ') + ' |'),
  ].join('\n');
}

const latency = run => `${run.latencyMs.p50} / ${run.latencyMs.p95} / ${run.latencyMs.p99}`;

export function renderMarkdown(result) {
  const out = [`# Load result: ${result.binding} (${result.profile})`, ''];
  out.push(`Machine: ${result.machine.cpu}, ${result.machine.cores} cores, ${result.machine.memoryGiB} GiB, ${result.machine.os}, Node ${result.machine.node}. Started ${result.startedAt}.`, '');
  if (result.start) out.push(`Fixture start command: \`${result.start.join(' ')}\`.`, '');

  if (result.idle) {
    out.push(`## Idle overhead (bench disabled vs enabled; median of ${result.idle.bursts} alternating ${result.idle.burstMs} ms bursts)`, '');
    const cell = side => side ? `${side.p50} / ${side.p99}` : '-';
    out.push(table(['Route', 'Disabled rps', 'Enabled rps', 'Ratio', 'Disabled p50/p99 ms', 'Enabled p50/p99 ms', 'Errors'],
      Object.entries(result.idle.comparison).map(([name, row]) => [name, row.disabled?.rps, row.enabled?.rps, row.throughputRatio,
        cell(row.disabled), cell(row.enabled), (row.disabled?.errors ?? 0) + (row.enabled?.errors ?? 0)])), '');
  }
  if (result.concurrency) {
    const c = result.concurrency;
    out.push(`## Preview and observed Send at concurrency ${c.concurrency}: ${c.passed ? 'PASS' : 'FAIL'}`, '');
    out.push(table(['Check', 'Requests', 'rps', 'p50 / p95 / p99 ms', 'Failed', 'Left behind / missing'],
      Object.entries(c.checks).map(([name, run]) => [name, run.requests, run.rps, latency(run), run.errors, run.leftBehind ?? run.missing ?? 0])), '');
    const send = c.checks.observedSend;
    out.push(`Traces issued ${send.tracesIssued}, still readable ${send.tracesRetained}, misattributed ${send.tracesMisattributed}.`, '');
    for (const failure of c.failures) out.push(`- FAILURE: ${failure}`);
    if (c.failures.length) out.push('');
  }
  if (result.soak) {
    const s = result.soak; const m = s.memory;
    out.push(`## Memory soak, ${s.durationS}s at concurrency ${s.concurrency}: ${m.bounded === null ? 'inconclusive' : m.bounded ? 'BOUNDED' : 'GROWING'}`, '');
    out.push(table(['Start MiB', 'Mid-run median', 'Final median', 'Growth MiB', 'Slope MiB/min', 'Peak MiB', 'Idle after settle MiB'],
      [[m.startMiB, m.midMedianMiB, m.finalMedianMiB, m.growthMiB, m.slopeMiBPerMin, m.peakMiB, m.idleAfterSettleMiB]]), '');
    out.push(`Load: ${s.load.requests} requests, ${s.load.rps} rps, p50/p95/p99 ${latency(s.load)} ms, ${s.load.errors} failed (${s.load.errorRate * 100}%). Statuses: ${JSON.stringify(s.load.statuses)}.`);
    out.push(`Throughput per ${s.windowS}s window (rps): ${s.requestsPerWindow.map(count => Math.round(count / s.windowS)).join(', ')}.`);
    if (s.hostLoadPerWindow?.length) out.push(`Host load average (1 min) at each window end: ${s.hostLoadPerWindow.join(', ')} (${result.machine.cores} cores). Dips in throughput that line up with a high load are the host, not the app.`);
    out.push('', 'Mean latency (ms) per window by request type:', '', table(['Type', ...s.requestsPerWindow.map((_, index) => `w${index + 1}`)], Object.entries(s.meanMsPerWindowByKind).map(([kind, series]) => [kind, ...series])));
    if (s.load.failureSamples.length) out.push('', ...s.load.failureSamples.map(sample => `- ${sample}`));
    if (s.fixtureLogTail) out.push('', 'End of the fixture log:', '', '```text', s.fixtureLogTail.trim(), '```');
    out.push('');
  }
  if (result.contention) {
    const c = result.contention;
    out.push(`## PostgreSQL lock contention: ${c.passed ? 'PASS' : 'FAIL'}`, '');
    const rows = [];
    for (const [name, condition] of Object.entries(c.conditions)) {
      if (name === 'sameKey') continue;
      for (const pool of ['hotUpdate', 'insert', 'read', 'previews']) {
        const run = condition[pool];
        if (run) rows.push([name, pool, run.requests, run.rps, latency(run), run.latencyMs.max, run.errors, `${condition.locks.maxWaiting} / ${condition.locks.meanWaiting}`]);
      }
    }
    out.push(table(['Condition', 'Traffic', 'Requests', 'rps', 'p50 / p95 / p99 ms', 'max ms', 'Failed', 'Lock waiters max / mean'], rows), '');
    const key = c.conditions.sameKey;
    out.push(table(['Same-key insert', 'Requests', 'p50', 'p95', 'p99', 'max'], [
      ['alone', ...Object.values(key.ordinaryInsertAloneMs)], ['racing a Preview', ...Object.values(key.ordinaryInsertWithRacingPreviewMs)],
    ]), '');
    for (const [name, pools] of Object.entries(c.errorsUnderPreviewLoad ?? {})) {
      out.push(`- Errors under Preview load (${name}): ` + Object.entries(pools).map(([pool, e]) => `${pool} ${e.failed}/${e.of}`).join(', '));
    }
    for (const failure of c.failures) out.push(`- FAILURE: ${failure}`);
    if (c.failures.length || Object.keys(c.errorsUnderPreviewLoad ?? {}).length) out.push('');
  }
  if (result.hostLoad) {
    out.push(`Host load average (1 min) before / after each phase on ${result.machine.cores} cores: ` +
      Object.entries(result.hostLoad).map(([phase, load]) => `${phase} ${load.before} / ${load.after}`).join(', ') + '. A load above the core count means other work competed with the run.', '');
  }
  out.push(`Overall: ${result.passed ? 'PASS' : 'FAIL'}`, '');
  return out.join('\n');
}

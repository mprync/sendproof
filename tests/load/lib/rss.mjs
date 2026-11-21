import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Resident memory (KiB) of every process in the fixture's process group.
 *
 * The conformance host starts each fixture detached, so the fixture's PID is also its process-group ID. Summing the
 * group covers wrappers and worker children (Puma, uvicorn reloaders, `sh` launchers). Works on macOS and Linux.
 */
export async function groupRssKiB(pgid) {
  const { stdout } = await run('ps', ['-axo', 'pgid=,rss=']);
  let total = 0;
  for (const line of stdout.split('\n')) {
    const [group, rss] = line.trim().split(/\s+/).map(Number);
    if (group === pgid && Number.isFinite(rss)) total += rss;
  }
  return total;
}

/**
 * Samples group RSS on an interval until stopped.
 *
 * @param {number} pgid Process-group ID of the fixture.
 * @param {number} intervalMs Time between samples.
 * @returns {{stop(): Promise<{t: number, mib: number}[]>, samples: {t: number, mib: number}[]}} `t` is seconds since start.
 */
export function sampleRss(pgid, intervalMs) {
  const samples = [];
  const started = Date.now();
  let stopped = false;
  const take = async () => {
    try { samples.push({ t: (Date.now() - started) / 1000, mib: (await groupRssKiB(pgid)) / 1024 }); } catch { /* the fixture may be exiting */ }
  };
  const loop = (async () => {
    while (!stopped) {
      await take();
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  })();
  return { samples, async stop() { stopped = true; await loop; await take(); return samples; } };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/**
 * Judges whether memory is bounded under sustained load.
 *
 * It compares the median of a mid-run window (25-45 % of the run, after warm-up and JIT/GC settling) with the median of
 * the final 15 %, and fits a least-squares slope across the second half. Memory is called bounded when the final window
 * is no more than the larger of 32 MiB and 20 % above the mid window.
 */
export function judgeMemory(samples) {
  if (samples.length < 6) return { bounded: null, reason: 'too few samples' };
  const end = samples[samples.length - 1].t;
  const within = (from, to) => samples.filter(sample => sample.t >= from * end && sample.t <= to * end).map(sample => sample.mib);
  const mid = median(within(0.25, 0.45));
  const last = median(within(0.85, 1));
  const tail = samples.filter(sample => sample.t >= end / 2);
  const meanT = tail.reduce((sum, sample) => sum + sample.t, 0) / tail.length;
  const meanM = tail.reduce((sum, sample) => sum + sample.mib, 0) / tail.length;
  const slope = tail.reduce((sum, sample) => sum + (sample.t - meanT) * (sample.mib - meanM), 0) /
    (tail.reduce((sum, sample) => sum + (sample.t - meanT) ** 2, 0) || 1);
  const growth = last - mid;
  return {
    bounded: growth <= Math.max(32, mid * 0.2),
    midMedianMiB: Number(mid.toFixed(1)), finalMedianMiB: Number(last.toFixed(1)),
    growthMiB: Number(growth.toFixed(1)), slopeMiBPerMin: Number((slope * 60).toFixed(2)),
    peakMiB: Number(Math.max(...samples.map(sample => sample.mib)).toFixed(1)),
    startMiB: Number(samples[0].mib.toFixed(1)),
  };
}

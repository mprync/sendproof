import http from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * Keep-alive HTTP client and closed-loop load driver for the load harness.
 *
 * It uses plain `node:http` so the harness needs no dependencies beyond Node itself. Each worker sends one request
 * at a time (a closed loop), so `concurrency` is the number of in-flight requests and latency is measured per
 * request from the time it is written until the response body has been read.
 */

/** Admin credentials and viewer persona shared by every conformance fixture. */
export const credentials = { email: 'admin@example.test', password: 'bench-fixture' };
export const viewerEmail = 'viewer@example.test';

/**
 * Creates a client bound to one fixture origin.
 *
 * @param {string} origin Fixture origin such as `http://127.0.0.1:5351`.
 * @param {{timeoutMs?: number}} [options] Per-request timeout, 30 s by default.
 */
export function createClient(origin, { timeoutMs = 30000 } = {}) {
  const url = new URL(origin);
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 30000 });

  // Servers that close every connection (some development servers) make each request cost an ephemeral port that stays in
  // TIME_WAIT for about 30 s. The range has about 16,000 ports, so above roughly 500 requests per second the client runs out
  // (EADDRNOTAVAIL) and the run measures the client, not the app. Detect that case and pace requests to a sustainable rate.
  let requests = 0;
  let connections = 0;
  let paced = false;
  let nextStart = 0;
  const pacedRps = 400;
  const createConnection = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => { connections++; return createConnection(...args); };
  async function pace() {
    if (++requests === 300 && connections > requests / 2) paced = true;
    if (!paced) return;
    const now = performance.now();
    nextStart = Math.max(nextStart, now) + 1000 / pacedRps;
    if (nextStart - now > 0) await new Promise(resolve => setTimeout(resolve, nextStart - now));
  }

  /**
   * Sends one request. Never rejects: transport failures resolve with `status: 0` and an `error` message so a
   * load run counts them rather than aborting.
   *
   * @returns {Promise<{status: number, headers: Record<string, string>, text: string, ms: number, error?: string}>}
   */
  async function send(method, path, options = {}) {
    await pace();
    return transmit(method, path, options);
  }

  function transmit(method, path, { headers = {}, body, cookie } = {}) {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const started = performance.now();
    return new Promise(resolve => {
      const finish = (result) => resolve({ ms: performance.now() - started, headers: {}, text: '', ...result });
      const request = http.request({
        agent, method, hostname: url.hostname, port: url.port, path, timeout: timeoutMs,
        headers: {
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', error => finish({ status: 0, error: error.message }));
        response.on('end', () => {
          const headersOut = {};
          for (const [name, value] of Object.entries(response.headers)) headersOut[name] = [value].flat().join(', ');
          finish({ status: response.statusCode, headers: headersOut, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      request.on('timeout', () => request.destroy(new Error('request timed out')));
      request.on('error', error => finish({ status: 0, error: error.message }));
      request.end(payload);
    });
  }

  /** Signs in as the fixture admin and returns the `Cookie` header value. */
  async function signIn() {
    const response = await send('POST', '/auth/sign-in', { body: credentials });
    const cookie = response.headers['set-cookie']?.split(';')[0];
    if (response.status >= 300 || !cookie) throw new Error(`Admin sign-in failed (${response.status}) ${response.text.slice(0, 200)}`);
    return cookie;
  }

  /** Switches to the read-only viewer persona. */
  async function viewer(adminCookie) {
    const response = await send('POST', '/auth/personas/' + encodeURIComponent(viewerEmail), { cookie: adminCookie });
    const cookie = response.headers['set-cookie']?.split(';')[0];
    if (response.status >= 300 || !cookie) throw new Error(`Viewer sign-in failed (${response.status})`);
    return cookie;
  }

  return { send, signIn, viewer, close: () => agent.destroy(), get paced() { return paced; } };
}

/** Linear-interpolation-free percentile of an ascending sample (nearest rank). */
export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

/** Rounds to a fixed number of decimals for readable JSON. */
export const round = (value, places = 2) => value === null || value === undefined ? null : Number(value.toFixed(places));

/**
 * Condenses latencies and outcomes into the numbers reported for each run.
 *
 * @param {number[]} latencies Per-request latencies in milliseconds.
 * @param {number} elapsedMs Wall-clock duration of the run.
 * @param {{errors: number, statuses: Record<string, number>, failures: string[]}} outcome Failure counts and a sample of messages.
 */
export function summarize(latencies, elapsedMs, outcome) {
  const sorted = Float64Array.from(latencies).sort();
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    requests: count,
    errors: outcome.errors,
    errorRate: count ? round(outcome.errors / count, 5) : 0,
    rps: round(count / (elapsedMs / 1000), 1),
    latencyMs: {
      mean: round(count ? total / count : null), p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)), max: round(sorted[count - 1] ?? null),
    },
    statuses: outcome.statuses,
    failureSamples: outcome.failures,
  };
}

/**
 * Runs a closed-loop load: `concurrency` workers each send requests back to back until `durationMs` elapses or
 * `count` requests have been issued.
 *
 * `build(index)` returns `{ method, path, headers, body, cookie, ok, check }`. `ok` lists acceptable status codes
 * (default any 2xx); `check(response)` returns a failure message or nothing. Failures are counted, never thrown.
 *
 * @param {ReturnType<typeof createClient>} client
 * @param {{concurrency: number, durationMs?: number, count?: number, build: (index: number) => object,
 *   onResponse?: (response: object, request: object) => void}} spec
 */
export async function drive(client, { concurrency, durationMs, count, build, onResponse }) {
  const latencies = [];
  const outcome = { errors: 0, statuses: {}, failures: [] };
  const stopAt = durationMs ? performance.now() + durationMs : Infinity;
  let issued = 0;
  const started = performance.now();

  async function worker() {
    for (;;) {
      if (performance.now() >= stopAt || (count !== undefined && issued >= count)) return;
      const index = issued++;
      const request = build(index);
      const response = await client.send(request.method, request.path, request);
      latencies.push(response.ms);
      outcome.statuses[response.status] = (outcome.statuses[response.status] ?? 0) + 1;
      const allowed = request.ok ?? null;
      let failure = response.error ? `${request.method} ${request.path}: ${response.error}` : undefined;
      if (!failure && (allowed ? !allowed.includes(response.status) : response.status < 200 || response.status >= 300)) {
        failure = `${request.method} ${request.path}: HTTP ${response.status} ${response.text.slice(0, 120)}`;
      }
      if (!failure && request.check) {
        try { failure = request.check(response); } catch (error) { failure = `${request.method} ${request.path}: check threw ${error.message}`; }
      }
      if (failure) {
        outcome.errors++;
        if (outcome.failures.length < 5) outcome.failures.push(String(failure).slice(0, 300));
      }
      onResponse?.(response, request);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const summary = summarize(latencies, performance.now() - started, outcome);
  if (client.paced) summary.pacedAt400rps = true; // the server closes every connection; see createClient
  return summary;
}

/** Pauses without holding the event loop open. */
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

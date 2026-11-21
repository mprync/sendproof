import { withFixture } from '../../conformance/host.mjs';
import { createClient, drive } from '../lib/client.mjs';

const rollback = { Prefer: 'tx=rollback' };
const trace = { Prefer: 'trace' };

/** Parses a response body, returning undefined when it is not JSON. */
function parse(response) {
  try { return JSON.parse(response.text); } catch { return undefined; }
}

/**
 * Preview and observed Send under concurrency, with correctness checks.
 *
 * Four independent checks run on one fresh fixture, each a burst of requests at `plan.concurrency`:
 *  1. Previews that each insert a different item. Every one must be confirmed and rolled back, must report only its
 *     own item (no other Preview's id may appear anywhere in its capture) and must leave nothing behind.
 *  2. Previews that all insert the same id. If one Preview could see another's uncommitted write, the insert would
 *     collide and fail, so every one must still return 201.
 *  3. Previews that all update one row to different names. Each must read the original value as `before` and see only its
 *     own name as `after`, and the row must be unchanged at the end.
 *  4. Observed Sends that each insert a different item. Every one must commit exactly once and return a trace ID; the
 *     trace store must stay within its bound, and every trace that is still readable must belong to its own request.
 */
export async function concurrencyPhase(binding, plan, log) {
  return withFixture(binding, 'standard', '', async (_request, _database, { origin }) => {
    const client = createClient(origin);
    try {
      const admin = await client.signIn();
      const viewer = await client.viewer(admin);
      const run = Date.now().toString(36);
      const result = { concurrency: plan.concurrency, checks: {} };

      /** Counts how many items in `ids` exist as seen by the read-only viewer. */
      async function present(ids) {
        let found = 0;
        await drive(client, {
          concurrency: 16, count: ids.length,
          build: index => ({ method: 'GET', path: '/items/' + ids[index], cookie: viewer, ok: [200, 404] }),
          onResponse: response => { if (response.status === 200) found++; },
        });
        return found;
      }

      // 1. Unique-id Previews.
      log('concurrency: previews with distinct ids');
      const ids = Array.from({ length: plan.previews }, (_, index) => `pv-${run}-${index}`);
      const idPattern = new RegExp(`pv-${run}-\\d+`, 'g');
      const unique = await drive(client, {
        concurrency: plan.concurrency, count: ids.length,
        build: index => ({
          method: 'POST', path: '/sendproof/_preview/items', cookie: admin, headers: rollback, ok: [200],
          body: { id: ids[index], name: 'Preview ' + index },
          check: response => {
            const body = parse(response);
            if (response.headers['preference-applied'] !== 'tx=rollback' || body?.rolledBack !== true) return 'Preview was not rolled back';
            if (body.status !== 201 || body.body?.id !== ids[index]) return `Preview returned ${body.status} ${JSON.stringify(body.body)}`;
            if (!body.changes.some(change => change.operation === 'insert' && JSON.stringify(change.key).includes(ids[index]))) {
              return 'Preview did not capture its own insert';
            }
            const foreign = new Set((response.text.match(idPattern) ?? []).filter(id => id !== ids[index]));
            return foreign.size ? `Preview saw another request's write: ${[...foreign][0]}` : undefined;
          },
        }),
      });
      unique.leftBehind = await present(ids);
      result.checks.previewDistinctIds = unique;

      // 2. Same-id Previews.
      log('concurrency: previews with the same id');
      const sameId = await drive(client, {
        concurrency: plan.concurrency, count: plan.previews,
        build: () => ({
          method: 'POST', path: '/sendproof/_preview/items', cookie: admin, headers: rollback, ok: [200],
          body: { id: `shared-${run}`, name: 'Shared' },
          check: response => {
            const body = parse(response);
            return body?.rolledBack === true && body.status === 201 ? undefined : `Preview of a shared id returned ${body?.status ?? response.status}`;
          },
        }),
      });
      sameId.leftBehind = await present([`shared-${run}`]);
      result.checks.previewSameId = sameId;

      // 3. Same-row updates.
      log('concurrency: previews updating one row');
      const row = `row-${run}`;
      await client.send('POST', '/items', { cookie: admin, body: { id: row, name: 'Initial' } });
      const names = Array.from({ length: plan.previews }, (_, index) => `Temp${run}x${index}`);
      const namePattern = new RegExp(`Temp${run}x\\d+`, 'g');
      const updates = await drive(client, {
        concurrency: plan.concurrency, count: names.length,
        build: index => ({
          method: 'PATCH', path: `/sendproof/_preview/items/${row}`, cookie: admin, headers: rollback, ok: [200],
          body: { name: names[index] },
          check: response => {
            const body = parse(response);
            if (body?.rolledBack !== true || body.status !== 200 || body.body?.name !== names[index]) return 'Preview update was not confirmed';
            const update = body.changes.find(change => change.operation === 'update');
            if (!update || !JSON.stringify(update.before).includes('Initial') || !JSON.stringify(update.after).includes(names[index])) {
              return 'Preview update did not capture the original value as before';
            }
            const foreign = new Set((response.text.match(namePattern) ?? []).filter(name => name !== names[index]));
            return foreign.size ? `Preview saw another request's update: ${[...foreign][0]}` : undefined;
          },
        }),
      });
      const after = parse(await client.send('GET', '/items/' + row, { cookie: viewer }));
      updates.rowAfter = after?.name;
      updates.leftBehind = after?.name === 'Initial' ? 0 : 1;
      result.checks.previewSameRow = updates;

      // 4. Observed Sends.
      log('concurrency: observed Sends');
      const sendIds = Array.from({ length: plan.sends }, (_, index) => `os-${run}-${index}`);
      const traces = new Map();
      const sends = await drive(client, {
        concurrency: plan.concurrency, count: sendIds.length,
        build: index => ({
          method: 'POST', path: '/items', cookie: admin, headers: trace, ok: [201],
          body: { id: sendIds[index], name: 'Send ' + index },
          check: response => response.headers['x-sendproof-trace'] ? undefined : 'No trace ID on an observed Send',
        }),
        onResponse: (response, request) => {
          if (response.headers['x-sendproof-trace']) traces.set(response.headers['x-sendproof-trace'], request.body.id);
        },
      });
      const committed = await present(sendIds);
      sends.committed = committed;
      sends.missing = sendIds.length - committed;
      let retained = 0; let misattributed = 0;
      for (const [traceId, id] of traces) {
        const response = await client.send('GET', '/sendproof/_api/traces/' + traceId, { cookie: admin });
        if (response.status === 200) {
          retained++;
          if (!response.text.includes(id)) misattributed++;
        }
      }
      sends.tracesIssued = traces.size;
      sends.tracesRetained = retained;
      sends.tracesMisattributed = misattributed;
      result.checks.observedSend = sends;

      // Judge.
      const failures = [];
      for (const [name, check] of Object.entries(result.checks)) {
        if (check.errors) failures.push(`${name}: ${check.errors} failed requests (${check.failureSamples[0]})`);
        if (check.leftBehind) failures.push(`${name}: Preview left ${check.leftBehind} change(s) behind`);
      }
      if (sends.missing) failures.push(`observedSend: ${sends.missing} of ${sendIds.length} Sends did not commit`);
      if (sends.tracesMisattributed) failures.push(`observedSend: ${sends.tracesMisattributed} traces belong to another request`);
      if (sends.tracesRetained > 32) failures.push(`observedSend: ${sends.tracesRetained} traces retained, above the documented bound of 32`);
      result.failures = failures;
      result.passed = failures.length === 0;
      return result;
    } finally {
      client.close();
    }
  });
}

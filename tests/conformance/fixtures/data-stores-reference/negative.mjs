/**
 * Negative self-test for the data-store checks: with the reference fixture's guard turned off, the
 * guard checks (and the raw-commit rule) must fail and every other check must still pass. This
 * proves the checks catch a binding that lets writes through, not just that the reference passes.
 *
 * Run from the repository root with the compose services up:
 *   node tests/conformance/fixtures/data-stores-reference/negative.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const expected = [
  'Shared rule raw-commit: a handler COMMIT fails the Preview with nothing persisted',
  'Data stores: a guarded Redis write in Preview fails cleanly',
  'Data stores: SQL and a guarded Redis write roll back together',
  'Data stores: a guarded DynamoDB write in Preview fails cleanly',
  'Data stores: SQL and a guarded DynamoDB write roll back together',
  'Data stores: a MongoDB Preview rolls back and reports document changes',
];

const run = spawnSync(process.execPath, ['--test-reporter=tap', 'tests/conformance/run.mjs', 'data-stores-reference'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, BENCH_REFERENCE_GUARD: 'off' }, timeout: 240000,
});
assert.notEqual(run.status, 0, 'The guard-off variant must fail the conformance run');
const results = [...run.stdout.matchAll(/^\s+(ok|not ok) \d+ - (.+?)(?: # .*)?$/gm)].map(([, outcome, name]) => ({ outcome, name }));
const failed = results.filter(item => item.outcome === 'not ok').map(item => item.name).sort();
assert.deepEqual(failed, [...expected].sort(), 'Exactly the guard checks must fail with the guard off');
assert(results.filter(item => item.outcome === 'ok').length >= 7, 'The remaining checks must still run and pass');
console.log(`Guard-off variant failed the ${failed.length} expected checks and passed the rest.`);

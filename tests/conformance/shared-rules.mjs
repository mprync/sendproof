/**
 * Shared security rules from docs/security-review.md "Follow-ups", specified in
 * spec/conformance/fixture.md "Shared security rules".
 *
 * Each rule needs new fixture routes, so a manifest entry opts in per rule with
 * `"sharedRules": ["secret-columns", "raw-commit"]`. A rule the entry doesn't list is reported as
 * not implemented (skipped), never as a failure, until the binding adds its routes.
 *
 * Some rules apply only to some databases (`mysql-escape` only to MySQL and MariaDB). An entry on
 * another database reports such a rule as not applicable, and may not list it.
 */
import assert from 'node:assert/strict';

const base = '/tenant';
const rollback = { Prefer: 'tx=rollback' };
export const ruleIds = ['secret-columns', 'raw-commit', 'mysql-escape'];
/** The manifest `database` values each database-specific rule applies to. */
const appliesTo = { 'mysql-escape': { databases: ['mysql', 'mariadb'], label: 'MySQL and MariaDB' } };

async function status(response, expected) {
  const allowed = [expected].flat();
  if (!allowed.includes(response.status)) {
    assert.fail(`Expected HTTP ${allowed.join(' or ')}, got ${response.status} from ${response.url}\n${(await response.text()).slice(0, 1000)}`);
  }
  return response;
}

/** Finds a field case-insensitively, since SQL providers may report column names in upper case. */
const field = (row, name) => row && Object.entries(row).find(([key]) => key.toLowerCase() === name)?.[1];

/** The accounts insert must hide password_hash in its snapshot, and neither secret may appear anywhere else. */
function assertRedactedAccount(document, password, what) {
  const change = document.changes.find(item => item.table.toLowerCase() === 'accounts' && item.operation === 'insert');
  assert(change, `Expected an accounts insert in the ${what}`);
  assert.equal(field(change.after, 'password_hash'), '[REDACTED]', `password_hash must be [REDACTED] in the ${what}`);
  const text = JSON.stringify(document);
  assert(!text.includes('hashed:' + password), `The ${what} must not contain the stored password hash`);
  assert(!text.includes(password), `The ${what} must not contain the password`);
}

/**
 * Asks the fixture's database, over a connection of the runner's own, whether a table exists, so a DDL statement that
 * escaped the Preview transaction can't hide behind the binding's view of the database.
 */
async function mysqlTableExists(databaseUrl, table) {
  const { createConnection } = await import('mysql2/promise');
  const client = await createConnection(databaseUrl);
  try {
    const [rows] = await client.execute(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
    return rows.length > 0;
  } finally {
    await client.end();
  }
}

/**
 * Runs the shared security rules for one entry. `database` is the fixture database from database.mjs (its `env`
 * holds `BENCH_DATABASE_URL` for server engines); rules that need an independent read use it.
 */
export async function sharedRules(t, request, schemas, binding, database) {
  const enabled = new Set(binding.sharedRules ?? []);
  assert([...enabled].every(rule => ruleIds.includes(rule)), `Unknown shared rule in ${binding.id}`);
  const applies = rule => !appliesTo[rule] || appliesTo[rule].databases.includes(binding.database);
  assert([...enabled].every(applies), `${binding.id} lists a shared rule that doesn't apply to ${binding.database}`);
  const skip = rule => {
    if (!applies(rule)) return { skip: `not applicable: "${rule}" applies only to ${appliesTo[rule].label} entries` };
    return enabled.has(rule) ? {} : { skip: `not implemented: add the routes in spec/conformance/fixture.md and list "${rule}" in sharedRules` };
  };
  let cookie;
  const signIn = async () => {
    if (cookie) return cookie;
    const response = await status(await request(base + '/auth/sign-in', {
      method: 'POST', body: { email: 'admin@example.test', password: 'bench-fixture' },
    }), [200, 204]);
    cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(cookie, 'Expected a session cookie');
    await response.body?.cancel();
    return cookie;
  };

  await t.test('Shared rule secret-columns: password_hash is [REDACTED] in change snapshots', skip('secret-columns'), async () => {
    await signIn();
    const password = 'fixture-password-value';
    const previewed = await status(await request(base + '/sendproof/_preview/accounts', {
      method: 'POST', cookie, headers: rollback, body: { id: 'secret-account', email: 'secret@example.test', password },
    }), 200);
    assert.equal(previewed.headers.get('preference-applied'), 'tx=rollback');
    const envelope = await previewed.json();
    schemas.assert('preview', envelope);
    assert.equal(envelope.status, 201);
    assertRedactedAccount(envelope, password, 'Preview envelope');
    await status(await request(base + '/accounts/secret-account', { cookie }), 404);

    const sent = await status(await request(base + '/accounts', {
      method: 'POST', cookie, headers: { Prefer: 'trace' }, body: { id: 'secret-account', email: 'secret@example.test', password },
    }), 201);
    await sent.body?.cancel();
    const id = sent.headers.get('x-sendproof-trace');
    assert(id, 'Expected a trace ID on observed Send');
    const trace = await (await status(await request(base + '/sendproof/_api/traces/' + encodeURIComponent(id), { cookie }), 200)).json();
    schemas.assert('trace', trace);
    assertRedactedAccount(trace, password, 'trace');
    await status(await request(base + '/accounts/secret-account', { cookie }), 200);
  });

  await t.test('Shared rule raw-commit: a handler COMMIT fails the Preview with nothing persisted', skip('raw-commit'), async () => {
    await signIn();
    const preview = await request(base + '/sendproof/_preview/items/raw-commit/commit', {
      method: 'POST', cookie, headers: rollback, body: { name: 'Committed by the handler' },
    });
    await status(await request(base + '/items/raw-commit', { cookie }), 404);
    const response = await status(preview, 500);
    assert.equal(response.headers.get('preference-applied'), null, 'A Preview whose handler committed must not be confirmed');
    const content = await response.text();
    if (content && response.headers.get('content-type')?.includes('json')) assert.notEqual(JSON.parse(content).rolledBack, true);
  });

  // spec/conformance/fixture.md "MySQL and MariaDB: mysql-escape". Each `via` runs a statement that would commit the
  // Preview transaction on MySQL: implicitly committing DDL, or a CALL to a procedure that runs COMMIT. The provider
  // must refuse it before sending, so nothing the handler inserted survives.
  for (const via of ['ddl', 'call']) {
    await t.test(`Shared rule mysql-escape: a handler ${via === 'ddl' ? 'CREATE TABLE' : 'CALL'} fails the Preview with nothing persisted`, skip('mysql-escape'), async () => {
      await signIn();
      const id = 'escape_' + via;
      const response = await status(await request(base + `/sendproof/_preview/items/${id}/escape`, {
        method: 'POST', cookie, headers: rollback, body: { name: 'Escaped by the handler', via },
      }), 500);
      assert.equal(response.headers.get('preference-applied'), null, `A Preview whose handler ran ${via} must not be confirmed`);
      const content = await response.text();
      if (content && response.headers.get('content-type')?.includes('json')) assert.notEqual(JSON.parse(content).rolledBack, true);
      await status(await request(base + '/items/' + id, { cookie }), 404);
      if (via === 'ddl') {
        const url = database?.env?.BENCH_DATABASE_URL;
        assert(url, 'mysql-escape needs the fixture database URL for an independent read');
        assert.equal(await mysqlTableExists(url, 'sendproof_escape_' + id), false, `The handler's CREATE TABLE must not have run`);
      }
    });
  }
}

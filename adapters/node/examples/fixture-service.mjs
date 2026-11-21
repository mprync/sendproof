import { randomUUID } from 'node:crypto';
import { currentCapture, deliverEffect } from '@sendproof/core';
import { SQLiteDatabase } from '@sendproof/sqlite';

export const authProviders = [
  { kind: 'cookie', label: 'Fixture password', url: '/auth/sign-in' },
  { kind: 'personas', label: 'Development personas', url: '/auth/personas' },
];

const admin = { name: 'Fixture Admin', role: 'admin', subject: 'admin@example.test', scheme: 'fixture' };
const viewer = { name: 'Fixture Viewer', role: 'viewer', subject: 'viewer@example.test', scheme: 'fixture' };
const publicPersona = person => ({ name: person.name, role: person.role, email: person.subject });
const reply = (status, body = null, headers = {}) => ({ status, body, headers });

export function sqliteStorage(filename) {
  const db = new SQLiteDatabase(filename, {
    schema: 'CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL);' +
      'CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL)',
  });
  const secret = () => db.get('SELECT :fixture_secret AS value', { fixture_secret: 'fixture-secret-value' });
  return { db, secret };
}

function sqliteStore(filename) {
  const { db, secret } = sqliteStorage(filename);
  const tracked = id => ({ table: 'items', keys: [{ id }] });
  return {
    provider: db, secret,
    find: id => db.get('SELECT * FROM items WHERE id = :id', { id }),
    insert: (id, name) => db.write('INSERT INTO items (id, name) VALUES (:id, :name)', { id, name }, tracked(id)),
    update: async (id, name) => (await db.write('UPDATE items SET name = :name WHERE id = :id', { id, name }, tracked(id))).changes,
    remove: async id => (await db.write('DELETE FROM items WHERE id = :id', { id }, tracked(id))).changes,
    // Shared security rules (spec/conformance/fixture.md): an accounts table with a secret column,
    // and a raw COMMIT on the handler's connection, which the provider refuses during a Preview.
    insertAccount: (id, email, passwordHash) => db.write('INSERT INTO accounts (id, email, password_hash) VALUES (:id, :email, :password_hash)',
      { id, email, password_hash: passwordHash }, { table: 'accounts', keys: [{ id }] }),
    findAccount: id => db.get('SELECT id, email FROM accounts WHERE id = :id', { id }),
    commit: () => db.write('COMMIT'),
  };
}

/**
 * spec/conformance/fixture.md "MySQL and MariaDB: mysql-escape". MySQL stores create this procedure at startup, over a
 * text-protocol connection, and declare no procedure safe.
 */
export const commitProbeProcedure = 'CREATE PROCEDURE IF NOT EXISTS sendproof_commit_probe() BEGIN COMMIT; END';

/** The statement `POST /items/{id}/escape` runs after its insert: implicitly committing DDL, or a CALL that commits. */
export function escapeStatement(id, via) {
  return via === 'ddl' ? `CREATE TABLE sendproof_escape_${id} (n INT)` : 'CALL sendproof_commit_probe()';
}

export function createFixture(filename, scenario, store = sqliteStore) {
  const { provider, insert, find, update, remove, secret, insertAccount, findAccount, commit, escape } = store(filename);
  const sessions = new Map();
  const previewProvider = scenario === 'no-provider' ? undefined : {
    async preview(dispatch) {
      const response = await provider.preview(dispatch);
      if (scenario === 'rollback-failure') throw new Error('Fixture rollback failure');
      return response;
    },
  };

  function session(cookie) {
    return sessions.get(/(?:^|;\s*)fixture=([^;]+)/.exec(cookie ?? '')?.[1]) ?? null;
  }

  function issue(person) {
    const key = randomUUID();
    sessions.set(key, person);
    return reply(200, publicPersona(person), { 'Set-Cookie': `fixture=${key}; Path=/; HttpOnly; SameSite=Strict` });
  }

  function signIn(body) {
    return body?.email === admin.subject && body.password === 'bench-fixture' ? issue(admin) : reply(401);
  }

  function list({ identity }) {
    return identity?.role === 'admin' ? reply(200, [publicPersona(admin), publicPersona(viewer)]) : reply(identity ? 403 : 401);
  }

  function switchPersona({ identity, params }) {
    if (identity?.role !== 'admin') return reply(identity ? 403 : 401);
    if (params.email !== viewer.subject) return reply(404);
    return issue(viewer);
  }

  function access(handler, write = true) {
    return input => {
      if (!input.identity) return reply(401);
      if (write && input.identity.role !== 'admin') return reply(403);
      return handler(input);
    };
  }

  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 150;
  const effect = { kind: 'email', description: 'Created item', data: { to: ['ops@example.test'] } };
  const notifications = [];
  const operation = (method, path, handler) => ({ method, path, handler: access(handler) });

  const operations = [
    operation('POST', '/items', async ({ body }) => {
      if (!valid(body?.id) || !valid(body?.name)) return reply(400);
      await secret();
      await insert(body.id, body.name);
      await deliverEffect(effect, () => notifications.push(body.id));
      currentCapture()?.log({ level: 'Information', message: 'created:' + body.id });
      return reply(201, { id: body.id, name: body.name });
    }),
    operation('PATCH', '/items/{id}', async ({ params: { id }, body, query }) => {
      if (!valid(body?.name)) return reply(400);
      const changes = await update(id, body.name);
      const tag = query.get('tag');
      return changes ? reply(200, { id, name: body.name }, tag === null ? {} : { 'X-Fixture-Tag': tag }) : reply(404);
    }),
    operation('DELETE', '/items/{id}', async ({ params: { id } }) => {
      const changes = await remove(id);
      return reply(changes ? 204 : 404);
    }),
    operation('POST', '/items/{id}/fail', async ({ params: { id }, query }) => {
      await insert(id, 'Failure');
      if (query.get('mode') === 'exception') throw new Error('Fixture operation failed.');
      return reply(409, { message: 'Fixture conflict' });
    }),
    operation('POST', '/items/{id}/large', async ({ params: { id } }) => {
      await insert(id, 'Large response');
      return reply(200, 'x'.repeat(1024 * 1024 + 1), { 'Content-Type': 'text/plain' });
    }),
    operation('POST', '/items/{id}/redirect', ({ params: { id }, base }) =>
      reply(302, null, { Location: base + '/items/' + id, 'Set-Cookie': 'inner=never-forward' })),
    operation('POST', '/items/{id}/capture', async ({ params: { id } }) => {
      for (let index = 0; index < 201; index++) await insert(id + '-' + index, 'Capture');
      for (let index = 0; index < 101; index++) await deliverEffect(effect, () => notifications.push(id));
      for (let index = 0; index < 501; index++) currentCapture()?.log({ level: 'Debug', message: 'capture:' + index });
      return reply(200, { inserted: 201 });
    }),
  ];

  if (insertAccount) {
    operations.push(
      operation('POST', '/accounts', async ({ body }) => {
        if (![body?.id, body?.email, body?.password].every(valid)) return reply(400);
        await insertAccount(body.id, body.email, 'hashed:' + body.password);
        return reply(201, { id: body.id, email: body.email });
      }),
      operation('POST', '/items/{id}/commit', async ({ params: { id }, body }) => {
        if (!valid(body?.name)) return reply(400);
        await insert(id, body.name);
        await commit();
        return reply(201, { id, name: body.name });
      }),
    );
  }

  if (escape) {
    // MySQL stores only: the provider must refuse the statement before sending, so the Preview fails with nothing kept.
    operations.push(operation('POST', '/items/{id}/escape', async ({ params: { id }, body }) => {
      if (!valid(body?.name) || !['ddl', 'call'].includes(body?.via) || !/^\w{1,40}$/.test(id)) return reply(400);
      await insert(id, body.name);
      await escape(escapeStatement(id, body.via));
      return reply(201, { id, name: body.name });
    }));
  }

  const ordinary = [
    { method: 'POST', path: '/auth/sign-in', handler: ({ body }) => signIn(body) },
    { method: 'GET', path: '/auth/personas', handler: list },
    { method: 'POST', path: '/auth/personas/{email}', handler: switchPersona },
    { method: 'GET', path: '/items/{id}', handler: access(async ({ params: { id } }) => {
      const item = await find(id);
      return item ? reply(200, item) : reply(404);
    }, false) },
    operation('POST', '/items/{id}/ordinary', async ({ params: { id } }) => {
      await insert(id, 'Ordinary');
      return reply(201, { id, name: 'Ordinary' });
    }),
  ];
  if (findAccount) {
    ordinary.push({ method: 'GET', path: '/accounts/{id}', handler: access(async ({ params: { id } }) => {
      const account = await findAccount(id);
      return account ? reply(200, account) : reply(404);
    }, false) });
  }
  // The data-store routes (fixture-stores.mjs) reuse these to share auth and the SQL item insert.
  return { session, previewProvider, operations, ordinary, operation, reply, insert };
}

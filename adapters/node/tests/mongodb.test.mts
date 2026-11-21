// MongoDB Preview (`@sendproof/mongodb`) against the compose replica set, for the driver and
// Mongoose. An independent client reads the database after every Preview, so a passing check
// proves the Preview's writes were rolled back, and the tripwire tests prove that a write the hook
// couldn't see is never confirmed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { mongooseStore, mongoStore } from '@sendproof/mongodb';
import { assertBlocked, assertUnconfirmed, dbEntries, fresh, handle, needs, services, startApp } from './support/stores.mts';

const url = (database: string) => {
  const target = new URL(services.mongodb);
  target.pathname = '/' + database;
  return target.href;
};

/** A fresh database with one seeded document, dropped when the test ends. */
async function database(t: test.TestContext) {
  const name = fresh('mongo');
  const reader = new MongoClient(url(name));
  t.after(async () => { await reader.db(name).dropDatabase(); await reader.close(); });
  await reader.db(name).collection('documents').insertOne({ _id: 'seeded' as never, name: 'Seeded', profile: { city: 'Leeds' }, password_hash: 'hashed:seeded-secret' });
  const documents = (filter: Record<string, unknown> = {}) => reader.db(name).collection('documents').find(filter).toArray();
  return { name, reader, documents };
}

async function driverApp(t: test.TestContext, hook = true) {
  const { name, reader, documents } = await database(t);
  const raw = new MongoClient(url(name));
  const store = hook ? mongoStore(raw, { name: 'catalog' }) : undefined;
  const client = store?.client ?? raw;
  t.after(() => raw.close());
  const collection = () => client.db().collection('documents');
  const harness = await startApp(t, store ? [store] : [], bench => {
    bench.operation('GET', '/documents/{id}', handle(async (req, res) => {
      const document = await collection().findOne({ _id: req.params.id as never });
      if (document) res.json(document); else res.status(404).end();
    }));
    bench.operation('POST', '/documents', handle(async (req, res) => {
      const { id, name: title, city, password } = req.body;
      await collection().insertOne({ _id: id, name: title, profile: { city }, password_hash: 'hashed:' + password });
      res.status(201).json({ id });
    }));
    bench.operation('PATCH', '/documents/{id}', handle(async (req, res) => {
      const result = await collection().updateOne({ _id: req.params.id as never }, { $set: { name: req.body.name, 'profile.city': req.body.city } });
      const document = await collection().findOne({ _id: req.params.id as never });
      res.status(result.matchedCount ? 200 : 404).json(document);
    }));
    bench.operation('PUT', '/documents/{id}', handle(async (req, res) => {
      await collection().replaceOne({ _id: req.params.id as never }, { name: req.body.name, profile: {} });
      await collection().updateOne({ _id: 'upserted' as never }, { $set: { name: 'Upserted' } }, { upsert: true });
      await collection().deleteOne({ _id: 'gone' as never });
      res.json({ ok: true });
    }));
    bench.operation('POST', '/documents/archive', handle(async (_req, res) => {
      await collection().aggregate([{ $match: {} }, { $out: 'documents_archive' }]).toArray();
      res.sendStatus(204);
    }));
    bench.operation('POST', '/documents/{id}/escape', handle(async (req, res) => {
      // The raw client carries no Preview session: monitoring sees the write and fails the Preview.
      await raw.db().collection('documents').insertOne({ _id: req.params.id as never, name: 'Escaped' });
      res.status(201).json({ ok: true });
    }));
    bench.operation('POST', '/documents/{id}/foreign', handle(async (req, res) => {
      const session = raw.startSession();
      try {
        await collection().insertOne({ _id: req.params.id as never, name: 'Foreign' }, { session });
      } catch { /* swallowed on purpose */ } finally {
        await session.endSession();
      }
      res.status(201).json({ ok: true });
    }));
    bench.operation('POST', '/documents/{id}/transaction', handle(async (req, res) => {
      // The handler's own transaction joins the Preview transaction.
      const session = client.startSession();
      await session.withTransaction(async () => {
        await collection().insertOne({ _id: req.params.id as never, name: 'In a transaction' }, { session });
      });
      await session.endSession();
      res.status(201).json({ ok: true });
    }));
    bench.operation('POST', '/documents/{id}/commit', handle(async (req, res) => {
      const session = client.startSession();
      session.startTransaction();
      await collection().insertOne({ _id: req.params.id as never, name: 'Committed' }, { session });
      try { await session.commitTransaction(); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  });
  await reader.db(name).collection('documents').insertOne({ _id: 'gone' as never, name: 'Gone' });
  return { ...harness, documents, raw };
}

/** The MongoDB Preview checks; the negative test expects them to fail without the hook. */
async function previewChecks(t: test.TestContext, hook = true) {
  const app = await driverApp(t, hook);
  const created = await app.confirmed('POST', '/documents', { id: 'draft', name: 'Draft', city: 'York', password: 'mongo-secret-value' });
  assert.equal(created.status, 201);
  const insert = created.changes.find(change => change.store === 'mongodb' && change.operation === 'insert');
  assert(insert, 'Expected a MongoDB insert change');
  assert.deepEqual([insert.table, insert.key, insert.before], ['documents', { _id: 'draft' }, null]);
  assert.deepEqual(insert.after.profile, { city: 'York' });
  assert.equal(insert.after.password_hash, '[REDACTED]');
  assert(!JSON.stringify(created).includes('mongo-secret-value'));
  assert.deepEqual(await app.documents({ _id: 'draft' }), [], 'The previewed insert must roll back');

  const updated = await app.confirmed('PATCH', '/documents/seeded', { name: 'Renamed', city: 'Hull' });
  const update = updated.changes.find(change => change.operation === 'update');
  assert.deepEqual([update.before.name, update.after.name, update.before.profile.city, update.after.profile.city], ['Seeded', 'Renamed', 'Leeds', 'Hull']);
  assert.equal(update.before.password_hash, '[REDACTED]');
  assert.equal((await app.documents({ _id: 'seeded' }))[0]?.name, 'Seeded', 'The previewed update must roll back');
}

test('driver: discovery reports preview mode on the replica set', await needs('mongodb'), async t => {
  const { capabilities } = await driverApp(t);
  assert.deepEqual((await capabilities()).dataStores, [{ system: 'mongodb', name: 'catalog', mode: 'preview' }]);
});

test('driver: a Preview rolls back and reports nested, redacted document changes', await needs('mongodb'), async t => {
  await previewChecks(t);
});

test('driver: the Preview checks fail without the hook', await needs('mongodb'), async t => {
  await assert.rejects(previewChecks(t, false), assert.AssertionError);
});

test('driver: replacements, upserts and deletes carry via and roll back', await needs('mongodb'), async t => {
  const app = await driverApp(t);
  const envelope = await app.confirmed('PUT', '/documents/seeded', { name: 'Replaced' });
  const byId = Object.fromEntries(envelope.changes.map(change => [change.key._id, change]));
  assert.deepEqual([byId.seeded?.operation, byId.seeded?.via], ['update', 'replace']);
  assert.deepEqual([byId.upserted?.operation, byId.upserted?.via], ['insert', 'upsert']);
  assert.deepEqual([byId.gone?.operation, byId.gone?.after], ['delete', null]);
  assert.equal(byId.gone.via, undefined);
  assert.equal((await app.documents()).length, 2, 'Nothing the Preview did may persist');
  const [entry] = dbEntries(envelope.logs, 'mongodb', 'update');
  assert(entry, 'Expected a Db entry for the update');
  assert.equal(entry.db.target, 'documents');
  assert(!entry.db.statement.includes('Replaced'), 'Statements carry no values');
});

test('driver: $out is blocked before sending, with the reason', await needs('mongodb'), async t => {
  const app = await driverApp(t);
  const problem = await assertBlocked(await app.preview('POST', '/documents/archive'), 'mongodb', 'aggregate');
  assert.match(String(problem.detail), /\$out/);
  assert.deepEqual(await app.raw.db().collection('documents_archive').find().toArray(), []);
});

test('driver: a write sent without the Preview session fails the Preview with 500', await needs('mongodb'), async t => {
  const app = await driverApp(t);
  await assertUnconfirmed(await app.preview('POST', '/documents/escaped/escape'));
  // The escaped write is real (nothing could stop it), which is why the Preview must not confirm.
  assert.equal((await app.documents({ _id: 'escaped' })).length, 1);
});

test('driver: a foreign session is refused and a handler commit fails the Preview', await needs('mongodb'), async t => {
  const app = await driverApp(t);
  await assertUnconfirmed(await app.preview('POST', '/documents/foreign/foreign'));
  await assertUnconfirmed(await app.preview('POST', '/documents/committed/commit'));
  assert.deepEqual(await app.documents({ _id: { $in: ['foreign', 'committed'] } }), []);
  const joined = await app.confirmed('POST', '/documents/joined/transaction');
  assert(joined.changes.some(change => change.key._id === 'joined' && change.operation === 'insert'));
  assert.deepEqual(await app.documents({ _id: 'joined' }), [], 'withTransaction joins the Preview and rolls back');
});

test('driver: observed Send commits once and traces commands', await needs('mongodb'), async t => {
  const app = await driverApp(t);
  const { status, trace } = await app.observed('POST', '/documents', { id: 'sent', name: 'Sent', city: 'Ely', password: 'mongo-secret-value' });
  assert.equal(status, 201);
  assert.equal(dbEntries(trace.logs, 'mongodb', 'insert').length, 1);
  assert(!JSON.stringify(trace).includes('mongo-secret-value'));
  assert.equal((await app.documents({ _id: 'sent' })).length, 1);
});

test('driver: a client is hooked once, before it connects', await needs('mongodb'), async t => {
  const client = new MongoClient(services.mongodb);
  mongoStore(client);
  assert.throws(() => mongoStore(client), /already hooked/);
  const connected = await new MongoClient(services.mongodb).connect();
  t.after(() => connected.close());
  assert.throws(() => mongoStore(connected), /monitorCommands/);
  assert.throws(() => mongoStore(new MongoClient(services.mongodb), { name: 'mongodb://host' }), TypeError);
});

test('Mongoose: models, queries, aggregation and connection.transaction join the Preview', await needs('mongodb'), async t => {
  const { name, documents } = await database(t);
  const instance = new mongoose.Mongoose();
  await instance.connect(url(name), { monitorCommands: true });
  t.after(() => instance.disconnect());
  const store = mongooseStore(instance, { name: 'catalog' });
  const Doc = instance.model('Doc', new instance.Schema({ _id: String, name: String, profile: { city: String }, password_hash: String }, { collection: 'documents', versionKey: false }));
  const app = await startApp(t, [store], bench => {
    bench.operation('POST', '/documents', handle(async (req, res) => {
      await Doc.create({ _id: req.body.id, name: 'Created', profile: { city: 'York' }, password_hash: 'hashed:mongoose-secret' });
      await Doc.updateOne({ _id: 'seeded' }, { $set: { name: 'Renamed' } });
      await Doc.insertMany([{ _id: 'many', name: 'Many' }]);
      res.status(201).json({ count: await Doc.countDocuments() });
    }));
    bench.operation('POST', '/transaction', handle(async (_req, res) => {
      await instance.connection.transaction(async () => { await Doc.create({ _id: 'in-tx', name: 'Tx' }); });
      res.status(201).json({ ok: true });
    }));
    bench.operation('POST', '/archive', handle(async (_req, res) => {
      await Doc.aggregate([{ $match: {} }, { $out: 'documents_archive' }]);
      res.sendStatus(204);
    }));
    bench.operation('POST', '/raw', handle(async (_req, res) => {
      await Doc.collection.insertOne({ _id: 'raw' as never, name: 'Raw' });
      res.status(201).json({ ok: true });
    }));
  });
  const envelope = await app.confirmed('POST', '/documents', { id: 'mongoose' });
  assert.deepEqual(envelope.body, { count: 3 }, 'Reads inside the Preview see its own writes');
  const ids = envelope.changes.map(change => `${change.operation}:${change.key._id}`).sort();
  assert.deepEqual(ids, ['insert:many', 'insert:mongoose', 'update:seeded']);
  assert.equal(envelope.changes.find(change => change.key._id === 'mongoose').after.password_hash, '[REDACTED]');
  assert.equal((await documents()).length, 1, 'Nothing the Preview wrote may persist');
  const transaction = await app.confirmed('POST', '/transaction');
  assert(transaction.changes.some(change => change.key._id === 'in-tx'));
  assert.equal((await documents({ _id: 'in-tx' })).length, 0);
  await assertBlocked(await app.preview('POST', '/archive'), 'mongodb', 'aggregate');
  await assertUnconfirmed(await app.preview('POST', '/raw'));
  assert.throws(() => mongooseStore(instance), /before defining models|already hooked/);
});

test('driver: a standalone server runs in guard mode, where reads run and writes block', await needs('mongodb'), async t => {
  const { name, documents } = await database(t);
  const raw = new MongoClient(url(name));
  t.after(() => raw.close());
  // Answer hello like a standalone server (no setName); every other command reaches the real server.
  const db = raw.db.bind(raw);
  raw.db = ((dbName?: string, options?: never) => {
    const handle = db(dbName, options);
    if (dbName !== 'admin') return handle;
    const command = handle.command.bind(handle);
    handle.command = (async (document: Record<string, unknown>, ...rest: never[]) =>
      document.hello ? { isWritablePrimary: true, maxWireVersion: 25 } : command(document as never, ...rest)) as typeof handle.command;
    return handle;
  }) as typeof raw.db;
  const store = mongoStore(raw, { name: 'catalog' });
  const collection = () => store.client.db().collection('documents');
  const app = await startApp(t, [store], bench => {
    bench.operation('GET', '/documents/{id}', handle(async (req, res) => { res.json(await collection().findOne({ _id: req.params.id as never })); }));
    bench.operation('POST', '/documents/{id}', handle(async (req, res) => {
      try { await collection().insertOne({ _id: req.params.id as never }); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  });
  assert.deepEqual((await app.capabilities()).dataStores, [{ system: 'mongodb', name: 'catalog', mode: 'guard', reason: "Preview unavailable: this MongoDB server doesn't support transactions" }]);
  assert.equal((await app.confirmed('GET', '/documents/seeded')).body.name, 'Seeded');
  await assertBlocked(await app.preview('POST', '/documents/blocked'), 'mongodb', 'insert');
  assert.deepEqual(await documents({ _id: 'blocked' }), []);
});

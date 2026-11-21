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
  const raw = standalone(new MongoClient(url(name)));
  t.after(() => raw.close());
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

/** A hooked driver client on a fresh seeded database, with routes from `register`. */
async function hookedApp(t: test.TestContext, register: (collection: () => ReturnType<ReturnType<MongoClient['db']>['collection']>, client: MongoClient) => Parameters<typeof startApp>[2], options: Parameters<typeof mongoStore>[1] = {}, raw?: MongoClient, app: Parameters<typeof startApp>[3] = {}) {
  const { name, reader, documents } = await database(t);
  const client = raw ?? new MongoClient(url(name));
  t.after(() => client.close());
  const store = mongoStore(client, options);
  const collection = () => store.client.db(name).collection('documents');
  const harness = await startApp(t, [store], register(collection, store.client), app);
  return { ...harness, name, reader, documents };
}

/** A promise and the function that settles it, for holding a handler mid-Preview. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

test('driver: before images come from the transaction start, not from later commits by others', await needs('mongodb'), async t => {
  const started = gate();
  const resume = gate();
  const app = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/tagged', handle(async (_req, res) => {
      await collection().updateMany({ tag: 'x' }, { $inc: { hits: 1 } });
      started.open();
      await resume.opened;
      res.json({ ok: true });
    }));
  });
  const documents = app.reader.db(app.name).collection('documents');
  await documents.insertOne({ _id: 'tagged' as never, tag: 'x', hits: 1 });
  await documents.insertOne({ _id: 'other' as never, tag: 'y', hits: 1 });
  const pending = app.confirmed('POST', '/tagged');
  await started.opened;
  // Another request commits while the Preview runs: a new matching document and a changed one.
  await documents.insertOne({ _id: 'late' as never, tag: 'x', hits: 5 });
  await documents.updateOne({ _id: 'other' as never }, { $set: { tag: 'x' } });
  resume.open();
  const { changes } = await pending;
  assert.deepEqual(changes.map(change => [change.operation, change.key._id, change.before?.hits, change.after?.hits]), [['update', 'tagged', 1, 2]],
    'Only the Preview\'s own update is a change; concurrent commits are not');
});

test('driver: a handler commitTransaction never confirms, before or after it reaches the server', await needs('mongodb'), async t => {
  const app = await hookedApp(t, (collection, client) => bench => {
    bench.operation('POST', '/admin-commit', handle(async (_req, res) => {
      const session = client.startSession();
      await collection().insertOne({ _id: 'admin-commit' as never }, { session });
      try { await client.db('admin').command({ commitTransaction: 1 }, { session }); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  });
  await assertUnconfirmed(await app.preview('POST', '/admin-commit'));
  assert.deepEqual(await app.documents({ _id: 'admin-commit' }), [], 'The refused commit never reached the server');

  // Mongoose's connection.db is the raw driver: only monitoring sees the commit. It may have
  // committed, so the Preview must fail even when no change-capture read trips over it (an insert
  // whose _id the server assigns leaves nothing to read back).
  const { name, documents } = await database(t);
  const instance = new mongoose.Mongoose();
  await instance.connect(url(name), { monitorCommands: true });
  t.after(() => instance.disconnect());
  const store = mongooseStore(instance);
  const mongooseApp = await startApp(t, [store], bench => {
    bench.operation('POST', '/raw-commit', handle(async (_req, res) => {
      const session = await instance.startSession();
      await instance.connection.db!.command({ insert: 'documents', documents: [{ name: 'raw-commit' }] }, { session });
      try { await instance.connection.db!.admin().command({ commitTransaction: 1 }, { session }); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  });
  await assertUnconfirmed(await mongooseApp.preview('POST', '/raw-commit'));
  // Nothing could stop the raw commit, which is why the Preview must not confirm.
  assert.equal((await documents({ name: 'raw-commit' })).length, 1);
});

test('driver: a stage added through the cursor builder is guarded before sending', await needs('mongodb'), async t => {
  // Preview mode: $out can't run in a transaction.
  const app = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/out', handle(async (_req, res) => {
      try { await collection().aggregate([{ $match: {} }]).out('copied').toArray(); } catch { /* swallowed on purpose */ }
      res.json({ ok: true });
    }));
  });
  const problem = await assertBlocked(await app.preview('POST', '/out'), 'mongodb', 'aggregate');
  assert.match(String(problem.detail), /\$out/);

  // Guard mode (a standalone server): the write must be refused before it reaches the server.
  const raw = standalone(new MongoClient(services.mongodb));
  const guarded = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/out', handle(async (_req, res) => {
      try { await collection().aggregate([{ $match: {} }]).addStage({ $merge: { into: 'merged' } }).toArray(); } catch { /* swallowed on purpose */ }
      res.json({ ok: true });
    }));
  }, {}, raw);
  await assertBlocked(await guarded.preview('POST', '/out'), 'mongodb', 'aggregate');
  assert.deepEqual(await guarded.reader.db(guarded.name).collection('merged').find().toArray(), []);
});

test('driver: a Preview keeps the mode it began in when detection later succeeds', await needs('mongodb'), async t => {
  const raw = new MongoClient(services.mongodb);
  // The first hello fails (a server that is briefly unreachable); later ones see the replica set.
  let hellos = 0;
  const db = raw.db.bind(raw);
  raw.db = ((dbName?: string, options?: never) => {
    const handle = db(dbName, options);
    if (dbName !== 'admin') return handle;
    const command = handle.command.bind(handle);
    handle.command = (async (document: Record<string, unknown>, ...rest: never[]) => {
      if (document.hello && hellos++ === 0) throw new Error('unreachable');
      return command(document as never, ...rest);
    }) as typeof handle.command;
    return handle;
  }) as typeof raw.db;
  const started = gate();
  const resume = gate();
  const app = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/documents/{id}', handle(async (req, res) => {
      started.open();
      await resume.opened;
      try { await collection().insertOne({ _id: req.params.id as never }); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  }, {}, raw);
  const pending = app.preview('POST', '/documents/raced');
  await started.opened;
  assert.equal((await app.capabilities()).dataStores[0].mode, 'preview', 'Detection succeeds while the first Preview runs');
  resume.open();
  await assertBlocked(await pending, 'mongodb', 'insert');
  assert.deepEqual(await app.documents({ _id: 'raced' }), [], 'A Preview that began in guard mode never sends a write');
});

test('driver: a Preview that outlives its time limit is aborted and never confirmed', await needs('mongodb'), async t => {
  const app = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/documents/{id}/slow', handle(async (req, res) => {
      await collection().insertOne({ _id: req.params.id as never });
      await new Promise(resolve => setTimeout(resolve, 600));
      try { await collection().insertOne({ _id: req.params.id + '-late' as never }); } catch { /* swallowed on purpose */ }
      res.status(201).json({ ok: true });
    }));
  }, { previewTimeoutMs: 200 });
  await assertUnconfirmed(await app.preview('POST', '/documents/slow/slow'));
  assert.deepEqual(await app.documents({ _id: { $in: ['slow', 'slow-late'] } }), []);
  assert.throws(() => mongoStore(new MongoClient(services.mongodb), { previewTimeoutMs: 0 }), TypeError);
});

test('driver: concurrent Previews and Sends never share a session', await needs('mongodb'), async t => {
  const app = await hookedApp(t, collection => bench => {
    bench.operation('POST', '/documents/{id}', handle(async (req, res) => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
      await collection().insertOne({ _id: req.params.id as never, name: req.params.id });
      await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
      res.status(201).json({ id: req.params.id, seen: await collection().countDocuments({ _id: req.params.id as never }) });
    }));
    bench.operation('POST', '/documents/{id}/fail', handle(async (req, res) => {
      await collection().insertOne({ _id: req.params.id as never });
      res.status(201);
      throw new Error('handler failed after writing');
    }));
  });
  const ids = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
  const results = await Promise.all(ids.map((id, index) => index % 3 === 0
    ? fetch(app.url + `/documents/send-${id}`, { method: 'POST' }).then(response => ({ kind: 'send', id: `send-${id}`, status: response.status }))
    : app.confirmed('POST', `/documents/${id}`).then(envelope => ({ kind: 'preview', id, envelope }))));
  for (const result of results) {
    if (result.kind === 'send') { assert.equal(result.status, 201); continue; }
    const { envelope, id } = result as { id: string; envelope: { body: { seen: number }; changes: { key: { _id: string } }[] } };
    assert.equal(envelope.body.seen, 1, 'Each Preview reads its own write');
    assert.deepEqual(envelope.changes.map(change => change.key._id), [id], 'Each Preview reports only its own change');
  }
  const persisted = (await app.documents({ _id: { $regex: 'concurrent' } })).map(document => document._id).sort();
  assert.deepEqual(persisted, ids.filter((_, index) => index % 3 === 0).map(id => `send-${id}`).sort(), 'Sends commit; Previews never do');
  await assertUnconfirmed(await app.preview('POST', '/documents/thrown/fail'));
  assert.deepEqual(await app.documents({ _id: 'thrown' }), [], 'A handler that throws still has its transaction aborted');
});

test('driver: a WriteConflict between two Previews reaches the handler, and both roll back', await needs('mongodb'), async t => {
  // MongoDB is the only database: no SQL provider, whose Previews would take turns.
  const holding = gate();
  const release = gate();
  const app = await hookedApp(t, collection => bench => {
    bench.operation('PATCH', '/documents/{id}', handle(async (req, res) => {
      try {
        await collection().updateOne({ _id: req.params.id as never }, { $set: { name: String(req.query.name) } });
      } catch (error) {
        res.status(409).json({ error: (error as { codeName?: string }).codeName });
        return;
      }
      if (req.query.hold) { holding.open(); await release.opened; }
      res.json({ ok: true });
    }));
  }, {}, undefined, { sqlProvider: false });
  const first = app.confirmed('PATCH', '/documents/seeded?name=First&hold=1');
  await holding.opened;
  const second = await app.confirmed('PATCH', '/documents/seeded?name=Second');
  release.open();
  assert.deepEqual([second.status, second.body], [409, { error: 'WriteConflict' }]);
  assert(dbEntries(second.logs, 'mongodb', 'update').some(entry => entry.db.error === 'WriteConflict'));
  assert.equal((await first).status, 200);
  assert.equal((await app.documents({ _id: 'seeded' }))[0]?.name, 'Seeded');
});

/** Make a client answer `hello` like a standalone server; every other command reaches the real server. */
function standalone(raw: MongoClient): MongoClient {
  const db = raw.db.bind(raw);
  raw.db = ((dbName?: string, options?: never) => {
    const handle = db(dbName, options);
    if (dbName !== 'admin') return handle;
    const command = handle.command.bind(handle);
    handle.command = (async (document: Record<string, unknown>, ...rest: never[]) =>
      document.hello ? { isWritablePrimary: true, maxWireVersion: 25 } : command(document as never, ...rest)) as typeof handle.command;
    return handle;
  }) as typeof raw.db;
  return raw;
}

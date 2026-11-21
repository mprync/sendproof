/**
 * Store hooks for the reference fixture: the part each binding writes once per client library.
 *
 * Every hook sits in front of the client's send path, so it sees a command before any byte of it
 * reaches the store. It classifies the command, lets the guard refuse writes in a Preview, joins
 * MongoDB commands to the Preview transaction, and records a redacted "Db" log entry.
 */
import { randomBytes } from 'node:crypto';
import { connectMongo, Long } from '../../stores/mongodb.mjs';
import { connectRedis } from '../../stores/redis.mjs';
import { dynamoClient } from '../../stores/dynamodb.mjs';
import {
  captureScope, classifyDynamo, classifyMongo, classifyRedis, dbLog, guard, guardEnabled, previewScope, record,
  redactDeep, sanitizeDocument,
} from './guard.mjs';

/** Converts BSON values to plain JSON (Extended JSON for types JSON lacks). */
const plain = value => JSON.parse(JSON.stringify(value ?? null));

/**
 * Redis: the hook wraps `send`, the one function every command goes through. Session commands
 * (AUTH, SELECT, PING…) are never guarded or logged, so the password can't reach a capture.
 */
export async function hookedRedis(url) {
  const client = await connectRedis(url);
  let queued = false;
  async function send(name, ...args) {
    const kind = classifyRedis(name, args);
    const operation = String(name).toUpperCase();
    if (kind === 'session') return client.send(name, ...args);
    if (kind === 'transaction') {
      queued = operation === 'MULTI' ? true : operation === 'EXEC' || operation === 'DISCARD' ? false : queued;
      return client.send(name, ...args);
    }
    try {
      guard('redis', operation, kind);
    } catch (error) {
      // A write queued after MULTI must never be followed by EXEC: discard the whole transaction.
      if (queued) { queued = false; await client.send('DISCARD'); }
      throw error;
    }
    const started = performance.now();
    const target = args.length ? String(args[0]) : undefined;
    const statement = [operation, ...(target === undefined ? [] : [target]), ...args.slice(1).map(() => '?')].join(' ');
    try {
      const reply = await client.send(name, ...args);
      record(dbLog({ system: 'redis', operation, target, statement, elapsedMs: performance.now() - started }));
      return reply;
    } catch (error) {
      record(dbLog({ system: 'redis', operation, target, statement, error: error.message.split(' ')[0], elapsedMs: performance.now() - started }));
      throw error;
    }
  }
  return { send, close: client.close };
}

/**
 * DynamoDB: the hook wraps `call(operation, input)`, the equivalent of an AWS SDK initialize-step
 * middleware. Credentials and signatures live below the hook, so they never reach a capture.
 */
export function hookedDynamo(options) {
  const client = dynamoClient(options);
  async function call(operation, input) {
    guard('dynamodb', operation, classifyDynamo(operation, input));
    const started = performance.now();
    const statement = input.Statement;
    const target = input.TableName ?? statement?.match(/"([^"]+)"/)?.[1];
    try {
      const reply = await client.call(operation, input);
      const rows = reply.Items?.length ?? (reply.Item || reply.Attributes ? 1 : undefined);
      record(dbLog({ system: 'dynamodb', operation, target, statement, rowsAffected: rows, elapsedMs: performance.now() - started }));
      return reply;
    } catch (error) {
      record(dbLog({ system: 'dynamodb', operation, target, statement, error: error.type, elapsedMs: performance.now() - started }));
      throw error;
    }
  }
  return { call };
}

/**
 * MongoDB: the hook wraps `command(document)`. In a Preview on a replica set it adds the Preview
 * session's lsid, txnNumber and autocommit:false to every command, starting the transaction on the
 * first one, and remembers which documents each write could have touched. On a standalone server
 * it guards writes like Redis.
 */
export async function hookedMongo(url) {
  const client = await connectMongo(url);
  const hello = await client.command({ hello: 1 });
  const transactions = Boolean((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null);
  const mode = transactions ? 'preview' : 'guard';
  const namespace = client.database;

  /** The per-Preview transaction state, created on the first command of a Preview. */
  function transaction(scope) {
    scope.mongo ??= {
      session: { id: client.newSession().id }, txnNumber: new Long(1), started: false, chain: Promise.resolve(),
      inserted: [], filters: [],
    };
    return scope.mongo;
  }
  const sessionFields = state => ({ lsid: state.session, txnNumber: state.txnNumber, autocommit: false });

  async function command(document) {
    const name = Object.keys(document)[0];
    const { kind, refusedInTransaction } = classifyMongo(document);
    const scope = previewScope();
    if (kind === 'session' && ['committransaction', 'aborttransaction'].includes(name.toLowerCase()) && scope) {
      // The handler must not end the Preview's transaction: treat it like a raw SQL COMMIT.
      if (guardEnabled) { scope.fault ??= new Error(`Preview refused ${name} from the handler`); throw scope.fault; }
    }
    if (scope && mode === 'preview' && refusedInTransaction) {
      guard('mongodb', name, 'write', `Preview unavailable: MongoDB can't run ${refusedInTransaction} inside a transaction`);
    }
    if (scope && mode === 'guard') guard('mongodb', name, kind);

    const collection = typeof document[name] === 'string' ? document[name] : undefined;
    const statement = kind === 'session' ? undefined : JSON.stringify(sanitizeDocument(document));
    const started = performance.now();
    let reply;
    try {
      if (scope && mode === 'preview') {
        const state = transaction(scope);
        if (collection && name === 'insert') state.inserted.push(...document.documents.map(item => ({ collection, id: item._id })));
        if (collection && name === 'update') state.filters.push(...document.updates.map(item => ({ collection, filter: item.q })));
        if (collection && name === 'delete') state.filters.push(...document.deletes.map(item => ({ collection, filter: item.q })));
        if (collection && name === 'findAndModify') state.filters.push({ collection, filter: document.query ?? {} });
        // Commands in one transaction run one at a time, and only the first carries startTransaction.
        const run = state.chain.then(() => {
          const first = !state.started;
          state.started = true;
          return client.command({
            ...document, ...sessionFields(state),
            ...(first ? { startTransaction: true, readConcern: { level: 'snapshot' } } : {}),
          });
        });
        state.chain = run.catch(() => {});
        reply = await run;
        for (const upsert of reply.upserted ?? []) state.inserted.push({ collection, id: upsert._id });
      } else {
        reply = await client.command(document);
      }
    } catch (error) {
      // The server refused something a transaction can't do (code 263): nothing was applied, and it is a block, not a crash.
      if (scope && mode === 'preview' && error.code === 263 && guardEnabled) {
        scope.blocked ??= { store: 'mongodb', operation: name, detail: `Preview unavailable: MongoDB can't run ${name} inside a transaction` };
      }
      if (kind !== 'session') record(dbLog({ system: 'mongodb', operation: name, target: collection, namespace, statement, error: error.codeName, elapsedMs: performance.now() - started }));
      throw error;
    }
    if (kind !== 'session') {
      const rows = reply.cursor ? reply.cursor.firstBatch.length : reply.n;
      record(dbLog({ system: 'mongodb', operation: name, target: collection, namespace, statement, rowsAffected: rows, elapsedMs: performance.now() - started }));
    }
    return reply;
  }

  /** Reads documents inside the Preview transaction (after) or from the committed view (before). */
  async function read(collection, filter, state) {
    const reply = await client.command(state
      ? { find: collection, filter, batchSize: 1000, ...sessionFields(state) }
      : { find: collection, filter, batchSize: 1000, readConcern: { level: 'majority' } });
    return reply.cursor.firstBatch;
  }

  /**
   * Called by the Preview pipeline after the handler. Computes document changes as
   * spec/data-stores.md describes, then aborts the transaction. Throws when the abort fails.
   */
  async function finishPreview(scope, cap = 200) {
    const state = scope.mongo;
    if (!state?.started) return;
    // A failed command inside a transaction makes the server abort it; there is then nothing to capture or abort.
    const gone = error => error?.codeName === 'NoSuchTransaction';
    try {
      await state.chain;
      await capture(scope, state, cap).catch(error => { if (!gone(error)) throw error; });
    } finally {
      await client.command({ abortTransaction: 1, ...sessionFields(state), $db: 'admin' })
        .catch(error => { if (!gone(error)) throw error; });
      await client.command({ endSessions: [state.session], $db: 'admin' }).catch(() => {});
    }
  }

  /** Compares each candidate document's committed and in-transaction versions and records the differences. */
  async function capture(scope, state, cap) {
    const candidates = new Map();
    const add = (collection, id) => candidates.set(collection + '\u0000' + JSON.stringify(plain(id)), { collection, id });
    for (const { collection, id } of state.inserted) add(collection, id);
    for (const { collection, filter } of state.filters) {
      for (const document of [...await read(collection, filter, state), ...await read(collection, filter)]) add(collection, document._id);
    }
    for (const { collection, id } of candidates.values()) {
      if (scope.changes.length >= cap) { scope.changesTruncated = true; break; }
      const [before] = await read(collection, { _id: id });
      const [after] = await read(collection, { _id: id }, state);
      if (JSON.stringify(plain(before)) === JSON.stringify(plain(after))) continue;
      scope.changes.push({
        operation: before === undefined ? 'insert' : after === undefined ? 'delete' : 'update',
        store: 'mongodb', namespace, table: collection, key: redactDeep({ _id: plain(id) }),
        before: before === undefined ? null : redactDeep(plain(before)),
        after: after === undefined ? null : redactDeep(plain(after)),
      });
    }
  }

  return { mode, namespace, command, finishPreview, close: client.close };
}

/** A trace or session token: 32 random bytes, base64url. */
export const token = () => randomBytes(32).toString('base64url');

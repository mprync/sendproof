/**
 * Guarded handles for the MongoDB Node driver. No driver offers a pre-send hook, so
 * `mongoStore(client).client` is a proxy whose `db()` and `collection()` return proxies with the
 * driver's own API. During a Preview each call is checked before the driver builds a command:
 *
 * - every option object gets the Preview session (`preview` mode), so the command carries the
 *   Preview's `lsid`, `txnNumber` and `autocommit: false`;
 * - an explicit session other than the Preview's is refused, failing the Preview with 500;
 * - the guard classifies the command the method sends and blocks writes (`guard` mode) or what a
 *   transaction can't run (`preview` mode);
 * - a method the table below doesn't know is refused, so a new driver method fails closed;
 * - an aggregation cursor's builder methods (`out`, `merge`, `addStage`) are classified too, so a
 *   stage added after `aggregate()` returned can't slip a write past the guard;
 * - every derived handle stays guarded: `db(name, options)`, `collection(name, options)`,
 *   `admin()` and an aggregation cursor's `clone()`. The driver has no other method that returns
 *   a client, database or collection with different options.
 *
 * Outside a Preview every call passes straight through.
 */
import { currentPreview, guard, refuseInPreview } from '@sendproof/core';
import type { ClientSession, Collection, Db, MongoClient } from 'mongodb';
import { refusedReason, systemDatabase } from './engine.js';
import type { MongoEngine } from './engine.js';

type Doc = Record<string, unknown>;

/**
 * How one driver method is guarded: the index of its options argument, and the command document
 * (its first key is the command name) the guard classifies.
 */
interface Rule { options: number; command: (name: string, args: unknown[]) => Doc }

const simple = (command: string, options: number): Rule => ({ options, command: name => ({ [command]: name }) });
const aggregate = (options: number): Rule => ({ options, command: (name, args) => ({ aggregate: name, pipeline: args[0] ?? [] }) });

/** Collection methods, by name: where the options go and which command each sends. */
const collectionRules: Record<string, Rule> = {
  insertOne: simple('insert', 1), insertMany: simple('insert', 1), bulkWrite: simple('bulkWrite', 1),
  updateOne: simple('update', 2), updateMany: simple('update', 2), replaceOne: simple('update', 2),
  deleteOne: simple('delete', 1), deleteMany: simple('delete', 1),
  findOne: simple('find', 1), find: simple('find', 1), countDocuments: aggregate(1), distinct: simple('distinct', 2),
  findOneAndDelete: simple('findAndModify', 1), findOneAndReplace: simple('findAndModify', 2), findOneAndUpdate: simple('findAndModify', 2),
  aggregate: aggregate(1), estimatedDocumentCount: simple('count', 0), count: simple('count', 1),
  rename: simple('renameCollection', 1), drop: simple('drop', 0), options: simple('listCollections', 0), isCapped: simple('listCollections', 0),
  createIndex: simple('createIndexes', 1), createIndexes: simple('createIndexes', 1), dropIndex: simple('dropIndexes', 1), dropIndexes: simple('dropIndexes', 0),
  listIndexes: simple('listIndexes', 0), indexes: simple('listIndexes', 0), indexInformation: simple('listIndexes', 0), indexExists: simple('listIndexes', 1),
  initializeOrderedBulkOp: simple('bulkWrite', 0), initializeUnorderedBulkOp: simple('bulkWrite', 0),
  watch: { options: 1, command: (name, args) => ({ aggregate: name, pipeline: [{ $changeStream: {} }, ...((args[0] as unknown[]) ?? [])] }) },
};

/** Db methods, by name. `command` and `runCursorCommand` classify the document they are given. */
const dbRules: Record<string, Rule> = {
  command: { options: 1, command: (_name, args) => (args[0] as Doc) ?? {} },
  runCursorCommand: { options: 1, command: (_name, args) => (args[0] as Doc) ?? {} },
  aggregate: { options: 1, command: (_name, args) => ({ aggregate: 1, pipeline: args[0] ?? [] }) },
  createCollection: { options: 1, command: (_name, args) => ({ create: args[0] }) },
  dropCollection: { options: 1, command: (_name, args) => ({ drop: args[0] }) },
  dropDatabase: simple('dropDatabase', 0), listCollections: simple('listCollections', 1), collections: simple('listCollections', 0),
  renameCollection: { options: 2, command: (_name, args) => ({ renameCollection: args[0] }) },
  createIndex: { options: 2, command: (_name, args) => ({ createIndexes: args[0] }) },
  indexInformation: { options: 1, command: (_name, args) => ({ listIndexes: args[0] }) },
  stats: simple('dbStats', 0), profilingLevel: simple('profile', 0), setProfilingLevel: simple('profile', 1),
  watch: { options: 1, command: (_name, args) => ({ aggregate: 1, pipeline: [{ $changeStream: {} }, ...((args[0] as unknown[]) ?? [])] }) },
};

/** Client methods, by name, beyond `db`, `startSession` and `withSession`. */
const clientRules: Record<string, Rule> = {
  bulkWrite: { options: 1, command: () => ({ bulkWrite: 1 }) },
  watch: { options: 1, command: () => ({ aggregate: 1, pipeline: [{ $changeStream: {} }] }) },
};

/** Methods that return synchronously (cursors and bulk builders); the rest return promises. */
const synchronous = new Set(['find', 'aggregate', 'listIndexes', 'listCollections', 'watch', 'initializeOrderedBulkOp', 'initializeUnorderedBulkOp', 'runCursorCommand']);

/** Methods that are neither commands nor handles, passed through untouched. */
const inert = new Set(['constructor', 'toString', 'toJSON', 'on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners', 'listeners', 'listenerCount', 'eventNames', 'getMaxListeners', 'setMaxListeners', 'prependListener', 'prependOnceListener', 'rawListeners']);

/** Aggregation cursor methods that add a stage, and the stage each adds. */
const cursorStages: Record<string, (args: unknown[]) => unknown> = {
  out: () => ({ $out: '?' }),
  merge: () => ({ $merge: '?' }),
  addStage: args => args[0],
};

/**
 * Guard an aggregation or change-stream cursor: during a Preview, a stage added through its
 * builder is classified with the pipeline it joins before the cursor can run. Builder methods
 * return the guarded cursor, so chaining keeps the guard.
 */
function guardCursor<T extends object>(cursor: T, engine: MongoEngine, name: string, database: string | undefined): T {
  const proxy: T = new Proxy(cursor, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      const stage = typeof property === 'string' ? cursorStages[property] : undefined;
      return function call(this: unknown, ...args: unknown[]) {
        if (stage && currentPreview()) {
          const pipeline = (object as { pipeline?: unknown[] }).pipeline ?? [];
          engine.check({ aggregate: name, pipeline: [...pipeline, stage(args)] }, 'aggregate', database);
        }
        const result = (value as (...a: unknown[]) => unknown).apply(object, args);
        // `clone()` derives a new cursor (without the Preview session): it stays guarded too.
        if (property === 'clone' && result && typeof result === 'object') return guardCursor(result, engine, name, database);
        return result === object ? proxy : result;
      };
    },
  });
  return proxy;
}

/** Fail a call the way its method fails: a throw for synchronous methods, a rejection otherwise. */
function fail(method: string, error: unknown): unknown {
  if (synchronous.has(method)) throw error;
  return Promise.reject(error);
}

/**
 * Prepare one call during a Preview: guard it, and give its options the Preview session. Returns
 * the arguments to call the driver with. Throws the guard's error, or a refusal for a foreign
 * session.
 */
function prepare(engine: MongoEngine, rule: Rule, method: string, name: string, args: unknown[], database: string | undefined): unknown[] {
  const command = rule.command(name, args);
  engine.check(command, Object.keys(command)[0] ?? method, database);
  const state = engine.state();
  if (!state || systemDatabase(database)) return args;
  const given = args[rule.options] as { session?: ClientSession } | undefined;
  if (given?.session && given.session !== state.session) {
    throw refuseInPreview('A MongoDB call passed its own session during a Preview; the Preview session must carry every command.')!;
  }
  const next = [...args];
  while (next.length < rule.options) next.push(undefined);
  next[rule.options] = { ...(given ?? {}), session: state.session };
  return next;
}

/** Wrap a driver handle so each listed method is prepared during a Preview. Unknown methods fail closed. */
function guarded<T extends object>(target: T, engine: MongoEngine, rules: Record<string, Rule>, name: string, database: string | undefined, special: Record<string, (...args: unknown[]) => unknown> = {}): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && Object.hasOwn(special, property)) return special[property];
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || inert.has(property)) return value;
      const rule = rules[property];
      const run = (args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(object, args);
        return property === 'aggregate' && result && typeof result === 'object' ? guardCursor(result, engine, name, database) : result;
      };
      return function call(...args: unknown[]) {
        if (!currentPreview()) return run(args);
        if (!rule) {
          // A method this guard doesn't know: refuse it in a Preview rather than let it escape.
          try {
            guard('mongodb', property, 'write', refusedReason(property));
          } catch (error) {
            return fail(property, error);
          }
        }
        let prepared;
        try {
          prepared = prepare(engine, rule!, property, name, args, database);
        } catch (error) {
          return fail(property, error);
        }
        return run(prepared);
      };
    },
  });
}

function guardDb(db: Db, engine: MongoEngine): Db {
  const database = db.databaseName;
  return guarded(db, engine, dbRules, database, database, {
    collection: (name: unknown, options?: unknown) => guardCollection(db.collection(name as string, options as never), engine),
    admin: () => guarded(db.admin(), engine, { command: dbRules.command! }, 'admin', 'admin'),
  });
}

function guardCollection(collection: Collection, engine: MongoEngine): Collection {
  return guarded(collection, engine, collectionRules, collection.collectionName, collection.dbName);
}

/**
 * The guarded client: `db()` returns guarded databases; in a Preview `startSession()` and
 * `withSession()` hand out the Preview session, whose transaction methods join the Preview.
 */
export function guardClient(client: MongoClient, engine: MongoEngine): MongoClient {
  // Client-level commands such as bulkWrite address user databases, so they join the transaction.
  return guarded(client, engine, clientRules, '', undefined, {
    db: (name?: unknown, options?: unknown) => guardDb(client.db(name as string | undefined, options as never), engine),
    startSession: (options?: unknown) => engine.state()?.session ?? client.startSession(options as never),
    withSession: (first: unknown, second?: unknown) => {
      const callback = (typeof first === 'function' ? first : second) as (session: ClientSession) => Promise<unknown>;
      const session = engine.state()?.session;
      return session ? callback(session) : client.withSession(first as never, second as never);
    },
  });
}

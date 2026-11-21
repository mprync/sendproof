/**
 * Sendproof Preview and write guard for MongoDB (spec/data-stores.md "MongoDB in Preview").
 *
 * On a replica set or sharded cluster a Preview runs every command in one transaction that is
 * aborted after the handler, and reports document changes. On a standalone server MongoDB can't
 * run transactions, so the store runs in `guard` mode like Redis: reads run and the first write
 * blocks the Preview.
 *
 * - Driver: `const catalog = mongoStore(new MongoClient(url), { name: 'catalog' })`; handlers use
 *   `catalog.client`, a guarded client with the driver's API.
 * - Mongoose 8: `mongooseStore(mongoose, { name: 'catalog' })` after `mongoose.connect()` and before
 *   defining models.
 *
 * Only hooked clients are covered. Command monitoring backs both up: a write sent during a Preview
 * without the Preview session (through the raw client, or a call that bypasses Mongoose
 * middleware) fails the Preview with 500, so a rollback is never claimed for it.
 */
import { readSet, storeLabel } from '@sendproof/core';
import type { CaptureRecorder, DataStore, DataStoreDescription } from '@sendproof/core';
import type { MongoClient } from 'mongodb';
import { guardClient } from './driver.js';
import { MongoEngine } from './engine.js';
import { hookMongoose } from './mongoose.js';
import type { MongooseLike } from './mongoose.js';

export { plain, refusedReason, standaloneReason } from './engine.js';
export type { MongooseLike } from './mongoose.js';

/** Options for {@link mongoStore} and {@link mongooseStore}. */
export interface MongoStoreOptions {
  /** Display label for discovery, such as `catalog`. Never a connection string or host. */
  name?: string;
  /**
   * Commands the host states never write, by exact name (compared case-insensitively, as MongoDB
   * does). A wrongly listed write is not blocked in `guard` mode.
   */
  treatAsRead?: string[];
  /**
   * How long a Preview may hold its MongoDB transaction, in milliseconds; 50 seconds by default,
   * below the server's 60-second transaction lifetime. A Preview still running at the limit has
   * its transaction aborted and answers 500 without confirmation.
   */
  previewTimeoutMs?: number;
}

/** A hooked MongoDB driver client. */
export interface MongoStore extends DataStore {
  readonly system: 'mongodb';
  /** The guarded client handlers must use: same API, Preview session added during a Preview. */
  readonly client: MongoClient;
}

/** A hooked Mongoose instance. */
export interface MongooseStore extends DataStore {
  readonly system: 'mongodb';
}

const engines = new WeakMap<object, MongoEngine>();

function engineFor(client: MongoClient, options: MongoStoreOptions): MongoEngine {
  if (engines.has(client)) throw new TypeError('This MongoClient is already hooked.');
  const { previewTimeoutMs } = options;
  if (previewTimeoutMs !== undefined && (!Number.isSafeInteger(previewTimeoutMs) || previewTimeoutMs <= 0)) {
    throw new TypeError('previewTimeoutMs must be a positive whole number of milliseconds.');
  }
  const engine = new MongoEngine(client, { reads: readSet(options.treatAsRead, name => name.toLowerCase()), ...(previewTimeoutMs === undefined ? {} : { previewTimeoutMs }) });
  engines.set(client, engine);
  return engine;
}

/** The DataStore methods shared by both registrations. */
function store(engine: MongoEngine, name: string | undefined, around: (capture: CaptureRecorder, dispatch: () => Promise<unknown>) => Promise<unknown>) {
  return {
    system: 'mongodb' as const,
    async describe(): Promise<DataStoreDescription> {
      return { system: 'mongodb', ...(name === undefined ? {} : { name }), ...await engine.detect() };
    },
    around: around as DataStore['around'],
    finishPreview: (capture: CaptureRecorder) => engine.finish(capture),
  };
}

/**
 * Hook a MongoDB driver client and return the store for `dataStores`. Call it before the client
 * connects, or create the client with `{ monitorCommands: true }`. Handlers must use the returned
 * `client`; the original stays unguarded.
 */
export function mongoStore(client: MongoClient, options: MongoStoreOptions = {}): MongoStore {
  const name = storeLabel(options.name);
  if (!client || typeof (client as { db?: unknown }).db !== 'function' || typeof client.startSession !== 'function') {
    throw new TypeError('mongoStore takes a MongoClient from the mongodb driver.');
  }
  const engine = engineFor(client, options);
  return {
    ...store(engine, name, async (capture, dispatch) => { await engine.begin(capture); return dispatch(); }),
    client: guardClient(client, engine),
  };
}

/**
 * Hook a connected Mongoose 8 instance and return the store for `dataStores`. Call it after
 * `mongoose.connect(url, { monitorCommands: true })` and before defining models.
 */
export function mongooseStore(mongoose: MongooseLike, options: MongoStoreOptions = {}): MongooseStore {
  const name = storeLabel(options.name);
  const client = mongoose?.connection?.getClient?.();
  if (!client) throw new TypeError('Call mongooseStore after mongoose.connect(), with a connected Mongoose instance.');
  const engine = engineFor(client, options);
  const run = hookMongoose(mongoose, engine, () => mongoose.connection.name);
  return store(engine, name, async (capture, dispatch) => run((await engine.begin(capture))?.session, dispatch));
}

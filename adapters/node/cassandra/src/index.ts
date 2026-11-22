/**
 * Sendproof write guard for Apache Cassandra and ScyllaDB (spec/data-stores.md, `guard` mode).
 *
 * `cassandraStore(client)` hooks a `cassandra-driver` 4 `Client` in place, at the statement API
 * above the driver's own prepare: `execute`, `eachRow`, `stream` and `batch` all receive the CQL
 * text (a prepared call too, because the text is what the caller passes), so every call is
 * classified by its text before any request is built. The driver's Mapper and `executeConcurrent`
 * call these methods on the client and are covered the same way. `executeGraph` (DataStax Graph)
 * is refused in a Preview, because its traversals may write.
 *
 * Reads run. In a Preview the first write is refused with `PreviewWriteBlockedError` and the
 * Preview answers 409. Every `batch` is a write, including an empty one, because its statements
 * may be prepared ids the guard can't read. A statement with a second statement after a
 * semicolon, a lightweight transaction (`IF …`) and anything the table doesn't list is a write.
 *
 * Every call becomes a `Db` log entry whose statement keeps the CQL text with quoted strings,
 * `$$` strings and numbers replaced by `?`; bound values are never logged.
 *
 * Coverage: only the hooked `Client` instance. A second `Client` (or `new Client` built later) is
 * not covered, and neither is anything that bypasses the client such as raw connections.
 */
import { Readable } from 'node:stream';
import { cassandraTarget, classifyCassandra, currentCapture, guard, readSet, sanitizeStatement, storeLabel } from '@sendproof/core';
import type { CaptureRecorder, DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link cassandraStore}. */
export interface CassandraStoreOptions {
  /** Display label for discovery, such as `tickets`. Never a host name or contact point. */
  name?: string;
  /**
   * Statement keys the host states never write, such as a custom read the table doesn't know.
   * Exact upper-case names (`SELECT`, `LIST ROLES`), no wildcards. A wrongly listed write is not blocked.
   */
  treatAsRead?: string[];
}

/** A hooked Cassandra client, ready for `dataStores`. */
export interface CassandraStore<Client> extends DataStore {
  readonly system: 'cassandra';
  /** The same client, now guarded. */
  readonly client: Client;
}

/** The parts of a `cassandra-driver` Client the hook replaces or reads. */
interface DriverClient {
  keyspace?: string;
  execute(query: unknown, params?: unknown, options?: unknown, callback?: unknown): unknown;
  eachRow(query: unknown, ...rest: unknown[]): unknown;
  stream(query: unknown, ...rest: unknown[]): unknown;
  batch(queries: unknown, options?: unknown, callback?: unknown): unknown;
  executeGraph?(...args: unknown[]): unknown;
  [method: string]: unknown;
}

type Callback = (error?: Error | null, result?: unknown) => void;
const hooked = Symbol.for('sendproof.cassandra.hooked');

/** The CQL text of a `batch` item: a string, or an object holding the `query`. */
const itemText = (item: unknown): string => typeof item === 'string' ? item : typeof (item as { query?: unknown })?.query === 'string' ? (item as { query: string }).query : '?';

/** Fail a call the guard refused the way the driver reports errors: the callback when given, otherwise a rejected promise. */
function refuse(error: unknown, callback: Callback | undefined): Promise<never> | undefined {
  if (!callback) return Promise.reject(error);
  process.nextTick(() => callback(error as Error));
  return undefined;
}

/** The callback among a call's trailing arguments (the driver takes it in whichever position is left). */
const callbackOf = (args: readonly unknown[]): Callback | undefined => args.find((arg): arg is Callback => typeof arg === 'function');

/** Replace the callback among `args` with `wrap(callback)`, leaving every other argument alone. */
const withCallback = (args: unknown[], wrap: (callback: Callback) => Callback): unknown[] => args.map(arg => typeof arg === 'function' ? wrap(arg as Callback) : arg);

/** Record one finished or failed statement on the capture that was current when it was sent. */
function record(capture: CaptureRecorder | undefined, client: DriverClient, operation: string, text: string, started: number, result?: unknown, error?: unknown) {
  if (!capture) return;
  const { keyspace, table } = cassandraTarget(text);
  const rows = (result as { rowLength?: unknown } | undefined)?.rowLength;
  capture.db({
    system: 'cassandra', operation, statement: sanitizeStatement(text),
    ...(table === undefined ? {} : { target: table }),
    ...((keyspace ?? client.keyspace) === undefined ? {} : { namespace: (keyspace ?? client.keyspace)! }),
    ...(typeof rows === 'number' ? { rowsAffected: rows } : {}),
    ...(error ? { error: (error as { name?: string }).name ?? 'Error' } : {}),
    elapsedMs: performance.now() - started,
  });
}

/**
 * Hook a `cassandra-driver` Client in place and return the store for `dataStores`, before or after
 * it connects. Hooking the same client twice is refused, so its statements are never logged twice.
 */
export function cassandraStore<Client extends object>(client: Client, options: CassandraStoreOptions = {}): CassandraStore<Client> {
  const name = storeLabel(options.name);
  const reads = readSet(options.treatAsRead, item => item.toUpperCase());
  const target = client as unknown as DriverClient;
  if (!target || typeof target.execute !== 'function' || typeof target.batch !== 'function' || typeof target.eachRow !== 'function' || typeof target.stream !== 'function') {
    throw new TypeError('cassandraStore takes a cassandra-driver 4 Client.');
  }
  if ((client as Record<PropertyKey, unknown>)[hooked]) throw new TypeError('This Cassandra client is already hooked by cassandraStore.');
  const execute = target.execute.bind(target);
  const eachRow = target.eachRow.bind(target);
  const stream = target.stream.bind(target);
  const batch = target.batch.bind(target);
  // `stream` calls `this.eachRow`, which is now guarded: the flag keeps one call from being checked and logged twice.
  let streaming = false;

  target.execute = function guardedExecute(query: unknown, ...rest: unknown[]) {
    const { kind, operation } = classifyCassandra(query, reads);
    try {
      guard('cassandra', operation, kind);
    } catch (error) {
      return refuse(error, callbackOf(rest));
    }
    const capture = currentCapture();
    const started = performance.now();
    const text = typeof query === 'string' ? query : '';
    if (rest.some(arg => typeof arg === 'function')) {
      return execute(query, ...withCallback(rest, callback => (error, result) => {
        record(capture, target, operation, text, started, result, error ?? undefined);
        callback(error, result);
      }));
    }
    const reply = execute(query, ...rest) as Promise<unknown>;
    reply.then(result => record(capture, target, operation, text, started, result), error => record(capture, target, operation, text, started, undefined, error));
    return reply;
  };

  target.eachRow = function guardedEachRow(query: unknown, ...rest: unknown[]) {
    if (streaming) return eachRow(query, ...rest);
    const { kind, operation } = classifyCassandra(query, reads);
    try {
      guard('cassandra', operation, kind);
    } catch (error) {
      // With two functions the last is the completion callback; with one it is the row callback and the driver ignores errors.
      const callbacks = rest.filter(arg => typeof arg === 'function') as Callback[];
      const done = callbacks.length > 1 ? callbacks.at(-1) : undefined;
      if (done) process.nextTick(() => done(error as Error));
      return undefined;
    }
    // Rows arrive page by page; the entry is recorded when the statement is sent, without a row count.
    record(currentCapture(), target, operation, typeof query === 'string' ? query : '', performance.now());
    return eachRow(query, ...rest);
  };

  target.stream = function guardedStream(query: unknown, ...rest: unknown[]) {
    const { kind, operation } = classifyCassandra(query, reads);
    try {
      guard('cassandra', operation, kind);
    } catch (error) {
      // A readable stream that fails with the refusal, as the driver's ResultStream does for any error.
      const refused = new Readable({ objectMode: true, read() {} });
      setImmediate(() => refused.destroy(error as Error));
      const done = callbackOf(rest);
      if (done) process.nextTick(() => done(error as Error));
      return refused;
    }
    record(currentCapture(), target, operation, typeof query === 'string' ? query : '', performance.now());
    streaming = true;
    try {
      return stream(query, ...rest);
    } finally {
      streaming = false;
    }
  };

  target.batch = function guardedBatch(queries: unknown, ...rest: unknown[]) {
    const texts = Array.isArray(queries) ? queries.map(itemText) : [];
    try {
      guard('cassandra', 'BATCH', 'write');
    } catch (error) {
      return refuse(error, callbackOf(rest));
    }
    // Outside a Preview a batch runs normally and is logged as BEGIN BATCH <statement>; …; APPLY BATCH.
    const capture = currentCapture();
    const started = performance.now();
    const text = `BEGIN BATCH ${texts.join('; ')}; APPLY BATCH`;
    const done = (error?: unknown) => {
      if (!capture) return;
      const { keyspace, table } = cassandraTarget(texts[0]);
      capture.db({
        system: 'cassandra', operation: 'BATCH', statement: sanitizeStatement(text),
        ...(table === undefined ? {} : { target: table }),
        ...((keyspace ?? target.keyspace) === undefined ? {} : { namespace: (keyspace ?? target.keyspace)! }),
        ...(error ? { error: (error as { name?: string }).name ?? 'Error' } : {}),
        elapsedMs: performance.now() - started,
      });
    };
    if (rest.some(arg => typeof arg === 'function')) {
      return batch(queries, ...withCallback(rest, callback => (error, result) => { done(error ?? undefined); callback(error, result); }));
    }
    const reply = batch(queries, ...rest) as Promise<unknown>;
    reply.then(() => done(), error => done(error));
    return reply;
  };

  if (typeof target.executeGraph === 'function') {
    const executeGraph = target.executeGraph.bind(target);
    target.executeGraph = function guardedExecuteGraph(...args: unknown[]) {
      // A graph traversal may write and the guard can't read it, so a Preview refuses it.
      try {
        guard('cassandra', 'executeGraph', 'write');
      } catch (error) {
        return refuse(error, callbackOf(args.slice(1)));
      }
      return executeGraph(...args);
    };
  }

  Object.defineProperty(client, hooked, { value: true });
  const description: DataStoreDescription = { system: 'cassandra', ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system: 'cassandra', client, describe: async () => ({ ...description }) };
}

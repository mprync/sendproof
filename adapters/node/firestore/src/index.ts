/**
 * Sendproof write guard for Google Cloud Firestore, native mode (spec/data-stores.md, `guard` mode).
 *
 * `firestoreStore(firestore)` hooks a `@google-cloud/firestore` 7 `Firestore` instance in place.
 * Every RPC the SDK makes (unary, server-streaming and bidirectional, over gRPC or the REST
 * fallback alike) runs as an operation on a pooled GAPIC client, handed out by the instance's
 * client pool. The hook wraps the pool's `run` so each operation receives a guarded view of that
 * client, which classifies the RPC by its method name with the shared table
 * (`spec/data-stores/firestore.json`) before it calls the real method:
 *
 * - reads (`GetDocument`, `RunQuery`, `BatchGetDocuments`, `Listen` …) run and are logged;
 * - `BeginTransaction`, `Rollback` and a `Commit` with no writes are session calls: they run unlogged;
 * - a `Commit` is judged by its `writes`, which are readable on the request message;
 * - every other RPC, `BatchWrite`, `Write` (the bidirectional stream, refused before its first
 *   message) and any method the table doesn't know, is a write: in a Preview it is refused with
 *   `PreviewWriteBlockedError` and the Preview answers 409.
 *
 * Why not a gRPC interceptor: google-gax 4 drops an `interceptors` client option, and the only
 * public way in (a custom `grpc` module) loads service clients through a process-wide proto
 * cache, so an interceptor either missed instances that loaded the protos first or leaked onto
 * unhooked ones. The pool is private SDK API, so the dependency is the 7.x line, the store is
 * refused at registration when the instance doesn't have the pool it expects, and the replay of
 * `spec/data-stores/recordings/` fails when an upgrade changes how the SDK calls its client.
 *
 * Coverage: the hooked instance, and everything made from it (`collection()`, `doc()`, batches,
 * transactions, `BulkWriter`). Hook it before first use. A second `Firestore` instance, or a
 * GAPIC client made directly from `Firestore.v1`, is not covered.
 *
 * A `Db` entry's statement is the request message as JSON with every literal, document paths
 * included, replaced by `"?"`; the target is the collection. OAuth tokens and authorization
 * metadata are never read.
 */
import { classifyFirestore, currentCapture, guard, readSet, sanitizeDocument, storeLabel } from '@sendproof/core';
import type { CaptureRecorder, DataStore, DataStoreDescription } from '@sendproof/core';

/** Options for {@link firestoreStore}. */
export interface FirestoreStoreOptions {
  /** Display label for discovery, such as `orders`. Never a project id or host. */
  name?: string;
  /**
   * RPC method names the host states never write (exact, in the table's spelling, such as
   * `FutureMethod`). A wrongly listed write is not blocked.
   */
  treatAsRead?: string[];
}

/** A hooked Firestore instance, ready for `dataStores`. */
export interface FirestoreStore<Firestore> extends DataStore {
  readonly system: 'firestore';
  /** The same instance, now guarded. */
  readonly client: Firestore;
  /**
   * A guarded view of one GAPIC client, as the instance's client pool hands it to every operation.
   * Used by tests that replay recorded RPCs over a fake client.
   */
  guardClient<Client extends object>(client: Client): Client;
}

/** The part of a Firestore instance the hook reads and replaces. */
interface FirestoreInstance {
  _clientPool?: { run?(requestTag: unknown, requiresGrpc: unknown, operation: (client: object) => unknown): unknown };
  [key: PropertyKey]: unknown;
}

const hooked = Symbol.for('sendproof.firestore.hooked');
const service = '/google.firestore.v1.Firestore/';
/** GAPIC client members that are not RPCs. Anything else callable on the client is treated as an RPC. */
const notRpc = new Set(['constructor', 'initialize', 'getProjectId', 'close', 'then', 'toJSON', 'toString', 'valueOf']);

/** The RPC a GAPIC method name stands for: `commit` is `Commit`, `listDocumentsStream` is `ListDocuments`. */
function rpcOf(method: string): string {
  const name = method.replace(/(Stream|Async)$/, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The collection a Firestore request names, for `db.collection.name`. */
function collectionOf(message: unknown): string | undefined {
  const request = message as { structuredQuery?: { from?: { collectionId?: string }[] }; structuredAggregationQuery?: { structuredQuery?: { from?: { collectionId?: string }[] } };
    documents?: string[]; writes?: { update?: { name?: string }; delete?: string }[]; parent?: string } | undefined;
  const from = request?.structuredQuery?.from?.[0]?.collectionId ?? request?.structuredAggregationQuery?.structuredQuery?.from?.[0]?.collectionId;
  if (from) return from;
  const path = request?.documents?.[0] ?? request?.writes?.[0]?.update?.name ?? request?.writes?.[0]?.delete;
  return path?.split('/documents/')[1]?.split('/').at(-2);
}

/** Record one RPC on the capture that was current when it was sent. */
function record(capture: CaptureRecorder | undefined, operation: string, message: unknown, started: number, error?: unknown) {
  if (!capture) return;
  const target = collectionOf(message);
  const statement = message === undefined || message === null || typeof message !== 'object' ? undefined : JSON.stringify(sanitizeDocument(message));
  const code = (error as { code?: unknown } | undefined)?.code;
  capture.db({
    system: 'firestore', operation, ...(target === undefined ? {} : { target }), ...(statement === undefined ? {} : { statement }),
    ...(error ? { error: code === undefined ? (error as Error)?.name ?? 'Error' : String(code) } : {}),
    elapsedMs: performance.now() - started,
  });
}

/** A view of a GAPIC client whose RPC methods are classified and guarded before they call the real client. */
function guardedClient<Client extends object>(client: Client, reads: ReadonlySet<string> | undefined): Client {
  return new Proxy(client, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      if (typeof key !== 'string' || typeof member !== 'function' || notRpc.has(key)) return member;
      return function guardedRpc(...args: unknown[]) {
        // `listen` and `write` take only call options; every other RPC takes the request message first.
        const message = key === 'listen' || key === 'write' ? undefined : args[0];
        const { kind, operation } = classifyFirestore(service + rpcOf(key), message, reads);
        guard('firestore', operation, kind);
        const capture = kind === 'session' ? undefined : currentCapture();
        const started = performance.now();
        const result = (member as (...a: unknown[]) => unknown).apply(target, args);
        if (kind !== 'session' && capture) {
          if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
            (result as Promise<unknown>).then(() => record(capture, operation, message, started), error => record(capture, operation, message, started, error));
          } else {
            // A stream: its messages arrive for as long as it lives, so it is recorded when it starts.
            record(capture, operation, message, started);
          }
        }
        return result;
      };
    },
  });
}

/**
 * Hook a `Firestore` instance in place and return the store for `dataStores`, before or after it
 * has made requests. Hooking the same instance twice is refused, and so is an instance without the
 * client pool this SDK line keeps its GAPIC clients in.
 */
export function firestoreStore<Firestore extends object>(firestore: Firestore, options: FirestoreStoreOptions = {}): FirestoreStore<Firestore> {
  const name = storeLabel(options.name);
  const reads = readSet(options.treatAsRead);
  const pool = (firestore as FirestoreInstance | null | undefined)?._clientPool;
  if (!pool || typeof pool.run !== 'function') {
    throw new TypeError('firestoreStore takes a @google-cloud/firestore 7 Firestore instance; this one has no client pool to hook.');
  }
  if ((pool as unknown as Record<PropertyKey, unknown>)[hooked]) throw new TypeError('This Firestore instance is already hooked by firestoreStore.');
  const run = pool.run.bind(pool);
  pool.run = (requestTag, requiresGrpc, operation) => run(requestTag, requiresGrpc, client => operation(guardedClient(client, reads)));
  Object.defineProperty(pool, hooked, { value: true });
  const description: DataStoreDescription = { system: 'firestore', ...(name === undefined ? {} : { name }), mode: 'guard' };
  return { system: 'firestore', client: firestore, guardClient: client => guardedClient(client, reads), describe: async () => ({ ...description }) };
}

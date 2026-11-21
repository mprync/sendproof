/**
 * The per-MongoClient engine shared by `mongoStore` (driver) and `mongooseStore`:
 *
 * - **Topology**: `hello` decides the mode once. A replica set or mongos with logical sessions runs
 *   in `preview` mode; anything else in `guard` mode (spec/data-stores.md "Starting the transaction").
 * - **Session**: each `preview`-mode Preview gets one client session with a snapshot/majority
 *   transaction. The handler's own `startTransaction` and `withTransaction` join it; its
 *   `commitTransaction` and `abortTransaction` never reach the server and fail the Preview with 500.
 * - **Guard**: {@link MongoEngine.check} classifies a command before the hook sends it.
 * - **Monitoring** (the tripwire): every command the client sends is seen in the request's async
 *   context. A write during a Preview without the Preview's `lsid` fails the Preview with 500, a
 *   reply with code 263 blocks it, and every other command becomes a `Db` log entry. Candidate
 *   document ids for change capture come from the same events.
 * - **Finish**: after the handler, changes are read (inside the transaction for `after`, and at the
 *   transaction's own snapshot time for `before`), then the transaction is aborted and the session
 *   ended. A Preview that outlives `previewTimeoutMs` is aborted early and answers 500.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyMongo, currentCapture, currentPreview, guard, PreviewTransactionControlError, refuseInPreview, sanitizeDocument } from '@sendproof/core';
import type { CaptureRecorder, DataStoreDescription } from '@sendproof/core';
import type { ClientSession, MongoClient } from 'mongodb';

/** The reason a standalone server, or any reply the binding doesn't recognise, runs in `guard` mode. */
export const standaloneReason = "Preview unavailable: this MongoDB server doesn't support transactions";

/** The reason for a command MongoDB refuses inside a transaction. */
export const refusedReason = (operation: string) => `Preview unavailable: MongoDB can't run ${operation} inside a transaction`;

/** Commands the monitoring specification marks security-sensitive: never logged. */
const sensitive = new Set(['authenticate', 'saslstart', 'saslcontinue', 'getnonce', 'createuser', 'updateuser', 'copydbgetnonce', 'copydbsaslstart', 'copydb']);

/** Fields the driver adds to every command; they carry no meaning for the log and are dropped. */
const envelope = new Set(['lsid', 'txnNumber', 'autocommit', 'startTransaction', '$clusterTime', '$db', '$readPreference', 'readConcern', 'writeConcern', 'apiVersion', 'apiStrict', 'apiDeprecationErrors']);

/** Most candidate documents read back for change capture in one Preview. */
const candidateLimit = 1000;

/**
 * The default Preview time limit: below the server's 60-second `transactionLifetimeLimitSeconds`,
 * so the binding, not the server, ends a Preview whose handler runs too long.
 */
export const defaultPreviewTimeoutMs = 50_000;

/** Commands that end a transaction. In a Preview only the engine may send them. */
const endsTransaction = (name: string) => name === 'committransaction' || name === 'aborttransaction';

/** Server error codes meaning the collection or snapshot didn't exist at the start time. */
const absentAtStart = new Set([26 /* NamespaceNotFound */, 246 /* SnapshotUnavailable */]);

type Doc = Record<string, unknown>;
type Via = 'upsert' | 'replace';

/** One document a Preview may have changed, and how. */
interface Candidate { namespace: string; collection: string; id: unknown; via?: Via }

/** A filter whose matches, before and inside the transaction, are change candidates. */
interface Filter { namespace: string; collection: string; filter: Doc; via?: Via }

/** The state of one `preview`-mode Preview. */
export interface PreviewState {
  readonly session: ClientSession;
  readonly lsid: string;
  /** Set once a command carried the session to the server. */
  used: boolean;
  finished: boolean;
  candidates: Map<string, Candidate>;
  filters: Filter[];
  /**
   * The transaction's snapshot time: the `operationTime` of the first reply to a command the
   * Preview session sent. `before` images are read at this time, so a concurrent commit by
   * another request never shows up as a Preview change.
   */
  startTime?: unknown;
  /** Aborts the transaction when the Preview outlives its time limit. */
  timer?: ReturnType<typeof setTimeout>;
}

/** A command seen by monitoring, kept until its reply arrives. */
interface Pending { capture: CaptureRecorder | undefined; preview: CaptureRecorder | undefined; name: string; namespace: string; target?: string; statement?: string; started: number; command: Doc }

/** Hex of a session id (`lsid.id`, a BSON UUID), comparable across driver versions. */
function sessionHex(lsid: unknown): string | undefined {
  const id = (lsid as { id?: { buffer?: Uint8Array; toString?(encoding: string): string } } | undefined)?.id;
  if (!id) return undefined;
  if (id.buffer instanceof Uint8Array) return Buffer.from(id.buffer).toString('hex');
  return typeof id.toString === 'function' ? id.toString('hex') : undefined;
}

const isPlain = (value: unknown): value is Doc => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Convert a BSON document to plain JSON, using MongoDB Extended JSON v2 relaxed form for the types
 * JSON lacks (`{"$oid": …}`, `{"$date": …}`). Works with any `bson` version, so documents from
 * Mongoose's own driver copy convert the same way.
 */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? { $numberLong: String(value.getTime()) } : value.toISOString() };
  if (value instanceof RegExp) return { $regularExpression: { pattern: value.source, options: value.flags } };
  if (Buffer.isBuffer(value)) return { $binary: { base64: value.toString('base64'), subType: '00' } };
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  const bson = value as { _bsontype?: string; toHexString?(): string; toString(): string; buffer?: Uint8Array; sub_type?: number; toNumber?(): number; valueOf?(): unknown; t?: number; i?: number; high?: number; low?: number };
  switch (bson._bsontype) {
    case 'ObjectId': case 'ObjectID': return { $oid: bson.toHexString!() };
    case 'Decimal128': return { $numberDecimal: bson.toString() };
    case 'Long': case 'Int32': case 'Double': return Number(bson.valueOf!());
    case 'Timestamp': return { $timestamp: { t: bson.high ?? bson.t, i: bson.low ?? bson.i } };
    case 'Binary': case 'UUID': return { $binary: { base64: Buffer.from(bson.buffer ?? []).toString('base64'), subType: (bson.sub_type ?? 0).toString(16).padStart(2, '0') } };
    case 'MinKey': return { $minKey: 1 };
    case 'MaxKey': return { $maxKey: 1 };
    case 'BSONRegExp': case 'BSONSymbol': case 'Code': return bson.toString();
  }
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, plain(inner)]));
  // A Mongoose document or another class with a JSON form.
  const json = (value as { toJSON?(): unknown }).toJSON;
  return typeof json === 'function' ? plain(json.call(value)) : String(value);
}

/** Whether an update document replaces the whole document rather than applying operators. */
const replaces = (update: unknown) => isPlain(update) && Object.keys(update).length > 0 && !Object.keys(update)[0]!.startsWith('$');

export interface EngineOptions {
  reads: ReadonlySet<string> | undefined;
  /** Abort a Preview's transaction, and fail the Preview with 500, after this many milliseconds. */
  previewTimeoutMs?: number;
}

/** One engine per hooked MongoClient. */
export class MongoEngine {
  readonly client: MongoClient;
  readonly #reads: ReadonlySet<string> | undefined;
  readonly #timeoutMs: number;
  /**
   * The mode each Preview began in. A Preview keeps the mode it began with even if detection
   * later changes {@link mode}, so a Preview that began without a session never has its writes
   * treated as joining a transaction.
   */
  readonly #modes = new WeakMap<CaptureRecorder, 'preview' | 'guard'>();
  readonly #states = new WeakMap<CaptureRecorder, PreviewState>();
  readonly #pending = new Map<number | string, Pending>();
  /** Set while the engine itself talks to the server, so monitoring ignores those commands. */
  readonly #internal = new AsyncLocalStorage<true>();
  #detected?: Promise<Pick<DataStoreDescription, 'mode' | 'reason'>>;
  /** The detected mode; known before any Preview runs, because `begin` awaits detection. */
  mode?: 'preview' | 'guard';

  constructor(client: MongoClient, options: EngineOptions) {
    this.client = client;
    this.#reads = options.reads;
    this.#timeoutMs = options.previewTimeoutMs ?? defaultPreviewTimeoutMs;
    const raw = client as unknown as { options?: { monitorCommands?: boolean }; topology?: unknown; monitorCommands: boolean };
    if (!raw.options?.monitorCommands) {
      // Connections copy the setting when they open, so it can only be turned on before connecting.
      if (raw.topology) {
        throw new TypeError('Create the MongoClient with { monitorCommands: true }, or hook it before it connects: the Preview tripwire needs command monitoring.');
      }
      raw.monitorCommands = true;
    }
    client.on('commandStarted', event => this.#started(event as unknown as MonitorEvent));
    client.on('commandSucceeded', event => this.#succeeded(event as unknown as MonitorEvent));
    client.on('commandFailed', event => this.#failed(event as unknown as MonitorEvent));
  }

  /** Run engine-internal commands (topology, change capture, abort) without logging or tripping. */
  internal<T>(work: () => Promise<T>): Promise<T> {
    return this.#internal.run(true, work);
  }

  /** Detect the topology once: `preview` on a replica set or mongos with logical sessions. */
  detect(): Promise<Pick<DataStoreDescription, 'mode' | 'reason'>> {
    this.#detected ??= this.internal(async () => {
      const hello = await this.client.db('admin').command({ hello: 1 }) as Doc;
      const transactions = Boolean((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null);
      this.mode = transactions ? 'preview' : 'guard';
      return transactions ? { mode: 'preview' as const } : { mode: 'guard' as const, reason: standaloneReason };
    }).catch(() => {
      // Unreachable or unrecognised: guard mode for now, and ask again next time.
      this.#detected = undefined;
      this.mode ??= 'guard';
      return { mode: 'guard' as const, reason: standaloneReason };
    });
    return this.#detected;
  }

  /** The current Preview's state, when this code runs in a `preview`-mode Preview that began. */
  state(capture = currentPreview()): PreviewState | undefined {
    return capture ? this.#states.get(capture) : undefined;
  }

  /**
   * Prepare a Preview: detect the mode and, in `preview` mode, start the Preview's session and
   * transaction. The session's own transaction methods are replaced so the handler joins the
   * Preview transaction instead of ending it.
   */
  async begin(capture: CaptureRecorder): Promise<PreviewState | undefined> {
    const existing = this.#states.get(capture);
    if (existing || this.#modes.has(capture)) return existing;
    const { mode } = await this.detect();
    if (capture.mode !== 'preview') return undefined;
    this.#modes.set(capture, mode);
    if (mode !== 'preview') return undefined;
    const session = this.client.startSession();
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    const lsid = sessionHex(session.id);
    if (!lsid) throw new Error('The MongoDB driver did not expose the Preview session id.');
    const refuse = (what: string) => new PreviewTransactionControlError(`Preview owns the MongoDB transaction, so the handler's ${what} cannot run during Preview.`);
    const join = {
      startTransaction() { /* Already inside the Preview transaction. */ },
      async withTransaction<T>(callback: (session: ClientSession) => Promise<T>) { return callback(session); },
      async commitTransaction() { const error = refuse('commitTransaction'); capture.refuse(error); throw error; },
      async abortTransaction() { const error = refuse('abortTransaction'); capture.refuse(error); throw error; },
      async endSession() { /* The Preview ends its session after the handler. */ },
    };
    for (const [name, method] of Object.entries(join)) Object.defineProperty(session, name, { value: method, configurable: true, writable: true });
    const state: PreviewState = { session, lsid, used: false, finished: false, candidates: new Map(), filters: [] };
    this.#states.set(capture, state);
    // A handler still running at the limit loses its transaction: later commands fail, nothing
    // commits, and the Preview answers 500 when it ends.
    state.timer = setTimeout(() => {
      capture.refuse(new PreviewTransactionControlError(`The Preview ran longer than ${this.#timeoutMs} ms, so its MongoDB transaction was aborted.`));
      void this.#end(state).catch(() => {});
    }, this.#timeoutMs);
    state.timer.unref?.();
    return state;
  }

  /** The mode the current Preview began in; `guard` for a Preview that never began on this store. */
  #modeOf(capture: CaptureRecorder): 'preview' | 'guard' {
    return this.#modes.get(capture) ?? 'guard';
  }

  /**
   * Classify a command before it is sent and let the guard refuse it. In `guard` mode every write
   * blocks; in `preview` mode only what MongoDB can't run inside a transaction does. `database`
   * on the admin, config or local database runs outside the transaction, so its writes block too.
   */
  check(command: Doc, operation = Object.keys(command)[0] ?? 'command', database?: string): void {
    const capture = currentPreview();
    if (!capture) return;
    if (endsTransaction(operation.toLowerCase())) {
      throw refuseInPreview(`Preview owns the MongoDB transaction, so the handler's ${operation} cannot run during Preview.`)!;
    }
    const { kind, refusedInTransaction } = classifyMongo(command, this.#reads);
    if (this.#modeOf(capture) === 'preview' && !systemDatabase(database)) {
      if (refusedInTransaction) guard('mongodb', operation, 'write', refusedReason(refusedInTransaction));
      return;
    }
    guard('mongodb', operation, kind);
  }

  // ---- Monitoring ----

  #started(event: MonitorEvent) {
    if (this.#internal.getStore()) return;
    const command = event.command ?? {};
    const name = event.commandName;
    const lower = name.toLowerCase();
    const { kind } = classifyMongo(command, this.#reads);
    const preview = currentPreview();
    if (preview && endsTransaction(lower)) {
      // Sent around the hook, for example through Mongoose's connection.db: it may have committed
      // the Preview transaction, so the Preview can never be confirmed.
      preview.refuse(new PreviewTransactionControlError(`A MongoDB ${name} reached the server during a Preview; the Preview can't be confirmed.`));
    } else if (preview && kind === 'write') this.#watchWrite(preview, command, event.databaseName, lower);
    if (kind === 'session' || sensitive.has(lower)) return;
    const target = typeof command[name] === 'string' ? command[name] as string : undefined;
    const body = Object.fromEntries(Object.entries(command).filter(([field]) => !envelope.has(field)));
    this.#pending.set(event.requestId, {
      capture: currentCapture(), preview, name, namespace: event.databaseName,
      ...(target === undefined ? {} : { target }), statement: JSON.stringify(sanitizeDocument(body)), started: performance.now(), command,
    });
  }

  /** A write seen during a Preview: collect change candidates, or trip if it escaped the session. */
  #watchWrite(preview: CaptureRecorder, command: Doc, namespace: string, name: string) {
    const state = this.#states.get(preview);
    const lsid = sessionHex(command.lsid);
    // Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
    if (!state || state.finished || lsid !== state.lsid || command.autocommit !== false) {
      // The hook couldn't stop it and nothing can undo it: never claim a rollback.
      preview.refuse(new PreviewTransactionControlError(`A MongoDB ${name} escaped the Preview session; the Preview can't be confirmed.`));
      return;
    }
    state.used = true;
    const collection = typeof command[Object.keys(command)[0]!] === 'string' ? command[Object.keys(command)[0]!] as string : '';
    if (name === 'insert' && Array.isArray(command.documents)) {
      for (const document of command.documents as Doc[]) this.#candidate(state, { namespace, collection, id: document?._id });
    } else if (name === 'update' && Array.isArray(command.updates)) {
      for (const update of command.updates as Doc[]) {
        const via: Via | undefined = update.upsert ? 'upsert' : replaces(update.u) ? 'replace' : undefined;
        state.filters.push({ namespace, collection, filter: (update.q as Doc) ?? {}, ...(via ? { via } : {}) });
      }
    } else if (name === 'delete' && Array.isArray(command.deletes)) {
      for (const remove of command.deletes as Doc[]) state.filters.push({ namespace, collection, filter: (remove.q as Doc) ?? {} });
    } else if (name === 'findandmodify') {
      const via: Via | undefined = command.upsert ? 'upsert' : replaces(command.update) ? 'replace' : undefined;
      state.filters.push({ namespace, collection, filter: (command.query as Doc) ?? {}, ...(via ? { via } : {}) });
    } else if (name === 'bulkwrite' && Array.isArray(command.ops) && Array.isArray(command.nsInfo)) {
      // The client-level bulkWrite command: each op names its namespace by index.
      const namespaces = (command.nsInfo as { ns: string }[]).map(info => info.ns.split(/\.(.*)/s));
      for (const op of command.ops as Doc[]) {
        const index = (op.insert ?? op.update ?? op.delete) as number;
        const [database = namespace, target = ''] = namespaces[index] ?? [];
        if (op.document) this.#candidate(state, { namespace: database, collection: target, id: (op.document as Doc)._id });
        else state.filters.push({ namespace: database, collection: target, filter: (op.filter as Doc) ?? {}, ...(op.upsert ? { via: 'upsert' as const } : {}) });
      }
    }
  }

  #candidate(state: PreviewState, candidate: Candidate) {
    if (candidate.id === undefined) return;
    const key = `${candidate.namespace}\u0000${candidate.collection}\u0000${JSON.stringify(plain(candidate.id))}`;
    const known = state.candidates.get(key);
    if (!known || (!known.via && candidate.via)) state.candidates.set(key, candidate);
  }

  #succeeded(event: MonitorEvent) {
    const pending = this.#take(event);
    if (!pending) return;
    const reply = (event.reply ?? {}) as Doc;
    const state = pending.preview ? this.#states.get(pending.preview) : undefined;
    // The first reply in the transaction carries its snapshot time (the read timestamp).
    if (state && state.startTime === undefined && reply.operationTime !== undefined && sessionHex(pending.command.lsid) === state.lsid) {
      state.startTime = reply.operationTime;
    }
    if (state && pending.target) {
      // Upserted ids appear only in the reply.
      for (const upsert of (reply.upserted as Doc[] | undefined) ?? []) this.#candidate(state, { namespace: pending.namespace, collection: pending.target, id: upsert._id, via: 'upsert' });
      const value = reply.value as Doc | undefined;
      if (pending.name.toLowerCase() === 'findandmodify' && value?._id !== undefined) this.#candidate(state, { namespace: pending.namespace, collection: pending.target, id: value._id });
      const upserted = (reply.lastErrorObject as Doc | undefined)?.upserted;
      if (upserted !== undefined) this.#candidate(state, { namespace: pending.namespace, collection: pending.target, id: upserted, via: 'upsert' });
    }
    const cursor = reply.cursor as { firstBatch?: unknown[]; nextBatch?: unknown[] } | undefined;
    const rows = cursor ? (cursor.firstBatch ?? cursor.nextBatch ?? []).length : typeof reply.n === 'number' ? reply.n : undefined;
    this.#log(pending, event.duration, rows);
  }

  #failed(event: MonitorEvent) {
    const pending = this.#take(event);
    if (!pending) return;
    const failure = event.failure as { code?: number; codeName?: string; name?: string } | undefined;
    // The server refused something a transaction can't do and applied nothing: a block, not a crash.
    if (pending.preview && this.#states.has(pending.preview) && failure?.code === 263) {
      pending.preview.block({ store: 'mongodb', operation: pending.name, detail: refusedReason(pending.name) });
    }
    this.#log(pending, event.duration, undefined, failure?.codeName ?? failure?.name ?? 'Error');
  }

  #take(event: MonitorEvent): Pending | undefined {
    const pending = this.#pending.get(event.requestId);
    if (pending) this.#pending.delete(event.requestId);
    return pending;
  }

  #log(pending: Pending, duration: number | undefined, rowsAffected?: number, error?: string) {
    pending.capture?.db({
      system: 'mongodb', operation: pending.name, namespace: pending.namespace,
      ...(pending.target === undefined ? {} : { target: pending.target }),
      ...(pending.statement === undefined ? {} : { statement: pending.statement }),
      ...(rowsAffected === undefined ? {} : { rowsAffected }), ...(error ? { error } : {}),
      elapsedMs: duration ?? performance.now() - pending.started,
    });
  }

  // ---- Finish ----

  /**
   * After the handler: capture document changes, then abort the transaction and end the session.
   * A capture read that fails for any reason but an already-aborted transaction rejects, after the
   * abort, so the Preview answers 500. Nothing the Preview wrote is ever committed: no
   * `commitTransaction` is ever sent for the Preview session.
   */
  async finish(capture: CaptureRecorder): Promise<void> {
    const state = this.#states.get(capture);
    if (!state || state.finished) return;
    let failure: unknown;
    try {
      if (state.used) await this.internal(() => this.#capture(capture, state));
    } catch (error) {
      // A failed command inside a transaction makes the server abort it: nothing to capture.
      if ((error as { codeName?: string }).codeName !== 'NoSuchTransaction') failure = error;
    } finally {
      await this.#end(state);
    }
    if (failure) throw failure;
  }

  /**
   * Abort the Preview transaction and end its session, once. The driver ignores abort errors, as
   * the transactions specification requires; an unacknowledged abort still commits nothing,
   * because no `commitTransaction` is ever sent for the Preview session.
   */
  async #end(state: PreviewState): Promise<void> {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.timer);
    const prototype = Object.getPrototypeOf(state.session) as ClientSession;
    await this.internal(async () => {
      if (state.session.inTransaction()) await prototype.abortTransaction.call(state.session).catch(() => {});
      await prototype.endSession.call(state.session).catch(() => {});
    });
  }

  /**
   * Find documents as they were when the Preview transaction started: a snapshot read at its
   * start time, outside the transaction. The driver drops `atClusterTime` from read concern
   * options, so the read is a raw `find` command. Without a start time (no reply carried one),
   * it reads the majority-committed view, which the spec allows: nothing the Preview wrote is
   * committed, so the only difference is a concurrent commit by another request.
   */
  async #atStart(state: PreviewState, namespace: string, collection: string, filter: Doc, projection?: Doc): Promise<Doc[]> {
    const readConcern = state.startTime === undefined ? { level: 'majority' } : { level: 'snapshot', atClusterTime: state.startTime };
    try {
      const reply = await this.client.db(namespace).command({
        find: collection, filter, ...(projection ? { projection } : {}), batchSize: candidateLimit, limit: candidateLimit, singleBatch: true, readConcern,
      }) as { cursor?: { firstBatch?: Doc[] } };
      return reply.cursor?.firstBatch ?? [];
    } catch (error) {
      // The collection was created after the start time: nothing in it existed then.
      if (absentAtStart.has((error as { code?: number }).code ?? 0)) return [];
      throw error;
    }
  }

  /** Compare each candidate's start-time and in-transaction versions and record the differences. */
  async #capture(capture: CaptureRecorder, state: PreviewState) {
    const { session } = state;
    for (const { namespace, collection, filter, via } of state.filters) {
      const target = this.client.db(namespace).collection(collection);
      const projection = { _id: 1 };
      for (const document of [...await target.find(filter, { projection, session }).toArray(), ...await this.#atStart(state, namespace, collection, filter, projection)]) {
        this.#candidate(state, { namespace, collection, id: document._id, ...(via ? { via } : {}) });
        if (state.candidates.size >= candidateLimit) break;
      }
    }
    let read = 0;
    for (const { namespace, collection, id, via } of state.candidates.values()) {
      if (read++ >= candidateLimit) { capture.truncate('changes'); break; }
      const target = this.client.db(namespace).collection(collection);
      const [before = null] = await this.#atStart(state, namespace, collection, { _id: id });
      const after = await target.findOne({ _id: id as never }, { session });
      const [was, now] = [before === null ? null : plain(before) as Doc, after === null ? null : plain(after) as Doc];
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      const operation = was === null ? 'insert' : now === null ? 'delete' : 'update';
      capture.change({
        operation, store: 'mongodb', namespace, table: collection, key: { _id: plain(id) }, before: was, after: now,
        ...(via && operation !== 'delete' ? { via } : {}),
      });
    }
  }
}

/** Commands on these databases can't join a transaction. */
export const systemDatabase = (name: string | undefined) => name === 'admin' || name === 'config' || name === 'local';

/** The fields of a driver command-monitoring event the engine reads. */
interface MonitorEvent {
  requestId: number;
  commandName: string;
  databaseName: string;
  command?: Doc;
  reply?: unknown;
  failure?: unknown;
  duration?: number;
}

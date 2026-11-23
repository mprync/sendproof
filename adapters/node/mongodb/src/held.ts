import { AsyncLocalStorage } from 'node:async_hooks';
import { currentPreview, guard, PreviewSessionEndedError, PreviewTransactionControlError } from '@sendproof/core';
import type { CaptureRecorder, HeldPreview } from '@sendproof/core';
import { BSON } from 'mongodb';
import type { ClientSession, Collection, Document, MongoClient } from 'mongodb';
import { plain } from './engine.js';

const documentLimit = 1_000;
const imageBytesLimit = 16 * 1024 * 1024;
const sessionBytesLimit = 64 * 1024 * 1024;
const endedReason = "MongoDB ended the Preview session's transaction.";
const unsafeReason = "The MongoDB Preview session's transaction can't be verified or rewound.";

type Target = { database: string; collection: string };
type Image = { document: Document; bytes: Uint8Array };
type ImageSet = Map<string, Image>;
type Snapshot = { target: Target; before: ImageSet };
type Undo = { target: Target; removed: Image[]; restored: Image[] };
type Step = {
  number: number;
  snapshots: Map<string, Snapshot>;
  undo: Undo[];
  documents: number;
  bytes: number;
};

const targetKey = ({ database, collection }: Target) => `${database}\0${collection}`;
const documentKey = (document: Document) => Buffer.from(BSON.serialize({ _id: document._id })).toString('base64');
const exactId = (document: Document) => ({ _id: { $eq: document._id } });

const writeOptions: Record<string, number> = {
  insertOne: 1, insertMany: 1, bulkWrite: 1,
  updateOne: 2, updateMany: 2, replaceOne: 2,
  deleteOne: 1, deleteMany: 1,
  findOneAndUpdate: 2, findOneAndReplace: 2, findOneAndDelete: 1,
};

const leases = new WeakMap<ClientSession, MongoHeldPreview>();
const hooked = new WeakSet<object>();
const nativeWrite = new AsyncLocalStorage<Collection>();

/** Observe the native operations both the guarded driver and Mongoose eventually call. */
function hookCollection(client: MongoClient): void {
  const prototype = Object.getPrototypeOf(client.db().collection('sendproof_preview')) as Record<string, unknown>;
  if (hooked.has(prototype)) return;
  for (const [method, options] of Object.entries(writeOptions)) {
    const original = prototype[method] as (this: Collection, ...args: unknown[]) => Promise<unknown>;
    prototype[method] = function write(this: Collection, ...args: unknown[]) {
      const session = (args[options] as { session?: ClientSession } | undefined)?.session;
      const lease = session && leases.get(session);
      const dispatch = () => original.apply(this, args);
      return lease ? lease.write(this, method, dispatch) : dispatch();
    };
  }
  hooked.add(prototype);
}

/** A MongoDB transaction has no savepoints. Record exact BSON images before allowing writes. */
export class MongoHeldPreview implements HeldPreview {
  readonly #steps = new Map<number, Step>();
  #next?: Step;
  #capture?: CaptureRecorder;
  #writes = Promise.resolve();
  #pendingWrites = 0;
  #running = false;
  #settled = false;
  #closed = false;
  #unsafe = false;
  #expired = false;
  #commandFailed = false;
  #lastReadTarget?: Target;
  #transaction?: string;
  #historyBytes = 0;

  constructor(
    readonly client: MongoClient,
    readonly session: ClientSession,
    readonly internal: <T>(work: () => Promise<T>) => Promise<T>,
    readonly isInternal: () => boolean,
    readonly join: (capture: CaptureRecorder) => void,
    readonly assertMonitoring: () => void,
    readonly dispatchInSession: <T>(session: ClientSession, dispatch: () => Promise<T>) => Promise<T>,
    readonly end: () => Promise<boolean>,
  ) {
    hookCollection(client);
    leases.set(session, this);
  }

  async checkpoint(step: number): Promise<void> {
    this.#assertUsable();
    this.assertMonitoring();
    if (this.#running || this.#steps.has(step)) throw new Error('The MongoDB Preview step is already open.');
    this.#next = { number: step, snapshots: new Map(), undo: [], documents: 0, bytes: 0 };
    this.#steps.set(step, this.#next);
    this.#settled = false;
  }

  async run<T>(capture: CaptureRecorder, dispatch: () => Promise<T>): Promise<T> {
    const step = this.#next;
    if (!step || this.#running || this.#settled) throw new Error('The MongoDB Preview step has no checkpoint.');
    this.#assertUsable();
    this.#running = true;
    this.#capture = capture;
    this.join(capture);
    try {
      return await this.dispatchInSession(this.session, dispatch);
    } finally {
      this.#capture = undefined;
      if (this.#pendingWrites) this.#unsafe = true;
      await this.#writes;
      try {
        this.#assertUsable();
        await this.internal(() => this.#collect(step, capture));
        this.#settled = true;
      } catch (error) {
        this.#noteError(error);
        this.#unsafe = true;
        this.#assertUsable();
        throw error;
      } finally {
        this.#running = false;
      }
    }
  }

  async verify(step: number): Promise<void> {
    if (this.#next?.number !== step || !this.#settled) this.#unsafe = true;
    await this.#probe();
  }

  async rewind(step: number): Promise<void> {
    await this.#probe();
    await this.internal(async () => {
      try {
        for (const [number, checkpoint] of [...this.#steps].reverse()) {
          if (number < step) break;
          for (const { target, removed, restored } of checkpoint.undo) {
            const collection = this.#collection(target);
            // Delete changed current images first so restored images can reclaim unique index keys.
            for (const { document } of removed) await collection.deleteOne(exactId(document), { session: this.session, collation: { locale: 'simple' } });
            if (restored.length) await collection.insertMany(restored.map(image => image.document), { session: this.session });
          }
          this.#historyBytes -= checkpoint.bytes;
          this.#steps.delete(number);
        }
        this.#next = undefined;
      } catch (error) {
        this.#noteError(error);
        this.#unsafe = true;
        this.#assertUsable();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#steps.clear();
    this.#next = undefined;
    if (!await this.end()) throw new Error("MongoDB didn't acknowledge the Preview session's abort.");
  }

  accepting(capture: CaptureRecorder | undefined): boolean {
    return capture !== undefined && this.#capture === capture && !this.#closed && !this.#unsafe && !this.#expired;
  }

  write<T>(collection: Collection, operation: string, dispatch: () => Promise<T>): Promise<T> {
    if (this.isInternal() || nativeWrite.getStore() === collection) return dispatch();
    const capture = currentPreview();
    const step = this.#next;
    const target = { database: collection.dbName, collection: collection.collectionName };
    this.#pendingWrites++;
    const write = this.#writes.then(async () => {
      if (!step || !this.accepting(capture)) throw new PreviewTransactionControlError(unsafeReason);
      this.assertMonitoring();
      const key = targetKey(target);
      if (!step.snapshots.has(key)) {
        const before = await this.internal(async () => {
          // An implicitly created collection would also need to be undone. Require an existing one.
          const exists = await this.client.db(target.database).listCollections({ name: target.collection }, { nameOnly: true, authorizedCollections: true }).hasNext();
          if (!exists) return undefined;
          return this.#read(target, documentLimit - step.documents, Math.min(imageBytesLimit - step.bytes, sessionBytesLimit - this.#historyBytes - step.bytes));
        }).catch(error => {
          this.#noteError(error);
          throw error;
        });
        if (!before) guard('mongodb', operation, 'write', 'Preview unavailable: MongoDB could not capture bounded before images for this collection');
        if (before) {
          step.snapshots.set(key, { target, before: before.images });
          step.documents += before.images.size;
          step.bytes += before.bytes;
        }
      }
      if (!this.accepting(capture)) throw new PreviewTransactionControlError(unsafeReason);
      return nativeWrite.run(collection, dispatch);
    }).finally(() => { this.#pendingWrites--; });
    this.#writes = write.then(() => {}, () => {});
    return write;
  }

  /** Inspect the actual wire session so a bypass cannot be mistaken for a rewindable write. */
  command(command: Document, database: string, name: string, collection?: string): void {
    if (command.autocommit !== false || command.txnNumber === undefined) {
      this.#unsafe = true;
      return;
    }
    const transaction = String(command.txnNumber);
    if (this.#transaction !== undefined && (this.#transaction !== transaction || command.startTransaction === true)) this.#unsafe = true;
    this.#transaction = transaction;
    if (name === 'find' && collection) this.#lastReadTarget = { database, collection };
  }

  watchWrite(capture: CaptureRecorder, database: string, collection: string, name: string, joined: boolean): void {
    const writer = nativeWrite.getStore();
    if (joined && this.accepting(capture) && ['insert', 'update', 'delete', 'findandmodify'].includes(name)
      && writer?.dbName === database && writer.collectionName === collection
      && this.#next?.snapshots.has(targetKey({ database, collection }))) return;
    this.#unsafe = true;
    capture.refuse(new PreviewTransactionControlError(`A MongoDB ${name} ran without a rewindable before image.`));
  }

  fault(error?: unknown): void {
    if (error === undefined) this.#unsafe = true;
    else this.#noteError(error);
  }

  #noteError(error: unknown): void {
    const { code, codeName } = (error ?? {}) as { code?: number; codeName?: string };
    // MongoDB also returns NoSuchTransaction after a command error aborted the transaction.
    if (!this.#unsafe && (codeName === 'TransactionExceededLifetimeLimitSeconds' || (code === 251 && !this.#commandFailed))) this.#expired = true;
    else this.#commandFailed = true;
  }

  #assertUsable(): void {
    if (this.#expired) throw new PreviewSessionEndedError(endedReason);
    if (this.#unsafe || this.#closed || !this.session.inTransaction() || this.session.hasEnded) throw new PreviewTransactionControlError(unsafeReason);
  }

  async #probe(): Promise<void> {
    this.#assertUsable();
    this.assertMonitoring();
    const target = this.#lastReadTarget ?? { database: this.client.db().databaseName, collection: 'sendproof_preview' };
    try {
      if (this.#transaction !== undefined) {
        await this.internal(() => this.#collection(target).findOne({}, { session: this.session, projection: { _id: 1 } }));
        this.#commandFailed = false;
      }
    } catch (error) {
      this.#noteError(error);
      this.#unsafe = true;
      this.#assertUsable();
      throw error;
    }
    this.#assertUsable();
  }

  #collection({ database, collection }: Target): Collection {
    return this.client.db(database).collection(collection);
  }

  async #read(target: Target, maxDocuments: number, maxBytes: number): Promise<{ images: ImageSet; bytes: number } | undefined> {
    const images: ImageSet = new Map();
    let bytes = 0;
    const cursor = this.#collection(target).find<Uint8Array>({}, { session: this.session, raw: true, limit: maxDocuments + 1, batchSize: 32 });
    try {
      for await (const encoded of cursor) {
        bytes += encoded.byteLength;
        if (images.size >= maxDocuments || bytes > maxBytes) return undefined;
        const document = BSON.deserialize(encoded, { promoteValues: false, bsonRegExp: true });
        // Legacy BSON values can decode to a JavaScript value that would serialize differently.
        if (Buffer.compare(encoded, BSON.serialize(document)) !== 0) return undefined;
        const key = documentKey(document);
        // Every undo image must identify exactly one document.
        if (images.has(key)) return undefined;
        images.set(key, { document, bytes: encoded });
      }
      return { images, bytes };
    } finally {
      await cursor.close();
    }
  }

  async #collect(step: Step, capture: CaptureRecorder): Promise<void> {
    const snapshots = [...step.snapshots.values()];
    const byteLimit = Math.min(imageBytesLimit, sessionBytesLimit - this.#historyBytes);
    let imagesAfter = 0;
    let bytesAfter = 0;
    for (const { target, before } of snapshots) {
      const after = await this.#read(target, documentLimit - imagesAfter, byteLimit - bytesAfter);
      if (!after) throw new PreviewTransactionControlError('The MongoDB Preview step exceeded the after-image limit.');
      imagesAfter += after.images.size;
      bytesAfter += after.bytes;
      const removed: Image[] = [];
      const restored: Image[] = [];
      for (const key of new Set([...before.keys(), ...after.images.keys()])) {
        const was = before.get(key);
        const now = after.images.get(key);
        if (was && now && Buffer.compare(was.bytes, now.bytes) === 0) continue;
        if (was) restored.push(was);
        if (now) removed.push(now);
        capture.change({
          operation: !was ? 'insert' : !now ? 'delete' : 'update', store: 'mongodb', namespace: target.database, table: target.collection,
          key: { _id: plain((now ?? was)!.document._id) }, before: was ? plain(was.document) as Document : null, after: now ? plain(now.document) as Document : null,
        });
      }
      if (removed.length || restored.length) step.undo.push({ target, removed, restored });
    }
    step.snapshots.clear();
    step.bytes = step.undo.reduce((total, { removed, restored }) => total + [...removed, ...restored].reduce((bytes, image) => bytes + image.bytes.byteLength, 0), 0);
    if (this.#historyBytes + step.bytes > sessionBytesLimit) throw new PreviewTransactionControlError('The MongoDB Preview session exceeded the undo image limit.');
    this.#historyBytes += step.bytes;
  }
}

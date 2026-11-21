/**
 * Mongoose 8 support. Mongoose reads an ambient session from its `transactionAsyncLocalStorage`
 * for queries, `save()`, `Model.create`, `insertMany`, `bulkWrite` and aggregations, so a Preview
 * runs its dispatch inside that storage with the Preview session: those operations join the
 * Preview transaction with no change to application code.
 *
 * A global plugin adds `pre` middleware that guards each operation before it is sent: in `guard`
 * mode it blocks writes, in `preview` mode what a transaction can't run, and in both it refuses an
 * explicit session other than the Preview's. The plugin reaches only models compiled after
 * `mongooseStore` is called, so registration refuses a Mongoose instance that already has models.
 *
 * Calls that bypass Mongoose's middleware (`Model.collection.*`, `connection.db.*`) are not
 * guarded before sending; command monitoring then fails such a write's Preview with 500.
 */
import { refuseInPreview } from '@sendproof/core';
import type { ClientSession, MongoClient } from 'mongodb';
import { refuseEnded } from './driver.js';
import type { MongoEngine } from './engine.js';

/** The parts of a Mongoose instance the store uses. */
export interface MongooseLike {
  set(option: 'transactionAsyncLocalStorage', value: boolean): unknown;
  plugin(plugin: (schema: SchemaLike) => void): unknown;
  modelNames(): string[];
  connection: ConnectionLike;
  transactionAsyncLocalStorage?: { run<T>(store: { session: ClientSession }, callback: () => T): T };
}

interface ConnectionLike {
  getClient(): MongoClient | null | undefined;
  startSession(...args: unknown[]): Promise<ClientSession>;
  withSession?<T>(executor: (session: ClientSession) => Promise<T>): Promise<T>;
  name?: string;
}

interface SchemaLike {
  pre(names: string | string[], options: { document: boolean; query: boolean }, callback: (this: never) => void): unknown;
  pre(names: string | string[], callback: (this: never) => void): unknown;
}

/** The query operations Mongoose runs middleware for, and the command each sends. */
const queryCommands: Record<string, string> = {
  find: 'find', findOne: 'find', countDocuments: 'aggregate', estimatedDocumentCount: 'count', distinct: 'distinct',
  deleteOne: 'delete', deleteMany: 'delete', updateOne: 'update', updateMany: 'update', replaceOne: 'update',
  findOneAndDelete: 'findAndModify', findOneAndReplace: 'findAndModify', findOneAndUpdate: 'findAndModify',
};

interface QueryThis { op?: string; model?: { collection?: { collectionName?: string } }; mongooseCollection?: { collectionName?: string }; getOptions(): { session?: unknown } }
interface DocumentThis { isNew?: boolean; collection?: { collectionName?: string }; $session(): unknown }
interface AggregateThis { pipeline(): unknown[]; model(): { collection?: { collectionName?: string } }; options?: { session?: unknown } }
interface ModelThis { collection?: { collectionName?: string } }

/** Install the session plumbing and the guard plugin. Returns the dispatch wrapper for Previews. */
export function hookMongoose(mongoose: MongooseLike, engine: MongoEngine, database: () => string | undefined) {
  if (mongoose.modelNames().length) {
    throw new TypeError('Call mongooseStore before defining models: its guard plugin only reaches models compiled afterwards.');
  }
  mongoose.set('transactionAsyncLocalStorage', true);

  /** Refuse an explicit session other than the Preview's, then classify the command. */
  const check = (command: Record<string, unknown>, session: unknown) => {
    // A Preview that has ended refuses every further operation, so a late write can't run outside its transaction.
    refuseEnded(engine);
    const state = engine.state();
    if (state && session && session !== state.session) {
      throw refuseInPreview('A Mongoose operation passed its own session during a Preview; the Preview session must carry every command.')!;
    }
    engine.check(command, Object.keys(command)[0], database());
  };

  mongoose.plugin(schema => {
    schema.pre(Object.keys(queryCommands), { document: false, query: true }, function guardQuery(this: never) {
      const query = this as unknown as QueryThis;
      const name = query.mongooseCollection?.collectionName ?? query.model?.collection?.collectionName ?? '';
      check({ [queryCommands[query.op ?? ''] ?? query.op ?? 'command']: name }, query.getOptions().session);
    });
    schema.pre('save', function guardSave(this: never) {
      const document = this as unknown as DocumentThis;
      check({ [document.isNew ? 'insert' : 'update']: document.collection?.collectionName ?? '' }, document.$session());
    });
    schema.pre(['deleteOne', 'updateOne'], { document: true, query: false }, function guardDocument(this: never) {
      const document = this as unknown as DocumentThis;
      check({ update: document.collection?.collectionName ?? '' }, document.$session());
    });
    schema.pre('aggregate', function guardAggregate(this: never) {
      const aggregate = this as unknown as AggregateThis;
      check({ aggregate: aggregate.model()?.collection?.collectionName ?? '', pipeline: aggregate.pipeline() }, aggregate.options?.session);
    });
    schema.pre(['insertMany', 'bulkWrite'], function guardModel(this: never) {
      const model = this as unknown as ModelThis;
      check({ insert: model.collection?.collectionName ?? '' }, undefined);
    });
  });

  // `connection.transaction()`, `startSession()` and `withSession()` hand out the Preview session,
  // whose withTransaction runs the body inside the Preview transaction. The session's class is
  // sealed (see engine.ts), so the handler can't commit, abort or end it.
  const connection = mongoose.connection;
  const startSession = connection.startSession.bind(connection);
  connection.startSession = async (...args: unknown[]) => engine.state()?.session ?? startSession(...args);
  // Mongoose's own withSession goes straight to the driver client, which would start a session
  // of its own: one the guard then refuses.
  const withSession = connection.withSession?.bind(connection);
  if (withSession) {
    connection.withSession = async <T>(executor: (session: ClientSession) => Promise<T>) => {
      const session = engine.state()?.session;
      return session ? executor(session) : withSession(executor);
    };
  }

  return <T>(session: ClientSession | undefined, dispatch: () => Promise<T>): Promise<T> => {
    const storage = mongoose.transactionAsyncLocalStorage;
    return session && storage ? storage.run({ session }, dispatch) : dispatch();
  };
}

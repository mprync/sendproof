/**
 * Sendproof Preview for Prisma 7 driver adapters.
 *
 * `PrismaPreview` wraps the application's driver adapter factory. A Preview runs the request
 * inside one interactive Prisma transaction and resolves only after the driver acknowledges
 * the physical rollback. Statements that would end that transaction early, or write through
 * another connection, withhold confirmation. Model writes are captured automatically when
 * model metadata from `sendproof-prisma-generator` (or a `Prisma.dmmf` document) is supplied.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  controlsTransaction, currentCapture, endsTransaction, isRollback, mayWrite, PreviewSessionEndedError,
  PreviewStoreBusyError, previewSavepointHeld, rollsBackTransaction, safeProcedureNames, setPreviewSavepoint,
  type HeldPreview, type PreviewProvider,
} from '@sendproof/core';
import type { SqlDriverAdapter, SqlDriverAdapterFactory, SqlQuery, Transaction } from '@prisma/driver-adapter-utils';
import { ChangeCapture, isWrite, type ModelOperation } from './capture.js';
import { checkSavepoint, isStoreBusy, ownStatement, sessionError, stepSavepoint, takeSQLiteWriteLock } from './held-statements.js';
import { normalizeModels, type PrismaModels } from './metadata.js';

export { fromDmmf, normalizeModels, type DmmfDocument, type DmmfModel, type PrismaModelKeys,
  type PrismaModelMetadata, type PrismaModels } from './metadata.js';
// The statement classifier lives in @sendproof/core so every provider applies the same rules.
export { controlsTransaction, endsTransaction, mayWrite, splitStatements, type AdapterProvider } from '@sendproof/core';

/** Options passed to the Preview `$transaction`. */
export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
}

/** Options for `PrismaPreview`. */
export interface PrismaPreviewOptions {
  /** Options for the interactive transaction that hosts a Preview. */
  transactionOptions?: TransactionOptions;
  /**
   * Generated model metadata (`sendproof-prisma-generator`) or a `Prisma.dmmf` document.
   * When present, model writes record their changed rows without manual keys.
   */
  models?: PrismaModels;
  /** Most rows read for one bulk write before capture is marked incomplete. Defaults to 1000. */
  maxTrackedRows?: number;
  /**
   * MySQL and MariaDB stored procedures that never commit, by exact name (`name` or `schema.name`, no
   * wildcards). During a Preview every other `CALL` is refused, because a procedure can run `COMMIT`
   * or an implicitly committing statement inside the Preview transaction.
   *
   * **Warning:** listing a procedure is your statement that it never commits. One that does would
   * commit the handler's writes; the Preview still fails, but the writes stay.
   */
  safeProcedures?: readonly string[];
}

/** A Prisma client that can open an interactive transaction. */
export interface ClientWithTransaction<Client> {
  $transaction<Result>(operation: (client: Client) => Promise<Result>, options?: TransactionOptions): Promise<Result>;
}

/** Manually tracked rows for `track`, used where automatic capture does not apply. */
export interface TrackedRows<Client, Key> {
  table: string;
  key: Key;
  lookup: (client: Client, key: Key) => object | null | Promise<object | null>;
}

type ConnectionKind = 'connection' | 'preview' | 'foreign' | 'plain';

interface Probe {
  started: boolean;
  settled: boolean;
  rolledBack: boolean;
  committed: boolean;
  escaped?: string;
  /** The Preview's driver transaction, undecorated, for the provider's own savepoint statements. */
  transaction?: Transaction;
  held?: {
    finish: () => void;
    onError: (error: unknown) => void;
    expired?: boolean;
  };
}

interface Scope {
  client: unknown;
  open: boolean;
}

/** Replace selected members of an adapter object while forwarding everything else. */
function decorate<T extends object>(target: T, methods: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(object, name) {
      if (Object.hasOwn(methods, name)) return methods[name as keyof T];
      const value: unknown = Reflect.get(object, name, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** Enlist a Prisma client and require rollback acknowledgment from its driver adapter. */
export class PrismaPreview<Client = unknown> implements PreviewProvider {
  /** Pass this factory to `new PrismaClient({ adapter })`. */
  readonly adapter: SqlDriverAdapterFactory;
  readonly openSession?: () => Promise<HeldPreview>;
  /** The SQL provider id discovery reports as `database.system`: the adapter's provider, such as `postgresql`. */
  get system(): string {
    return this.#provider;
  }
  #client: unknown;
  readonly #scopes = new AsyncLocalStorage<Scope>();
  readonly #probe = new AsyncLocalStorage<Probe>();
  readonly #labels = new AsyncLocalStorage<string[]>();
  readonly #internal = new AsyncLocalStorage<boolean>();
  readonly #manual = new AsyncLocalStorage<boolean>();
  /** MySQL stored procedures the host declared never commit; every other `CALL` is refused in a Preview. */
  readonly #safeProcedures: ReadonlySet<string>;
  readonly #provider: string;
  readonly #singleConnection: boolean;
  readonly #transactionOptions: TransactionOptions | undefined;
  readonly #capture: ChangeCapture | undefined;
  #queue: Promise<void> = Promise.resolve();
  #pendingTurns = 0;
  #invalid = false;
  #heldSQLite?: Probe;
  /**
   * MySQL previews take turns. InnoDB checks a new key for duplicates under a shared lock: when three or more
   * transactions insert the same key and the first rolls back, as every Preview does, the waiters each hold that lock
   * and each need the exclusive one, so InnoDB aborts all but one with a deadlock (error 1213). Sent for real, the
   * first insert commits and the others get a duplicate-key error instead.
   */
  readonly #serialPreviews: boolean;

  constructor(factory: SqlDriverAdapterFactory, options: PrismaPreviewOptions = {}) {
    this.#provider = factory.provider;
    this.#safeProcedures = safeProcedureNames(options.safeProcedures);
    this.#singleConnection = factory.provider === 'sqlite';
    this.#serialPreviews = factory.provider === 'mysql';
    this.#transactionOptions = options.transactionOptions;
    if (factory.provider === 'sqlite' || factory.provider === 'mysql' || factory.provider === 'postgres') {
      this.openSession = () => this.#openSession();
    }
    const maxRows = options.maxTrackedRows ?? 1000;
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new RangeError('maxTrackedRows must be a positive integer.');
    this.#capture = options.models && new ChangeCapture(normalizeModels(options.models), {
      client: () => this.#scopes.getStore()?.client ?? this.#client,
      // Prisma queries are lazy: await inside the scope so the query runs while it is marked.
      internal: read => this.#internal.run(true, async () => await read()),
    }, maxRows);
    this.adapter = decorate(factory, {
      connect: async () => this.#instrumentConnection(await factory.connect()),
    });
  }

  /** The attached client, extended with automatic change capture when metadata was supplied. */
  get client(): Client {
    if (!this.#client) throw new Error('Attach a Prisma client before using PrismaPreview.');
    return this.#client as Client;
  }

  /** Pair the provider with the Prisma client constructed with `provider.adapter`. */
  attach<TransactionClient>(client: ClientWithTransaction<TransactionClient>): PrismaPreview<TransactionClient> {
    if (this.#client) throw new Error('A PrismaPreview instance owns one Prisma client.');
    if (this.#capture) {
      const extendable = client as unknown as { $extends?: (extension: object) => unknown };
      if (typeof extendable.$extends !== 'function') throw new TypeError('Automatic capture needs a Prisma client with $extends.');
      this.#client = extendable.$extends({
        name: '@sendproof/prisma',
        query: { $allModels: { $allOperations: (operation: ModelOperation) => this.#intercept(operation) } },
      });
    } else {
      this.#client = client;
    }
    return this as unknown as PrismaPreview<TransactionClient>;
  }

  /** Use the request's client for the duration of an awaited callback. */
  async run<T>(operation: (client: Client) => T): Promise<Awaited<T>> {
    const scope = this.#scopes.getStore();
    if (!scope) return this.#lease(() => this.#withClient(this.#client, operation));
    if (!scope.open) throw new Error('The Prisma request scope has ended.');
    return await operation(scope.client as Client);
  }

  /** Name the positional parameters of the queries issued by one awaited callback. */
  async withParameterNames<T>(names: string[], operation: () => T): Promise<Awaited<T>> {
    return this.#labels.run([...names], async (): Promise<Awaited<T>> => await operation());
  }

  /**
   * Record the before and after state of rows selected by an explicit key. Use it for writes
   * that automatic capture cannot see, such as raw SQL. Automatic capture is paused inside.
   */
  async track<T, Key>({ table, key, lookup }: TrackedRows<Client, Key>, mutation: (client: Client) => T): Promise<Awaited<T>> {
    return this.run(async client => {
      const recorder = currentCapture();
      if (!recorder) return await mutation(client);
      const snapshot = async () => {
        try {
          return await this.#internal.run(true, async () => await lookup(client, key));
        } catch {
          recorder.truncate('changes');
          return undefined;
        }
      };
      const before = await snapshot();
      const result = await this.#manual.run(true, async () => await mutation(client));
      const after = await snapshot();
      if (before !== undefined && after !== undefined && !isDeepStrictEqual(before, after)) {
        recorder.change({
          operation: before === null ? 'insert' : after === null ? 'delete' : 'update',
          table, key,
          before: before as Record<string, unknown> | null,
          after: after as Record<string, unknown> | null,
        });
      }
      return result;
    });
  }

  /** Run dispatch in an interactive transaction and resolve only after acknowledged rollback. */
  async preview<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.#scopes.getStore()) throw new Error('Nested Prisma previews are unavailable.');
    return this.#previewTurn(() => this.#lease(async () => {
      const probe: Probe = { started: false, settled: false, rolledBack: false, committed: false };
      const rollback = new Error('Sendproof requests rollback.');
      const client = this.#client as ClientWithTransaction<unknown>;
      let response: T | undefined;
      let failure: { error: unknown } | undefined;
      try {
        await this.#probe.run(probe, () => client.$transaction(async transaction => {
          // The backstop of spec/data-stores.md: a savepoint set now survives until the rollback only if nothing committed.
          await this.#ownStatement(probe, set => setPreviewSavepoint(set, this.#provider));
          try {
            response = await this.#withClient(transaction, dispatch);
          } catch (error) {
            failure = { error };
          }
          if (!probe.escaped && !await this.#ownStatement(probe, held => previewSavepointHeld(held, this.#provider))) {
            probe.escaped = 'the savepoint set when the Preview started was gone, so something committed the Preview transaction.';
          }
          probe.settled = true;
          throw rollback;
        }, this.#transactionOptions));
      } catch (error) {
        probe.settled = true;
        if (probe.started && (!probe.rolledBack || probe.committed)) {
          this.#invalid = true;
          throw new Error('The Prisma driver did not acknowledge rollback.', { cause: error });
        }
        if (probe.escaped) throw new Error('The Prisma preview was not contained: ' + probe.escaped, { cause: error });
        if (error !== rollback || !probe.rolledBack) throw error;
        if (failure) throw failure.error;
        return response as T;
      }
      this.#invalid = true;
      throw new Error('The Prisma preview transaction was not rolled back.');
    }));
  }

  /** Hold one interactive transaction open while each request supplies its own capture and client scope. */
  async #openSession(): Promise<HeldPreview> {
    if (this.#scopes.getStore()) throw new Error('Nested Prisma previews are unavailable.');
    if (!this.#client || this.#invalid) throw new Error('The Prisma preview client is unavailable.');
    const label = this.#singleConnection ? 'SQLite' : this.#serialPreviews ? 'MySQL' : 'PostgreSQL';
    const exclusive = this.#singleConnection || this.#serialPreviews;
    if (exclusive && this.#pendingTurns > 0) throw new PreviewStoreBusyError(label);

    const client = this.#client as ClientWithTransaction<unknown>;
    const ready = Promise.withResolvers<HeldPreview>();
    const finish = Promise.withResolvers<void>();
    const rollback = new Error('Sendproof requests rollback.');
    let unavailable: { error: unknown } | undefined;
    let socket: EventEmitter | undefined;
    const disconnected = (error: Error) => { unavailable ??= { error: sessionError(error) }; };
    const noteExpiry = (error: unknown) => {
      const failure = sessionError(error);
      if (failure instanceof PreviewSessionEndedError) unavailable ??= { error: failure };
      return failure;
    };
    const held: NonNullable<Probe['held']> = { finish: finish.resolve, onError: noteExpiry };
    const probe: Probe = { started: false, settled: false, rolledBack: false, committed: false, held };

    const start = () => this.#probe.run(probe, () => client.$transaction(async transaction => {
      const own = async (sql: string) => {
        try { await this.#ownStatement(probe, ownSql => ownSql(sql)); }
        catch (error) { throw noteExpiry(error); }
      };
      const mark = () => own('SAVEPOINT ' + checkSavepoint);
      const prove = () => own('RELEASE SAVEPOINT ' + checkSavepoint);
      const assertHeld = () => {
        if (unavailable) throw unavailable.error;
        if (held.expired) throw new PreviewSessionEndedError('The Prisma Preview transaction expired.');
        if (probe.settled || probe.escaped || probe.committed) throw new Error('The Prisma Preview transaction could not be confirmed.');
      };
      try {
        const driverTransaction = probe.transaction;
        if (!driverTransaction) throw new Error('The Prisma transaction was not started through the provider adapter.');
        const driver = (driverTransaction as { client?: unknown }).client;
        if (driver instanceof EventEmitter && 'connectionParameters' in driver) {
          socket = driver;
          socket.on('error', disconnected);
        }
        if (this.#singleConnection) {
          this.#heldSQLite = probe;
          await takeSQLiteWriteLock(driverTransaction);
        }
        await mark();
        ready.resolve({
          async checkpoint(step) {
            assertHeld();
            await prove();
            await own('SAVEPOINT ' + stepSavepoint(step));
            await mark();
          },
          run: async (_capture, dispatch) => {
            assertHeld();
            try {
              return await this.#probe.run(probe, () => this.#withClient(transaction, dispatch));
            } catch (error) {
              throw noteExpiry(error);
            }
          },
          async verify() {
            assertHeld();
            // RELEASE proves the marker still exists and PostgreSQL has not marked the transaction aborted.
            await prove();
            await mark();
          },
          async rewind(step) {
            assertHeld();
            await own('ROLLBACK TO SAVEPOINT ' + stepSavepoint(step));
            await own('RELEASE SAVEPOINT ' + stepSavepoint(step));
            await mark();
          },
          async close() {
            finish.resolve();
            await finished;
          },
        });
        await finish.promise;
        throw rollback;
      } finally {
        probe.settled = true;
      }
    }, {
      maxWait: Math.min(this.#transactionOptions?.maxWait ?? 1500, 1500),
      // Prisma's default is five seconds. The core owns the normal idle and lifetime limits.
      timeout: Math.max(this.#transactionOptions?.timeout ?? 0, 31 * 60 * 1000),
    })).then(() => {
      this.#invalid = true;
      throw new Error('The Prisma Preview transaction returned without rolling back.');
    }).catch(error => {
      probe.settled = true;
      // PostgreSQL explicitly ended the pinned transaction. The rest of its pool is still usable.
      if (unavailable?.error instanceof PreviewSessionEndedError && !held.expired) {
        ready.reject(unavailable.error);
        return;
      }
      if (probe.started && (!probe.rolledBack || probe.committed)) {
        this.#invalid = true;
        throw new Error('The Prisma driver did not acknowledge rollback.', { cause: error });
      }
      if (error === rollback && probe.rolledBack) return;
      if (isStoreBusy(error)) throw new PreviewStoreBusyError(label);
      throw sessionError(error);
    }).finally(() => {
      if (this.#heldSQLite === probe) this.#heldSQLite = undefined;
      socket?.off('error', disconnected);
    });
    const finished = (exclusive ? this.#turn(start) : start()).catch(error => {
      unavailable ??= { error };
      ready.reject(unavailable.error);
      throw unavailable.error;
    });
    void finished.catch(() => {});
    return ready.promise;
  }

  /**
   * Runs the provider's own savepoint statements on the Preview's driver transaction itself, out of the capture and past
   * the guard that refuses a handler's statements naming that savepoint. MySQL refuses `SAVEPOINT` in the prepared
   * statement protocol most adapters use, so the adapter's savepoint methods, which send plain text, come first.
   */
  async #ownStatement<T>(probe: Probe, use: (run: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
    const transaction = probe.transaction;
    if (!transaction) throw new Error('The Prisma preview transaction was not started through the provider adapter.');
    return use(sql => ownStatement(transaction, sql));
  }

  /** Run a MySQL Preview once every earlier one has settled; other databases run previews at once. */
  async #previewTurn<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialPreviews ? this.#turn(operation) : operation();
  }

  async #intercept({ model, operation, args, query }: ModelOperation): Promise<unknown> {
    const recorder = currentCapture();
    if (!recorder || !this.#capture || !isWrite(operation) || this.#internal.getStore() || this.#manual.getStore()) {
      return query(args);
    }
    return this.#capture.write({ model, operation, args, query }, recorder);
  }

  async #lease<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#client || this.#invalid) throw new Error('The Prisma preview client is unavailable.');
    if (!this.#singleConnection) return operation();
    return this.#turn(async () => {
      if (this.#invalid) throw new Error('The Prisma preview client requires recovery after a failed rollback.');
      return operation();
    });
  }

  async #turn<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    const turn = Promise.withResolvers<void>();
    this.#queue = turn.promise;
    this.#pendingTurns++;
    try {
      await previous;
      return await operation();
    } finally {
      this.#pendingTurns--;
      turn.resolve();
    }
  }

  async #withClient<T>(client: unknown, operation: (client: Client) => T): Promise<Awaited<T>> {
    const scope: Scope = { client, open: true };
    try {
      return await this.#scopes.run(scope, async () => await operation(client as Client));
    } finally {
      scope.open = false;
    }
  }

  #instrumentConnection(connection: SqlDriverAdapter): SqlDriverAdapter {
    return decorate(connection, {
      ...this.#queries(connection, 'connection'),
      executeScript: async (script: string) => {
        this.#guard('connection', script);
        return connection.executeScript(script);
      },
      startTransaction: async (level?: Parameters<SqlDriverAdapter['startTransaction']>[0]) => {
        if (this.#heldSQLite) throw new Error('Use PrismaPreview.run() while a SQLite Preview session holds the connection.');
        return this.#instrumentTransaction(await connection.startTransaction(level));
      },
    });
  }

  #instrumentTransaction(transaction: Transaction): Transaction {
    const probe = this.#probe.getStore();
    if (!probe || probe.settled) return decorate(transaction, this.#queries(transaction, 'plain'));
    if (probe.started) return decorate(transaction, this.#queries(transaction, 'foreign'));
    probe.started = true;
    probe.transaction = transaction;
    let wireRollback = false;
    return decorate(transaction, {
      ...this.#queries(transaction, 'preview', sql => {
        if ((probe.settled || probe.held?.expired) && isRollback(sql)) wireRollback = true;
      }, probe.held ? probe : undefined),
      commit: async () => {
        probe.committed = true;
        await transaction.commit();
      },
      rollback: async () => {
        if (probe.held && !probe.settled) probe.held.expired = true;
        try {
          await transaction.rollback();
          // Some adapters execute a physical ROLLBACK in their method. Others accept the raw
          // statement from Prisma and then use rollback() to release the driver resources.
          probe.rolledBack = transaction.options.usePhantomQuery || wireRollback;
        } finally {
          if (probe.held?.expired) probe.held.finish();
        }
      },
    });
  }

  /** Record executed SQL and prevent statements that would escape the Preview transaction. */
  #queries(target: SqlDriverAdapter | Transaction, kind: ConnectionKind,
    onExecute?: (sql: string) => void, heldProbe?: Probe) {
    const run = <R>(execute: (query: SqlQuery) => Promise<R>, counts: boolean) => async (query: SqlQuery): Promise<R> => {
      const scopeProbe = this.#probe.getStore();
      const scope = this.#scopes.getStore();
      // Prisma's transaction manager can send ROLLBACK from its timer even with no request running.
      if (heldProbe?.held && heldProbe === scopeProbe && !scope && isRollback(query.sql)) {
        if (!heldProbe.settled) heldProbe.held.expired = true;
      } else {
        if (heldProbe && (heldProbe !== scopeProbe || !scope?.open || heldProbe.settled || heldProbe.held?.expired)) {
          throw new Error('The Prisma Preview request scope has ended.');
        }
        this.#guard(kind, query.sql);
      }
      const recorder = this.#internal.getStore() ? undefined : currentCapture();
      const started = performance.now();
      let result: R;
      try {
        result = await execute(query);
      } catch (error) {
        // The handler still gets the database's error. After a deadlock the Preview transaction is gone, so every
        // later statement would run with autocommit: the guard now refuses them and the Preview fails.
        const probe = this.#probe.getStore();
        probe?.held?.onError(error);
        if (kind === 'preview' && probe && !probe.escaped && rollsBackTransaction(error, this.#provider)) {
          probe.escaped = 'the database rolled the Preview transaction back after a deadlock or lock wait timeout.';
        }
        throw error;
      }
      const names = this.#labels.getStore();
      recorder?.sql({
        text: query.sql,
        elapsedMs: performance.now() - started,
        ...(counts ? { rowsAffected: result as number } : {}),
        parameters: (query.args ?? []).map((value, index) => ({
          name: names?.[index] ?? '$' + (index + 1),
          value: '[REDACTED]',
          dbType: query.argTypes?.[index]?.scalarType ?? (value === null ? 'null' : typeof value),
        })),
      });
      onExecute?.(query.sql);
      return result;
    };
    return {
      queryRaw: run(query => target.queryRaw(query), false),
      executeRaw: run(query => target.executeRaw(query), true),
    };
  }

  #guard(kind: ConnectionKind, sql: string): void {
    const probe = this.#probe.getStore();
    if (kind === 'connection' && this.#heldSQLite) {
      if (probe !== this.#heldSQLite || !this.#scopes.getStore()?.open || probe.settled || probe.held?.expired) {
        throw new Error('Use PrismaPreview.run() while a SQLite Preview session holds the connection.');
      }
      kind = 'preview';
    }
    if (!probe || probe.settled || kind === 'plain') return;
    if (probe.escaped) throw new Error('The Prisma preview was not contained: ' + probe.escaped);
    if (kind === 'preview') {
      if (!endsTransaction(sql, this.#provider, this.#safeProcedures)) return;
      probe.escaped = 'a statement would end the Preview transaction early.';
    } else {
      // SQLite shares one connection. Other databases can run reads on a pooled connection.
      if (this.#singleConnection || !mayWrite(sql, this.#provider)) return;
      // A separate transaction's own BEGIN, COMMIT and savepoints do not change rows.
      if (kind === 'foreign' && controlsTransaction(sql, this.#provider)) return;
      probe.escaped = kind === 'foreign'
        ? 'a separate transaction tried to write during the Preview.'
        : 'a write was attempted outside the Preview transaction.';
    }
    throw new Error('The Prisma preview was not contained: ' + probe.escaped);
  }
}

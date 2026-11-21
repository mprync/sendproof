import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCapture } from '@test-bench/core';
import type { PreviewProvider } from '@test-bench/core';
import type { DataSource, EntityManager, EntityTarget, FindOptionsWhere, Logger, ObjectLiteral, QueryRunner, Repository } from 'typeorm';
import { ChangeTracker } from './changes.js';
import { ConnectionLease } from './lease.js';

/** Drivers that multiplex every query runner over one physical connection. */
const singleConnectionDrivers = new Set(['better-sqlite3', 'sqlite', 'sqljs', 'react-native', 'cordova', 'capacitor', 'expo']);

/** Drivers whose transactions refuse every statement after one fails, unless a savepoint is rolled back. */
const abortOnErrorDrivers = new Set(['postgres', 'cockroachdb', 'aurora-postgres']);

/** Savepoint that fences one inspection read inside an enrolled transaction. */
const inspectionSavepoint = 'test_bench_inspection';

/** Default ceiling on the rows read from a table when diffing a write. */
const defaultMaxTrackedRows = 5000;

export interface TypeOrmPreviewOptions {
  /**
   * Largest table, in rows, that is read before and after a write to report row changes.
   * A larger table marks the capture truncated and the write appears as SQL only. Default 5000.
   */
  maxTrackedRows?: number;
}

/** Positional parameters of `QueryRunner.query` as TypeORM's drivers receive them. */
type QueryFunction = (text: string, parameters?: unknown[], useStructuredResult?: boolean) => Promise<unknown>;

interface Scope {
  readonly manager: EntityManager;
  open: boolean;
}

/**
 * Test Bench data provider for a host-owned TypeORM DataSource.
 *
 * Preview runs the request on a dedicated query runner inside a transaction that is always rolled
 * back, and Send leaves the ordinary manager in use. In both modes, row changes are derived from
 * Entity metadata: the primary columns of the mapped table a write targets identify the rows that
 * changed, so handlers need no per-operation key lists. See {@link ChangeTracker} for scope.
 */
export class TypeOrmPreview implements PreviewProvider {
  readonly #source: DataSource;
  readonly #lease: ConnectionLease;
  readonly #tracker: ChangeTracker;
  readonly #scopes = new AsyncLocalStorage<Scope>();
  readonly #labels = new AsyncLocalStorage<readonly string[]>();
  readonly #hidden = new AsyncLocalStorage<true>();
  readonly #previousLogger: Logger;
  readonly #createQueryRunner: DataSource['createQueryRunner'];
  readonly #wrappers = new WeakMap<QueryRunner, { wrapper: QueryFunction; ownQuery: QueryRunner['query'] | undefined }>();
  #disposed = false;

  constructor(source: DataSource, options: TypeOrmPreviewOptions = {}) {
    const maxRows = options.maxTrackedRows ?? defaultMaxTrackedRows;
    if (!Number.isInteger(maxRows) || maxRows < 1) throw new RangeError('maxTrackedRows must be a positive integer.');
    this.#source = source;
    this.#lease = new ConnectionLease(singleConnectionDrivers.has(source.options.type));
    this.#tracker = new ChangeTracker(source, maxRows);
    this.#previousLogger = source.logger;
    this.#createQueryRunner = source.createQueryRunner;
    this.#wrapLogger(source);
    // Every manager, repository and query builder creates its runner through the source, so
    // wrapping creation instruments ordinary requests and Preview alike without touching the pool.
    source.createQueryRunner = mode => this.#instrument(this.#createQueryRunner.call(source, mode));
  }

  /**
   * Restore the application's logger and query runner factory and stop capturing.
   *
   * SQLite drivers reuse one query runner for the life of the source, so its instrumented `query`
   * is restored too, unless another provider has since wrapped it; in that case this provider's
   * wrapper stays in place as a pass-through.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#source.createQueryRunner = this.#createQueryRunner;
    this.#source.setOptions({ logger: this.#previousLogger });
    const shared = (this.#source.driver as { queryRunner?: QueryRunner }).queryRunner;
    const wrapped = shared && this.#wrappers.get(shared);
    if (shared && wrapped && shared.query === (wrapped.wrapper as QueryRunner['query'])) {
      if (wrapped.ownQuery) shared.query = wrapped.ownQuery;
      else delete (shared as Partial<QueryRunner>).query;
    }
  }

  /** Use the active EntityManager for every normal and preview operation. */
  async run<T>(operation: (manager: EntityManager) => T): Promise<Awaited<T>> {
    const scope = this.#scopes.getStore();
    if (!scope) return this.#lease.run(() => this.#withManager(this.#source.manager, operation));
    if (!scope.open) throw new Error('The TypeORM request scope has ended.');
    return await operation(scope.manager);
  }

  /**
   * Run a mutation against an entity repository.
   *
   * @deprecated Row changes are now captured automatically from Entity metadata. The keys are
   * ignored; call {@link run} with `manager.getRepository(entity)` instead.
   */
  track<Entity extends ObjectLiteral, T>(entity: EntityTarget<Entity>, keys: FindOptionsWhere<Entity>[],
    operation: (repository: Repository<Entity>) => T): Promise<Awaited<T>>;
  track<Entity extends ObjectLiteral, T>(entity: EntityTarget<Entity>,
    operation: (repository: Repository<Entity>) => T): Promise<Awaited<T>>;
  track<Entity extends ObjectLiteral, T>(
    entity: EntityTarget<Entity>,
    keysOrOperation: FindOptionsWhere<Entity>[] | ((repository: Repository<Entity>) => T),
    maybeOperation?: (repository: Repository<Entity>) => T,
  ): Promise<Awaited<T>> {
    const operation = typeof keysOrOperation === 'function' ? keysOrOperation : maybeOperation;
    if (!operation) throw new TypeError('track requires a mutation callback.');
    return this.run(manager => operation(manager.getRepository(entity)));
  }

  /** Label the positional bindings of queries issued during one awaited operation. */
  withParameterNames<T>(names: string[], operation: () => T): Promise<Awaited<T>> {
    return this.#labels.run([...names], async (): Promise<Awaited<T>> => await operation());
  }

  /** Run `dispatch` in a transaction that is rolled back, releasing the runner afterwards. */
  async preview<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.#scopes.getStore()) throw new Error('Nested TypeORM previews are unavailable.');
    return this.#lease.run(async () => {
      const runner = this.#source.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction();
        try {
          return await this.#withManager(runner.manager, dispatch);
        } finally {
          await this.#rollBack(runner);
        }
      } finally {
        try {
          await runner.release();
        } catch (error) {
          this.#lease.invalidate();
          throw error;
        }
      }
    });
  }

  /** Roll back the preview transaction and every savepoint the handler left open inside it. */
  async #rollBack(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('The TypeORM preview transaction completed early.');
    try {
      while (runner.isTransactionActive) await runner.rollbackTransaction();
    } catch (error) {
      this.#lease.invalidate();
      throw error;
    }
  }

  async #withManager<T>(manager: EntityManager, operation: (manager: EntityManager) => T): Promise<Awaited<T>> {
    const scope: Scope = { manager, open: true };
    try {
      return await this.#scopes.run(scope, operation, manager);
    } finally {
      scope.open = false;
    }
  }

  /** Report SQL to the capture, and the application's own logger, with redacted parameters. */
  #wrapLogger(source: DataSource): void {
    const previous = this.#previousLogger;
    const wrapped: Logger = {
      logQueryError: (...args) => previous.logQueryError(...args),
      logQuerySlow: (...args) => previous.logQuerySlow(...args),
      logSchemaBuild: (...args) => previous.logSchemaBuild(...args),
      logMigration: (...args) => previous.logMigration(...args),
      log: (...args) => previous.log(...args),
      logQuery: (text, parameters, runner) => {
        // Snapshot reads are internal: neither the capture nor the application's log sees them.
        if (this.#hidden.getStore()) return;
        const names = this.#labels.getStore();
        currentCapture()?.sql({ text, parameters: (parameters ?? []).map((value: unknown, index: number) => ({
          name: names?.[index] ?? '$' + (index + 1),
          value: '[REDACTED]',
          dbType: value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value,
        })) });
        previous.logQuery(text, parameters, runner);
      },
    };
    source.setOptions({ logger: wrapped });
  }

  /** Wrap `query` on a runner so writes to mapped tables report their row changes. */
  #instrument(runner: QueryRunner): QueryRunner {
    if (this.#disposed || this.#wrappers.has(runner)) return runner;
    const ownQuery = Object.hasOwn(runner, 'query') ? runner.query : undefined;
    const original = runner.query.bind(runner) as QueryFunction;
    const read = (sql: string): Promise<unknown> => this.#hidden.run(true, () => this.#inspect(runner, original, sql));
    const wrapper: QueryFunction = (text, parameters, useStructuredResult) => {
      const capture = currentCapture();
      if (this.#disposed || !capture || this.#hidden.getStore()) return original(text, parameters, useStructuredResult);
      return this.#tracker.around(capture, text, read, () => original(text, parameters, useStructuredResult));
    };
    this.#wrappers.set(runner, { wrapper, ownQuery });
    runner.query = wrapper as QueryRunner['query'];
    return runner;
  }

  /**
   * Run one inspection read. On PostgreSQL-family drivers a failed statement aborts the whole
   * transaction, which would break the handler's own writes, so a read inside a transaction is
   * fenced by a savepoint that is rolled back when the read fails. The failure is still thrown so
   * the tracker can mark the capture truncated.
   */
  async #inspect(runner: QueryRunner, execute: QueryFunction, sql: string): Promise<unknown> {
    if (!runner.isTransactionActive || !abortOnErrorDrivers.has(this.#source.options.type)) return execute(sql);
    await execute(`SAVEPOINT ${inspectionSavepoint}`);
    try {
      const rows = await execute(sql);
      await execute(`RELEASE SAVEPOINT ${inspectionSavepoint}`);
      return rows;
    } catch (error) {
      try {
        await execute(`ROLLBACK TO SAVEPOINT ${inspectionSavepoint}`);
        await execute(`RELEASE SAVEPOINT ${inspectionSavepoint}`);
      } catch {
        // The original read failure is the useful error; a broken transaction surfaces on the next statement.
      }
      throw error;
    }
  }
}

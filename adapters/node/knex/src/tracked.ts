import type { Knex } from 'knex';
import { endsTransaction, rollsBackTransaction } from '@sendproof/core';
import type { AdapterProvider } from '@sendproof/core';

/**
 * What the application told one query builder, captured from public builder calls so the provider
 * never has to read Knex internals or parse SQL.
 */
export interface BuilderState {
  /** The table argument of `knex(table)`, `.table()`, `.from()` or `.into()`. */
  table: unknown;
  /** Whether `.insert()` was called, and the data it received. */
  hasData: boolean;
  data: unknown;
  /** The columns passed to `.returning()` or as the second argument of `.insert()`. */
  returning: unknown;
}

/** Runs a mutation with tracking. `execute` performs the builder's real query. */
export type MutationRunner = (builder: Knex.QueryBuilder, state: BuilderState, execute: () => Promise<unknown>) => Promise<unknown>;

const tableMethods = new Set(['table', 'from', 'into']);

function wrapBuilder(builder: Knex.QueryBuilder, state: BuilderState, run: MutationRunner): Knex.QueryBuilder {
  return new Proxy(builder, {
    get(target, property, receiver: unknown) {
      if (property === 'then') {
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          run(target, state, () => new Promise((resolve, reject) => { target.then(resolve, reject); }))
            .then(onFulfilled, onRejected);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property === 'insert') {
        return (...args: unknown[]) => {
          state.hasData = true;
          state.data = args[0];
          if (args[1] !== undefined) state.returning = args[1];
          return method.apply(receiver, args);
        };
      }
      if (property === 'returning') {
        return (...args: unknown[]) => {
          state.returning = args[0];
          return method.apply(receiver, args);
        };
      }
      if (typeof property === 'string' && tableMethods.has(property)) {
        return (...args: unknown[]) => {
          state.table = args[0];
          return method.apply(receiver, args);
        };
      }
      if (property === 'clone') {
        return () => wrapBuilder(method.apply(receiver, []) as Knex.QueryBuilder, { ...state }, run);
      }
      return method;
    },
  });
}

/**
 * Wrap a Knex client or transaction so every query builder it creates reports its data mutations
 * to `run` before and after they execute. Everything else passes through untouched.
 */
export function trackClient<Client extends Knex>(connection: Client, run: MutationRunner): Client {
  const start = (builder: Knex.QueryBuilder, table: unknown) =>
    wrapBuilder(builder, { table, hasData: false, data: undefined, returning: undefined }, run);
  return new Proxy(connection, {
    apply(target, thisArgument: unknown, args: unknown[]) {
      return start(Reflect.apply(target, thisArgument, args) as Knex.QueryBuilder, args[0]);
    },
    get(target, property, receiver: unknown) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'queryBuilder' && typeof value === 'function') {
        return (...args: unknown[]) => start((value as (...a: unknown[]) => Knex.QueryBuilder).apply(receiver, args), undefined);
      }
      return value;
    },
  });
}

/** A table as the builder named it, split into the name to query and the qualifier columns use. */
export interface TableName {
  name: string;
  qualifier: string;
}

/** Understand the table forms Knex accepts: `'items'`, `'schema.items'`, `'items as i'`, `{ i: 'items' }`. */
export function resolveTable(spec: unknown): TableName | undefined {
  if (typeof spec === 'string') {
    const aliased = /^(\S+)\s+as\s+(\S+)$/i.exec(spec.trim());
    if (aliased?.[1] && aliased[2]) return { name: aliased[1], qualifier: aliased[2] };
    return /\s/.test(spec) || spec === '' ? undefined : { name: spec, qualifier: spec };
  }
  if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
    const entries = Object.entries(spec);
    const [entry] = entries;
    if (entries.length === 1 && entry && typeof entry[1] === 'string') return { name: entry[1], qualifier: entry[0] };
  }
  return undefined;
}

/** Why a Preview refuses to let the operation end its transaction. */
export const previewOwnsMessage = 'Preview owns the transaction and must roll it back. Use provider.transaction() for a nested unit of work.';

/**
 * Wrap the Preview transaction so the operation cannot `commit()` or `rollback()` it. `refused` is
 * told of the refusal, so the Preview fails even if the operation catches the error. Refusing the
 * methods here, rather than their SQL in {@link guardStatements}, keeps Knex from marking the
 * transaction finished while it is still open on the connection. SQL that would end the
 * transaction is refused below the builders. Everything else, including calling the transaction as
 * a query builder, passes through untouched.
 */
export function guardPreview<Client extends Knex>(connection: Client, refused: () => void): Client {
  return new Proxy(connection, {
    get(target, property, receiver: unknown) {
      if (property === 'commit' || property === 'rollback') {
        return () => {
          refused();
          return Promise.reject(new Error(previewOwnsMessage));
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** What {@link guardStatements} needs from the provider. */
export interface StatementGuard {
  provider: AdapterProvider;
  /** Stored procedures the host declared never commit (MySQL `CALL`). */
  safeProcedures: ReadonlySet<string>;
  /** Told of every refusal, so the Preview fails even if the operation catches the error. */
  refused: () => void;
  /** True while the provider runs its own statements, such as the final ROLLBACK. */
  internal: () => boolean;
  /** Refuse queries from work that outlived its Preview step. */
  active: () => boolean;
  /** Whether the database already rolled the Preview transaction back (a deadlock), and how to record that it did. */
  broken: () => boolean;
  markBroken: () => void;
}

/** A transaction's client, as Knex builds it: every query and stream on the transaction goes through these two. */
interface TransactionClient {
  query(connection: unknown, query: unknown): Promise<unknown>;
  stream(connection: unknown, query: unknown, ...rest: unknown[]): Promise<unknown>;
}

/**
 * Refuse, before it is sent, any statement on `transaction` that would commit, roll back or
 * otherwise end the Preview transaction: explicit transaction control, `SET autocommit`, and on
 * MySQL every implicitly committing statement and `CALL` to an undeclared procedure.
 *
 * Knex sends every statement of a transaction (builders, `raw`, the schema builder, and the
 * transaction's own `COMMIT`) through the transaction's client, so the check sits there. Each
 * nested transaction gets a client of its own that skips its parent's, so every savepoint inside a
 * Preview is guarded too. Savepoint statements pass.
 */
export function guardStatements(transaction: Knex.Transaction, guard: StatementGuard): void {
  const client = transaction.client as unknown as TransactionClient;
  const check = (query: unknown): Error | undefined => {
    if (guard.internal()) return undefined;
    if (!guard.active()) return new Error('The Knex preview transaction scope has ended.');
    // After a deadlock the transaction is gone: a statement now would run with autocommit and commit for real.
    if (guard.broken()) return new Error(deadlockMessage);
    const text = typeof query === 'string' ? query : (query as { sql?: unknown } | null)?.sql;
    if (typeof text !== 'string' || !endsTransaction(text, guard.provider, guard.safeProcedures)) return undefined;
    guard.refused();
    return new Error(previewOwnsMessage);
  };
  /** The caller still gets the database's error; the Preview remembers that its transaction is gone. */
  const watch = <T>(sent: Promise<T>): Promise<T> => sent.catch((error: unknown) => {
    if (rollsBackTransaction(error, guard.provider)) guard.markBroken();
    throw error;
  });
  const query = client.query;
  client.query = function guardedQuery(this: TransactionClient, connection, sent) {
    const refusal = check(sent);
    return refusal ? Promise.reject(refusal) : watch(query.call(this, connection, sent));
  };
  const stream = client.stream;
  client.stream = function guardedStream(this: TransactionClient, connection, sent, ...rest) {
    const refusal = check(sent);
    return refusal ? Promise.reject(refusal) : watch(stream.call(this, connection, sent, ...rest));
  };
}

/** Why a statement after a deadlock is refused. */
export const deadlockMessage = 'The database rolled the Preview transaction back after a deadlock or lock wait timeout, so no further statement runs in this Preview.';

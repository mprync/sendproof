import type { Knex } from 'knex';
import { endsTransaction } from '@test-bench/core';
import type { AdapterProvider } from '@test-bench/core';

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
 * Wrap the Preview transaction so the operation cannot end it: `commit()` is refused, and so is
 * raw SQL that would commit, roll back or otherwise end the transaction (including MySQL's
 * implicit commits). `refused` is told of every refusal, so the Preview fails even if the
 * operation catches the error. Savepoints and `transaction()` nesting stay available. Everything else,
 * including calling the transaction as a query builder, passes through untouched.
 */
export function guardPreview<Client extends Knex>(connection: Client, provider: AdapterProvider, refused: () => void): Client {
  const refuse = () => {
    refused();
    return new Error(previewOwnsMessage);
  };
  return new Proxy(connection, {
    get(target, property, receiver: unknown) {
      if (property === 'commit') return () => Promise.reject(refuse());
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'raw' && typeof value === 'function') {
        return (...args: unknown[]) => {
          const [text] = args;
          if (typeof text === 'string' && endsTransaction(text, provider)) throw refuse();
          return (value as (...a: unknown[]) => unknown).apply(receiver, args);
        };
      }
      return value;
    },
  });
}

import { TransactionRollbackError } from 'drizzle-orm';
import { instrumentMutation } from './capture.js';
import type { DatabaseLike, ProviderState } from './capture.js';
import { currentCapture } from '@sendproof/core';
import { asCaller, asInternal, currentScope, endedMessage, inScope, report } from './scope.js';
import type { Scope } from './scope.js';
import { instrumentSession } from './statements.js';

type Method = (...args: unknown[]) => unknown;

/**
 * The application's client: the Drizzle database, routed to the transaction of the calling context.
 *
 * Inside a Preview or `client.transaction()` every query runs on that transaction. Mutations built
 * from the client capture row changes, and `transaction()` nests as a savepoint. With `fixed`, the
 * client is bound to one transaction, as the object passed to a transaction callback is.
 */
export function createClient(state: ProviderState, fixed?: Scope): DatabaseLike {
  const resolve = (): DatabaseLike => {
    const scope = fixed ?? (state.sqlite ? undefined : currentScope());
    if (scope && !scope.open) throw new Error(endedMessage);
    return (scope && !state.sqlite ? scope.target : state.base) as DatabaseLike;
  };

  return new Proxy(state.base, {
    get(_base, property) {
      const target = resolve();
      switch (property) {
        case 'insert':
        case 'update':
        case 'delete':
          return (table: unknown) => mutationBuilder(state, target, property, (target[property] as Method)(table));
        case 'with':
          return (...queries: unknown[]) => withQueries(state, target, (target['with'] as Method)(...queries));
        case 'transaction':
          return (callback: (client: DatabaseLike) => Promise<unknown>, config?: unknown) =>
            transaction(state, target, fixed ?? currentScope(), callback, config);
        case 'rollback':
          // Drizzle transactions roll back by throwing; SQLite savepoints follow the same rule.
          if (state.sqlite && fixed) return () => { throw new TransactionRollbackError(); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as Method).bind(target) : value;
    },
  });
}

function mutationBuilder(state: ProviderState, target: DatabaseLike, kind: 'insert' | 'update' | 'delete', builder: unknown): unknown {
  if (kind === 'delete') return instrumentMutation(state, target, kind, builder);
  const stage = builder as Record<string, unknown>;
  for (const name of kind === 'insert' ? ['values', 'select'] : ['set']) {
    const method = stage[name];
    if (typeof method === 'function') {
      stage[name] = (...args: unknown[]) => instrumentMutation(state, target, kind, (method as Method).apply(builder, args));
    }
  }
  return builder;
}

/** `client.with(...)` returns a query builder whose mutations need the same capture. */
function withQueries(state: ProviderState, target: DatabaseLike, builder: unknown): unknown {
  const queries = builder as Record<string, unknown>;
  for (const kind of ['insert', 'update', 'delete'] as const) {
    const method = queries[kind];
    if (typeof method === 'function') {
      queries[kind] = (table: unknown) => mutationBuilder(state, target, kind, (method as Method).call(builder, table));
    }
  }
  return builder;
}

async function transaction(
  state: ProviderState,
  target: DatabaseLike,
  parent: Scope | undefined,
  callback: (client: DatabaseLike) => Promise<unknown>,
  config: unknown,
): Promise<unknown> {
  const sqlite = state.sqlite;
  if (sqlite) {
    if (!sqlite.transaction) {
      throw new Error('client.transaction() needs @sendproof/sqlite with SQLiteDatabase.transaction().');
    }
    const scope: Scope = { target: state.base, preview: parent?.preview ?? false, open: true, changes: [] };
    const result = await sqlite.transaction(async () => {
      try {
        return await inScope(scope, async () => await callback(createClient(state, scope)));
      } finally {
        scope.open = false;
      }
    });
    settle(scope);
    return result;
  }
  // Drizzle issues BEGIN, SAVEPOINT, COMMIT and ROLLBACK itself; they stay out of the SQL log.
  let scope: Scope | undefined;
  const result = await asInternal(() => target.transaction(async opened => {
    scope = { target: opened, preview: parent?.preview ?? false, open: true, changes: [] };
    const current = scope;
    instrumentSession(opened.session, state.dialect, current);
    try {
      // Await inside the scope: a returned query builder only runs when awaited.
      return await asCaller(() => inScope(current, async () => await callback(createClient(state, current))));
    } finally {
      current.open = false;
    }
  }, config));
  if (scope) settle(scope);
  return result;
}

/** Pass a committed transaction's changes to the enclosing transaction, or to the capture. */
function settle(scope: Scope): void {
  const recorder = currentCapture();
  for (const change of scope.changes ?? []) report(change, held => recorder?.change(held));
}

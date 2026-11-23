import { EventEmitter } from 'node:events';
import { PreviewSessionEndedError, PreviewStoreBusyError } from '@sendproof/core';
import type { HeldPreview } from '@sendproof/core';
import { sql } from 'drizzle-orm';
import type { DatabaseLike, ProviderState } from './capture.js';
import { asCaller, asInternal, currentScope, endedMessage, inScope } from './scope.js';
import type { Scope } from './scope.js';
import { instrumentSession } from './statements.js';
import type { PreviewTurns } from './turns.js';

const check = 'sendproof_preview_check';
const stepName = (step: number) => `sendproof_preview_step_${step}`;

export function openPreviewScope(state: ProviderState, target: DatabaseLike): Scope {
  const scope: Scope = {
    target, preview: true, open: true, outcome: { broken: false },
    ...state.safeProcedures && { safeProcedures: state.safeProcedures },
  };
  instrumentSession(target.session, state.dialect, scope);
  return scope;
}

/** Runs provider-owned SQL on the pinned Drizzle transaction. */
export async function runRaw(transaction: DatabaseLike, statement: string): Promise<unknown> {
  const execute = transaction['execute'] as (query: unknown) => Promise<unknown>;
  return asInternal(async () => await execute.call(transaction, sql.raw(statement)));
}

function transactionError(error: unknown): unknown {
  for (let depth = 0, cause = error; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) {
    const code = (cause as Error & { code?: string }).code;
    if (code === '25P03' || code === '25P04') {
      return new PreviewSessionEndedError('PostgreSQL expired the Drizzle transaction.', { cause: error });
    }
  }
  return error;
}

function storeBusy(error: unknown): boolean {
  for (let depth = 0, cause = error; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) {
    const code = (cause as Error & { code?: string }).code;
    if (code === '55P03' || cause.message === 'timeout exceeded when trying to connect') return true;
  }
  return false;
}

/** Keep the same Drizzle transaction callback alive until the session rolls back. */
export async function holdPreview(state: ProviderState, turns?: PreviewTurns): Promise<HeldPreview> {
  if (currentScope()?.preview) throw new Error('Nested Drizzle previews are unavailable.');
  const label = state.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL';
  const releaseTurn = turns?.tryAcquire();
  if (turns && !releaseTurn) throw new PreviewStoreBusyError(label);

  const ready = Promise.withResolvers<HeldPreview>();
  const finish = Promise.withResolvers<void>();
  const rollback = new Error('Sendproof requests rollback.');
  let closing = false;
  let unavailable: { error: unknown } | undefined;
  let socket: EventEmitter | undefined;
  const noteExpiry = (error: unknown) => {
    const failure = transactionError(error);
    if (failure instanceof PreviewSessionEndedError) unavailable ??= { error: failure };
  };
  const disconnected = (error: Error) => { unavailable ??= { error: transactionError(error) }; };
  const timer = setTimeout(() => {
    closing = true;
    ready.reject(new PreviewStoreBusyError(label));
    finish.resolve();
  }, 1500);
  timer.unref();

  const finished = asInternal(() => state.base.transaction(async transaction => {
    if (closing) throw rollback;
    const scope = openPreviewScope(state, transaction);
    const held: NonNullable<Scope['held']> = {};
    scope.held = held;
    scope.outcome = { broken: false, onError: noteExpiry };
    // A pg client checked out of its pool needs an error listener until it is released.
    const driver = (transaction.session as { client?: unknown }).client;
    if (driver instanceof EventEmitter && 'connectionParameters' in driver) {
      socket = driver;
      socket.on('error', disconnected);
    }
    const ownsTransaction = () => {
      if (unavailable) throw unavailable.error;
      if (closing) throw new Error(endedMessage);
      if (scope.outcome?.refused || scope.outcome?.broken) throw new Error('The Drizzle Preview transaction could not be confirmed.');
    };
    const raw = async (statement: string) => {
      try { await runRaw(transaction, statement); } catch (error) { throw transactionError(error); }
    };
    const prove = () => raw('RELEASE SAVEPOINT ' + check);
    const mark = () => raw('SAVEPOINT ' + check);
    try {
      await mark();
      if (closing) throw rollback;
      ready.resolve({
        async checkpoint(step) {
          ownsTransaction();
          await prove();
          await raw('SAVEPOINT ' + stepName(step));
          await mark();
        },
        async run(_capture, dispatch) {
          ownsTransaction();
          const step = {};
          const caller: Scope = { ...scope, step };
          held.active = step;
          try {
            return await asCaller(() => inScope(caller, async () => await dispatch()));
          } finally {
            caller.open = false;
            held.active = undefined;
          }
        },
        async verify() {
          ownsTransaction();
          // RELEASE proves the marker still exists and PostgreSQL has not marked the transaction aborted.
          await prove();
          await mark();
        },
        async rewind(step) {
          ownsTransaction();
          await raw('ROLLBACK TO SAVEPOINT ' + stepName(step));
          await raw('RELEASE SAVEPOINT ' + stepName(step));
          await mark();
        },
        async close() {
          if (!closing) {
            closing = true;
            finish.resolve();
          }
          await finished;
        },
      });
      await finish.promise;
      throw rollback;
    } finally {
      scope.open = false;
    }
  })).then(() => {
    throw new Error('The Drizzle Preview transaction returned without rolling back.');
  }).catch(error => {
    if (error === rollback) return;
    if (unavailable?.error instanceof PreviewSessionEndedError) {
      ready.reject(unavailable.error);
      return;
    }
    unavailable ??= { error: storeBusy(error) ? new PreviewStoreBusyError(label) : transactionError(error) };
    ready.reject(unavailable.error);
    throw unavailable.error;
  }).finally(() => {
    // postgres.js can settle on a socket close while its callback is still waiting. Resuming
    // that callback would tell the driver to issue a ROLLBACK on the dead socket.
    closing = true;
    socket?.off('error', disconnected);
    releaseTurn?.();
  });
  // The connection may fail between requests. Its error is reported on the next use or close.
  void finished.catch(() => {});
  try {
    return await ready.promise;
  } finally {
    clearTimeout(timer);
  }
}

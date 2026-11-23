import { PreviewSessionEndedError, PreviewStoreBusyError } from '@sendproof/core';
import type { CaptureRecorder, HeldPreview } from '@sendproof/core';
import type { QueryRunner } from 'typeorm';

interface Connection {
  inTransaction?: boolean;
  on?(event: 'error', listener: (error: { code?: string }) => void): void;
  off?(event: 'error', listener: (error: { code?: string }) => void): void;
  destroy?(): void;
}

/** TypeORM uses this depth for native nested transaction savepoints. */
export function transactionState(runner: QueryRunner): { transactionDepth: number; isTransactionActive: boolean } {
  return runner as unknown as { transactionDepth: number; isTransactionActive: boolean };
}

const acquireWaitMs = 1500;

async function acquire(runner: QueryRunner, label: string): Promise<Connection> {
  const pending: Promise<Connection> = runner.connect();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new PreviewStoreBusyError(label));
        }, acquireWaitMs);
      }),
    ]);
  } catch (error) {
    // QueryRunner has no cancellation API. A late connection is released by its own runner.
    if (timedOut) void pending.then(() => runner.release()).catch(() => {});
    else await runner.release();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Put SQLite in a write transaction before serving any step, using TypeORM's usual start bookkeeping. */
async function startSqlite(runner: QueryRunner): Promise<void> {
  const query = runner.query;
  const [{ timeout }] = await query.call(runner, 'PRAGMA busy_timeout') as { timeout: number }[];
  await query.call(runner, 'PRAGMA busy_timeout = ' + Math.min(timeout, acquireWaitMs));
  runner.query = function (text, parameters?: unknown[], structured?: true) {
    return Reflect.apply(query, this, [text === 'BEGIN TRANSACTION' ? 'BEGIN IMMEDIATE' : text, parameters, structured]);
  };
  try {
    await runner.startTransaction();
  } finally {
    runner.query = query;
    await query.call(runner, 'PRAGMA busy_timeout = ' + timeout);
  }
}

export async function openTypeOrmSession(
  runner: QueryRunner,
  label: string,
  sqlite: boolean,
  own: <T>(work: () => Promise<T>) => Promise<T>,
  enroll: (isOpen: () => boolean) => {
    run<T>(capture: CaptureRecorder, dispatch: () => Promise<T>): Promise<T>;
    refused(): boolean;
    broken(): boolean;
    restore(): void;
  },
  invalidate: () => void,
): Promise<HeldPreview> {
  const connection = await acquire(runner, label);
  let expired = false;
  const onError = ({ code }: { code?: string }) => {
    expired ||= code === '25P03' || code === '25P04' || code === 'ER_CLIENT_INTERACTION_TIMEOUT';
  };
  connection.on?.('error', onError);
  const state = transactionState(runner);
  const isOpen = () => !runner.isReleased && runner.isTransactionActive && (!sqlite || connection.inTransaction === true);
  const sql = (text: string) => own(() => runner.query(text));
  let restore: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= own(async () => {
    restore?.();
    let discarded = false;
    try {
      if (isOpen()) {
        // The whole transaction must roll back even when a handler left nested savepoints open.
        state.transactionDepth = 1;
        await runner.rollbackTransaction();
      } else if (sqlite) {
        state.transactionDepth = 0;
        state.isTransactionActive = false;
      }
    } catch (error) {
      // PostgreSQL pool clients need a release with an error; MySQL pool clients expose destroy().
      const postgres = runner as QueryRunner & { releasePostgresConnection?(error: unknown): Promise<void> };
      if (postgres.releasePostgresConnection) {
        await postgres.releasePostgresConnection(error);
        discarded = true;
      } else if (connection.destroy) {
        connection.destroy();
        discarded = true;
      } else {
        invalidate();
      }
      if (!expired) throw error;
    } finally {
      connection.off?.('error', onError);
      if (!discarded) {
        try {
          await runner.release();
        } catch (error) {
          invalidate();
          throw error;
        }
      }
    }
  });

  try {
    await own(() => sqlite ? startSqlite(runner) : runner.startTransaction());
    const handler = enroll(isOpen);
    restore = handler.restore;
    const steps = new Set<number>();
    const check = 'sendproof_preview_check';
    const assertOpen = () => {
      if (expired) throw new PreviewSessionEndedError(label);
      if (closing || !isOpen() || handler.broken()) throw new Error('The TypeORM session transaction is no longer usable.');
    };
    const command = async (text: string) => {
      assertOpen();
      try {
        await sql(text);
      } catch (error) {
        if (error instanceof Error) onError(error as Error & { code?: string });
        if (expired) throw new PreviewSessionEndedError(label);
        throw error;
      }
    };
    const nameOf = (step: number) => 'sendproof_preview_step_' + step;
    return {
      async checkpoint(step) {
        if (!Number.isSafeInteger(step) || step < 1 || steps.has(step)) throw new RangeError('Invalid TypeORM preview checkpoint.');
        await command('SAVEPOINT ' + nameOf(step));
        steps.add(step);
        await command('SAVEPOINT ' + check);
      },
      async run(capture, dispatch) {
        assertOpen();
        return handler.run(capture, dispatch);
      },
      async verify() {
        assertOpen();
        if (handler.refused()) throw new Error('The handler tried to end the TypeORM session transaction.');
        if (state.transactionDepth !== 1) throw new Error('The handler left a nested TypeORM transaction open.');
        await command('RELEASE SAVEPOINT ' + check);
      },
      async rewind(step) {
        if (handler.refused()) throw new Error('The handler tried to end the TypeORM session transaction.');
        if (!steps.has(step)) throw new RangeError('Unknown TypeORM preview checkpoint.');
        const name = nameOf(step);
        await command('ROLLBACK TO SAVEPOINT ' + name);
        state.transactionDepth = 1;
        await command('RELEASE SAVEPOINT ' + name);
        for (const saved of steps) if (saved >= step) steps.delete(saved);
      },
      close,
    };
  } catch (error) {
    await close();
    const code = (error as { code?: string; driverError?: { code?: string } } | undefined)?.driverError?.code ??
      (error as { code?: string } | undefined)?.code;
    if (sqlite && (code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED'))) throw new PreviewStoreBusyError(label);
    throw error;
  }
}

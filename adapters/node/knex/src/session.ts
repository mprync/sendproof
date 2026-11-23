import type { Knex } from 'knex';
import { PreviewSessionEndedError, PreviewStoreBusyError } from '@sendproof/core';
import type { CaptureRecorder, HeldPreview } from '@sendproof/core';
import { isTransient } from './dialect.js';
import { rowsOf } from './keys.js';
import type { Dialect } from './types.js';

interface Connection {
  __knexTxId?: string;
  __knex__disposed?: Error;
  inTransaction?: boolean;
  currentTransactionDescriptor?(): Buffer;
  on?(event: 'error', listener: (error: { code?: string }) => void): void;
  off?(event: 'error', listener: (error: { code?: string }) => void): void;
}

const acquireWaitMs = 1500;

/** Lease one pool connection, so Preview can bound acquisition without changing the host's pool. */
async function acquire(database: Knex, label: string): Promise<Connection> {
  const pending: Promise<Connection> = database.client.acquireConnection();
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
    if (timedOut) void pending.then(connection => database.client.releaseConnection(connection)).catch(() => {});
    if (error instanceof Error && error.name === 'KnexTimeoutError') throw new PreviewStoreBusyError(label);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Knex opens a deferred SQLite transaction. Rewriting the unchanged header value takes its write lock. */
async function lockSqlite(sql: (text: string) => Promise<unknown>): Promise<void> {
  const timeout = Number(rowsOf('sqlite', await sql('PRAGMA busy_timeout'))[0]?.timeout);
  const version = Number(rowsOf('sqlite', await sql('PRAGMA user_version'))[0]?.user_version);
  if (!Number.isSafeInteger(timeout) || !Number.isSafeInteger(version)) throw new Error('Could not read SQLite lock settings.');
  await sql('PRAGMA busy_timeout = ' + Math.min(timeout, acquireWaitMs));
  try {
    await sql('PRAGMA user_version = ' + version);
  } finally {
    await sql('PRAGMA busy_timeout = ' + timeout);
  }
}

function serverTransaction(rows: unknown): { id: unknown; state: unknown } {
  const row = rowsOf('mssql', rows)[0];
  return { id: row?.id, state: row?.state };
}

const sqlServerProbe = 'SELECT CAST(CURRENT_TRANSACTION_ID() AS varchar(20)) AS id, XACT_STATE() AS state';

/** The driver connection, its underlying transaction, and the step savepoints have one lifetime. */
export async function openKnexSession(
  database: Knex,
  dialect: Dialect,
  label: string,
  own: <T>(work: () => Promise<T>) => Promise<T>,
  enroll: (trx: Knex.Transaction, isOpen: () => boolean) => {
    run<T>(capture: CaptureRecorder, dispatch: () => Promise<T>): Promise<T>;
    refused(): boolean;
    broken(): boolean;
  },
): Promise<HeldPreview> {
  const connection = await acquire(database, label);
  let expired = false;
  const onError = ({ code }: { code?: string }) => {
    expired ||= code === '25P03' || code === '25P04' || code === 'ER_CLIENT_INTERACTION_TIMEOUT';
  };
  connection.on?.('error', onError);
  const release = async () => {
    connection.off?.('error', onError);
    delete connection.__knexTxId;
    await database.client.releaseConnection(connection);
  };
  let trx: Knex.Transaction;
  try {
    trx = await own(() => database.transaction(undefined as never, { connection, doNotRejectOnRollback: false }));
  } catch (error) {
    await release();
    throw error;
  }

  // Knex can swallow an error from rollback() with no argument. Confirm the driver returned our sentinel.
  const rolledBack = new Error('Sendproof closed its Knex session.');
  const completion = trx.executionPromise.then(() => undefined, (error: unknown) => error);
  const sql = (text: string) => own(async () => await trx.raw(text));
  const sqlServer = dialect === 'mssql';
  const transactionDescriptor = sqlServer ? connection.currentTransactionDescriptor?.() : undefined;
  const isOpen = () => !trx.isCompleted()
    && ((dialect !== 'sqlite' && !sqlServer) || connection.inTransaction === true)
    && (!transactionDescriptor || transactionDescriptor.equals(connection.currentTransactionDescriptor!()));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= own(async () => {
    try {
      if (!trx.isCompleted()) await trx.rollback(rolledBack);
      const outcome = await completion;
      if (outcome !== rolledBack && !(dialect === 'sqlite' && connection.inTransaction === false)) {
        throw new Error('Knex did not acknowledge the session rollback.', { cause: outcome });
      }
    } catch (error) {
      if (dialect === 'sqlite' && connection.inTransaction === false) return;
      // The pool must discard a connection whose rollback did not complete.
      connection.__knex__disposed ??= error instanceof Error ? error : new Error('Knex session rollback failed.', { cause: error });
      if (!expired) throw error;
    } finally {
      await release();
    }
  });

  try {
    if (dialect === 'sqlite') await lockSqlite(sql);
    let transactionId: unknown;
    if (sqlServer) {
      const state = serverTransaction(await sql(sqlServerProbe));
      if (state.state !== 1 || state.id === undefined) throw new Error('SQL Server did not open a usable transaction.');
      transactionId = state.id;
    }
    const handler = enroll(trx, isOpen);
    const steps = new Set<number>();
    const save = sqlServer ? 'SAVE TRANSACTION ' : 'SAVEPOINT ';
    const rewind = sqlServer ? 'ROLLBACK TRANSACTION ' : 'ROLLBACK TO SAVEPOINT ';
    const check = 'sendproof_preview_check';
    const assertOpen = () => {
      if (expired) throw new PreviewSessionEndedError(label);
      if (closing || !isOpen() || handler.broken()) throw new Error('The Knex session transaction is no longer usable.');
    };
    const command = async (text: string) => {
      assertOpen();
      try {
        return await sql(text);
      } catch (error) {
        if (error instanceof Error) onError(error as Error & { code?: string });
        if (expired) throw new PreviewSessionEndedError(label);
        throw error;
      }
    };
    const nameOf = (step: number) => 'sendproof_preview_step_' + step;
    return {
      async checkpoint(step) {
        if (!Number.isSafeInteger(step) || step < 1 || steps.has(step)) throw new RangeError('Invalid Knex preview checkpoint.');
        await command(save + nameOf(step));
        steps.add(step);
        if (!sqlServer) await command(save + check);
      },
      async run(capture, dispatch) {
        assertOpen();
        return handler.run(capture, dispatch);
      },
      async verify() {
        assertOpen();
        if (handler.refused()) throw new Error('The operation tried to end the Knex session transaction.');
        if (sqlServer) {
          const state = serverTransaction(await command(sqlServerProbe));
          if (state.state !== 1 || state.id !== transactionId) throw new Error('The SQL Server session transaction changed or became unusable.');
        } else {
          await command('RELEASE SAVEPOINT ' + check);
        }
      },
      async rewind(step) {
        if (handler.refused()) throw new Error('The operation tried to end the Knex session transaction.');
        if (!steps.has(step)) throw new RangeError('Unknown Knex preview checkpoint.');
        const name = nameOf(step);
        await command(rewind + name);
        if (!sqlServer) await command('RELEASE SAVEPOINT ' + name);
        for (const saved of steps) if (saved >= step) steps.delete(saved);
      },
      close,
    };
  } catch (error) {
    await close();
    const { code } = (error ?? {}) as { code?: string };
    if (dialect === 'sqlite' && (isTransient(error) || code?.startsWith('SQLITE_BUSY_') || code?.startsWith('SQLITE_LOCKED_'))) {
      throw new PreviewStoreBusyError(label);
    }
    throw error;
  }
}

import { PreviewSessionEndedError } from '@sendproof/core';
import type { Transaction } from '@prisma/driver-adapter-utils';

export const checkSavepoint = 'sendproof_preview_check';
export const stepSavepoint = (step: number) => `sendproof_preview_step_${step}`;

/** Use the adapter's savepoint API when it has one, since MySQL needs text protocol. */
export async function ownStatement(transaction: Transaction, sql: string): Promise<unknown> {
  const savepoint = /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) ([a-z_0-9]+)$/.exec(sql);
  if (savepoint) {
    const [, command, name] = savepoint;
    if (command === 'SAVEPOINT' && transaction.createSavepoint) return transaction.createSavepoint(name);
    if (command === 'ROLLBACK TO SAVEPOINT' && transaction.rollbackToSavepoint) return transaction.rollbackToSavepoint(name);
    if (command === 'RELEASE SAVEPOINT' && transaction.releaseSavepoint) return transaction.releaseSavepoint(name);
  }
  return transaction.executeRaw({ sql, args: [], argTypes: [] });
}

/** Replace Prisma's empty deferred transaction while its driver still owns the SQLite connection. */
export async function takeSQLiteWriteLock(transaction: Transaction): Promise<void> {
  const pragma = (sql: string) => transaction.queryRaw({ sql, args: [], argTypes: [] });
  const { rows: [[busyTimeout]] } = await pragma('PRAGMA busy_timeout');
  await pragma('PRAGMA busy_timeout = 0');
  try {
    await ownStatement(transaction, 'ROLLBACK');
    try {
      await ownStatement(transaction, 'BEGIN IMMEDIATE');
    } catch (error) {
      // Prisma still owns the driver lease and expects a transaction to roll back when the callback fails.
      await ownStatement(transaction, 'BEGIN');
      throw error;
    }
  } finally {
    await pragma('PRAGMA busy_timeout = ' + Number(busyTimeout));
  }
}

export function isStoreBusy(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 8 && current && typeof current === 'object'; depth++) {
    const info = current as { code?: string; originalCode?: string; cause?: unknown; message?: string };
    const code = info.originalCode ?? info.code;
    if (code === '55P03' || code === 'P2024' || /^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(code ?? '')) return true;
    if (code === 'P2028' && /unable to start a transaction|start.*timed out/i.test(info.message ?? '')) return true;
    current = info.cause;
  }
  return false;
}

export function sessionError(error: unknown): unknown {
  for (let depth = 0, current = error; depth < 8 && current && typeof current === 'object'; depth++) {
    const info = current as { code?: string; originalCode?: string; cause?: unknown; message?: string };
    const code = info.originalCode ?? info.code;
    if (code === '25P03' || code === '25P04' || (code === 'P2028' && /expired transaction|transaction has expired/i.test(info.message ?? ''))) {
      return new PreviewSessionEndedError('The Prisma Preview transaction expired.', { cause: error });
    }
    current = info.cause;
  }
  return error;
}

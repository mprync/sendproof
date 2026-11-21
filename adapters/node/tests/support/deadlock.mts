/**
 * Deadlocks a MySQL Preview against a second connection, for the rule in spec/data-stores.md "Transaction-control
 * statements from the handler": a deadlock rolls the whole Preview transaction back, so a retried write would run
 * with autocommit and commit for real. Every provider must refuse the retry and fail the Preview.
 */
import mysql from 'mysql2/promise';

export interface DeadlockScenario {
  /** The test database, as `SELECT DATABASE()` answers on the provider's connection. */
  database: string;
  /** The text column of `items` besides `id`. */
  column: string;
  /** Runs `work` in a Preview and settles as the Preview does. */
  preview(work: () => Promise<void>): Promise<unknown>;
  /** Updates item `id` through the provider, inside the Preview. */
  update(id: string): Promise<unknown>;
  /** Inserts item `id` through the provider, inside the Preview: the ORM's retry. */
  insert(id: string): Promise<unknown>;
}

export interface DeadlockOutcome {
  /** What the Preview settled with: its error, or undefined when it resolved. */
  previewError: unknown;
  /** The error the Preview's update got, which must be the deadlock. */
  deadlock: unknown;
  /** The error the retried insert got, which must be a refusal. */
  retry: unknown;
  /** Rows with id `retried` after everything settled: must be 0. */
  retried: number;
}

const settle = async (run: () => Promise<unknown>): Promise<unknown> => {
  try { await run(); return undefined; } catch (error) { return error; }
};

/**
 * The Preview updates `a`, the other transaction updates `b` and many other rows, then waits for `a`; the Preview's
 * update of `b` closes the cycle, and InnoDB rolls back the Preview, which changed fewer rows.
 */
export async function deadlockPreview(scenario: DeadlockScenario): Promise<DeadlockOutcome> {
  const url = new URL(process.env['BENCH_MYSQL_URL']!);
  url.pathname = '/' + scenario.database;
  const admin = await mysql.createConnection(url.toString());
  const other = await mysql.createConnection(url.toString());
  try {
    const column = scenario.column;
    await admin.query(`DELETE FROM items`);
    await admin.query(`INSERT INTO items (id, ${column}) VALUES ('a', 'A'), ('b', 'B')`);
    for (let n = 0; n < 300; n++) await admin.query(`INSERT INTO items (id, ${column}) VALUES (?, 'F')`, ['filler' + n]);
    let written!: () => void;
    const wrote = new Promise<void>(resolve => { written = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let deadlock: unknown;
    let retry: unknown;
    const previewed = settle(() => scenario.preview(async () => {
      await scenario.update('a');
      written();
      await resumed;
      deadlock = await settle(() => scenario.update('b'));
      retry = await settle(() => scenario.insert('retried'));
    }));
    await wrote;
    await other.query('START TRANSACTION');
    await other.query(`UPDATE items SET ${column} = 'Other' WHERE id = 'b' OR id LIKE 'filler%'`);
    const waiting = other.query(`UPDATE items SET ${column} = 'Other' WHERE id = 'a'`).then(() => other.query('ROLLBACK'));
    await new Promise(resolve => setTimeout(resolve, 300));
    resume();
    const previewError = await previewed;
    await waiting;
    const [rows] = await admin.query(`SELECT COUNT(*) AS n FROM items WHERE id = 'retried'`);
    const retried = Number((rows as { n: unknown }[])[0]!.n);
    await admin.query(`DELETE FROM items`);
    return { previewError, deadlock, retry, retried };
  } finally {
    await other.end();
    await admin.end();
  }
}

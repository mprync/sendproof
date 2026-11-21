/**
 * Deadlocks a Preview against a second connection, for the rule in spec/data-stores.md "Transaction-control
 * statements from the handler": a MySQL deadlock or SQL Server deadlock victim rolls the whole Preview transaction
 * back, so a retried write would run with autocommit and commit for real. Every provider must refuse the retry and
 * fail the Preview.
 */
import mysql from 'mysql2/promise';

/** A connection outside the Preview, for seeding, reading and the competing transaction. */
export interface Connection {
  query(sql: string): Promise<unknown>;
  /** Rows of a `SELECT COUNT(*) AS n` query. */
  count(sql: string): Promise<number>;
  begin(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}

export interface DeadlockScenario {
  /** The test database, as `SELECT DATABASE()` answers on the provider's connection (MySQL, without `connect`). */
  database?: string;
  /** Opens a connection outside the Preview; MySQL scenarios default to one over `BENCH_MYSQL_URL`. */
  connect?: () => Promise<Connection>;
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

/** A mysql2 connection to the scenario's database. */
async function mysqlConnection(database: string): Promise<Connection> {
  const url = new URL(process.env['BENCH_MYSQL_URL']!);
  url.pathname = '/' + database;
  const connection = await mysql.createConnection(url.toString());
  return {
    query: sql => connection.query(sql),
    count: async sql => Number(((await connection.query(sql))[0] as { n: unknown }[])[0]!.n),
    begin: async () => { await connection.query('START TRANSACTION'); },
    rollback: async () => { await connection.query('ROLLBACK'); },
    end: () => connection.end(),
  };
}

/**
 * The Preview updates `a`, the other transaction updates `b` and many other rows, then waits for `a`; the Preview's
 * update of `b` closes the cycle, and the database rolls back the Preview, which changed fewer rows.
 */
export async function deadlockPreview(scenario: DeadlockScenario): Promise<DeadlockOutcome> {
  const connect = scenario.connect ?? (() => mysqlConnection(scenario.database!));
  const admin = await connect();
  const other = await connect();
  try {
    const column = scenario.column;
    await admin.query('DELETE FROM items');
    const fillers = Array.from({ length: 300 }, (_, n) => `('filler${n}', 'F')`);
    await admin.query(`INSERT INTO items (id, ${column}) VALUES ('a', 'A'), ('b', 'B')`);
    for (let start = 0; start < fillers.length; start += 100) {
      await admin.query(`INSERT INTO items (id, ${column}) VALUES ${fillers.slice(start, start + 100).join(', ')}`);
    }
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
    await other.begin();
    await other.query(`UPDATE items SET ${column} = 'Other' WHERE id = 'b' OR id LIKE 'filler%'`);
    const waiting = other.query(`UPDATE items SET ${column} = 'Other' WHERE id = 'a'`).then(() => other.rollback());
    await new Promise(resolve => setTimeout(resolve, 300));
    resume();
    const previewError = await previewed;
    await waiting;
    const retried = await admin.count(`SELECT COUNT(*) AS n FROM items WHERE id = 'retried'`);
    await admin.query('DELETE FROM items');
    return { previewError, deadlock, retry, retried };
  } finally {
    await other.end();
    await admin.end();
  }
}

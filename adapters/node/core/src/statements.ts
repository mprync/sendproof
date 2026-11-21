/**
 * Lightweight SQL statement classification shared by the database providers to decide whether
 * a Preview stayed inside its rolled-back transaction. The checks are deliberately
 * conservative: an unrecognised statement that might write is treated as a write, which can
 * only withhold confirmation or refuse the statement.
 */

/**
 * Database family of a connection. Only `mysql` changes the rules (implicit commits); the
 * other names are accepted for readability at the call site.
 */
export type AdapterProvider = 'sqlite' | 'postgres' | 'mysql' | 'sqlserver' | (string & {});

/** MySQL and MariaDB run the body of `/*! ... *\/` and `/*M! ... *\/` comments as SQL. */
const executableComment = /^\/\*M?!\d*/;

/**
 * How a server reads SQL text: which comments and quotes it knows, and whether a backslash escapes
 * a quote. A session setting the provider can't see decides some of this (MySQL
 * `NO_BACKSLASH_ESCAPES` and `ANSI_QUOTES`, PostgreSQL `standard_conforming_strings`), so the
 * guard reads a text every way its server might and refuses it when any reading finds a refused
 * statement. An extra reading can only add refusals.
 */
interface Reading {
  /** `#` starts a comment to the end of the line (MySQL and MariaDB). */
  hash: boolean;
  /** `--` starts a comment only when whitespace or a control character follows (MySQL); otherwise always. */
  dashNeedsSpace: boolean;
  /** The bodies of `/*! ... *\/` and `/*M! ... *\/` comments run as SQL (MySQL and MariaDB). */
  executable: boolean;
  /** `$tag$ ... $tag$` quotes a string (PostgreSQL). */
  dollar: boolean;
  /** Block comments nest (PostgreSQL). */
  nested: boolean;
  /** `E'...'` strings take backslash escapes whatever the session says (PostgreSQL). */
  escapeStrings: boolean;
  /** A backslash escapes the next character inside `'...'` and `"..."`. */
  backslash: boolean;
}

const plain = { hash: false, dashNeedsSpace: false, executable: false, dollar: false, nested: false, escapeStrings: false };
const mysqlReading = { ...plain, hash: true, dashNeedsSpace: true, executable: true };
const postgresReading = { ...plain, dollar: true, nested: true, escapeStrings: true };

/**
 * Every way the provider's server might read a text; the first is the usual one. SQLite and SQL
 * Server read it plainly. An unknown server, or none named, is read every way, since refusing more
 * is the safe side.
 */
function readingsOf(provider: AdapterProvider | undefined): Reading[] {
  const both = (base: Omit<Reading, 'backslash'>, first: boolean): Reading[] =>
    [{ ...base, backslash: first }, { ...base, backslash: !first }];
  if (provider === 'mysql' || provider === 'mariadb') return both(mysqlReading, true);
  if (provider === 'postgres' || provider === 'postgresql' || provider === 'cockroachdb') return both(postgresReading, false);
  if (provider === 'sqlite' || provider === 'sqlserver' || provider === 'mssql') return both(plain, false);
  return [...both(plain, false), ...both(mysqlReading, true), ...both(postgresReading, false)];
}

/**
 * Split SQL text into statements as the provider's server reads it, ignoring separators inside
 * quotes and comments.
 *
 * The body of a MySQL executable comment is kept as statement text, because the server runs it:
 * `/*!COMMIT*\/` is a COMMIT, not a comment. Without a provider the text is read the way SQLite
 * and SQL Server read it.
 */
export function splitStatements(sql: string, provider?: AdapterProvider): string[] {
  return splitWith(sql, readingsOf(provider)[0]!);
}

function splitWith(sql: string, reading: Reading): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  let executable = false;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (executable && char === '*' && next === '/') {
      executable = false;
      index += 2;
      current += ' ';
      continue;
    }
    const dashComment = char === '-' && next === '-'
      && (!reading.dashNeedsSpace || index + 2 >= sql.length || /[\s\x00-\x1f]/.test(sql[index + 2]!));
    if (dashComment || (reading.hash && char === '#')) {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      current += ' ';
      continue;
    }
    const opener = reading.executable && char === '/' && next === '*' && !executable
      ? executableComment.exec(sql.slice(index, index + 16))?.[0] : undefined;
    if (opener) {
      executable = true;
      index += opener.length;
      current += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      index = closingComment(sql, index, reading.nested);
      current += ' ';
      continue;
    }
    const escapeString = reading.escapeStrings && (char === 'E' || char === 'e') && next === "'"
      && (index === 0 || !/[\w$]/.test(sql[index - 1]!));
    if (escapeString) {
      const end = closingQuote(sql, index + 1, "'", true);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = closingQuote(sql, index, char, reading.backslash && char !== '`');
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (reading.dollar && char === '$' && (index === 0 || !/[\w$]/.test(sql[index - 1]!))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** The index after a quoted string or identifier that opens at `start`. A doubled quote stays inside it. */
function closingQuote(sql: string, start: number, quote: string, backslash: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    if (backslash && sql[index] === '\\') {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index++;
  }
  return sql.length;
}

/** The index after a block comment that opens at `start`; PostgreSQL's nest. */
function closingComment(sql: string, start: number, nested: boolean): number {
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth = nested ? depth + 1 : 1;
      index += 2;
      continue;
    }
    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth--;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index++;
  }
  return sql.length;
}

const transactionControl =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i;

/**
 * `SET autocommit = 1` commits and leaves every later statement outside a transaction. It can appear anywhere in a
 * `SET` assignment list (`SET sql_mode = '', autocommit = 1`), so any `SET` naming `autocommit` is refused. That also
 * refuses the rare `SET @note = 'autocommit'`, which errs on the safe side.
 */
const setAutocommit = /^SET\b[\s\S]*\bAUTOCOMMIT\b/i;

// MySQL commits the open transaction before (and after) these statements.
// https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
const mysqlImplicitCommit =
  /^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|CHECK\s+TABLE|OPTIMIZE|REPAIR|FLUSH|INSTALL|UNINSTALL|IMPORT\s+TABLE|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|(?:START|STOP)\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|CHANGE\s+(?:REPLICATION|MASTER))\b/i;
const mysqlTemporaryTable = /^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i;
/**
 * SQL-level prepared statements run text the provider can't see at `EXECUTE` time, and MySQL allows `COMMIT` and DDL
 * in them, so both halves are refused on MySQL. Drivers prepare through the binary protocol, never with this SQL.
 */
const mysqlPreparedSql = /^(?:PREPARE|EXECUTE)\b/i;
/** MariaDB's `SET STATEMENT var = value [, ...] FOR <statement>` runs the inner statement; it is checked on its own. */
const mysqlSetStatement = /^SET\s+STATEMENT\b[\s\S]*?\bFOR\s+([\s\S]+)$/i;
/** A `CALL` and the procedure name after it, as one or two bare or backtick-quoted identifiers. */
const mysqlCall = /^CALL\b/i;
const identifier = '(?:`(?:[^`]|``)+`|[A-Za-z0-9_$]+)';
const procedureName = new RegExp(`^(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?=\\s*(?:\\(|$))`);

/** Removes the backticks from one identifier, so `` `p` `` and `p` name the same procedure. */
const unquote = (part: string): string => part.startsWith('`') ? part.slice(1, -1).replaceAll('``', '`') : part;

/** The procedure a `CALL` statement names, as `name` or `schema.name`, or undefined when it can't be read. */
function calledProcedure(statement: string): string | undefined {
  const match = procedureName.exec(statement.replace(mysqlCall, '').trim());
  if (!match) return undefined;
  return match[2] === undefined ? unquote(match[1]!) : unquote(match[1]!) + '.' + unquote(match[2]);
}

/**
 * Checks and copies the stored procedures a host declares never commit, for MySQL and MariaDB `CALL`.
 *
 * Names are exact, as `name` or `schema.name`, optionally backtick-quoted. Backticks are removed and the match ignores
 * case, as MySQL routine names do, so `CALL AUDIT()` is the declared `audit`; a schema-qualified call matches only a
 * declaration with that schema, so `CALL other.name()` is a different procedure from `name`. Wildcards, spaces and
 * argument lists are refused. Declaring a procedure is the host's statement that it never runs `COMMIT` or an
 * implicitly committing statement; one that does would end the Preview transaction (the start-savepoint check then
 * fails the Preview, but the commit has already happened).
 */
export function safeProcedureNames(names: Iterable<string> = []): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const name of names) {
    const match = typeof name === 'string' ? procedureName.exec(name.trim()) : null;
    if (!match || match[0] !== name.trim()) {
      throw new TypeError(`Safe procedure names are exact names, such as "name" or "schema.name": ${JSON.stringify(name)}`);
    }
    declared.add((match[2] === undefined ? unquote(match[1]!) : unquote(match[1]!) + '.' + unquote(match[2])).toLowerCase());
  }
  return declared;
}

/** Whether one statement, already split, would end or escape the Preview transaction. */
function refuses(statement: string, provider: AdapterProvider, safeProcedures: ReadonlySet<string>): boolean {
  if (transactionControl.test(statement) || setAutocommit.test(statement)) return true;
  // Every provider's backstop relies on its own savepoint, so a handler may not touch it.
  if (previewSavepointStatement.test(statement)) return true;
  if (provider !== 'mysql') return false;
  const inner = mysqlSetStatement.exec(statement)?.[1];
  if (inner !== undefined) return refuses(inner.trim(), provider, safeProcedures);
  if (mysqlCall.test(statement)) {
    const name = calledProcedure(statement);
    return name === undefined || !safeProcedures.has(name.toLowerCase());
  }
  return mysqlPreparedSql.test(statement) || (mysqlImplicitCommit.test(statement) && !mysqlTemporaryTable.test(statement));
}

const noProcedures: ReadonlySet<string> = new Set();

/**
 * The first statement in `sql` that would end or escape the Preview transaction, or undefined when there is none.
 *
 * That is any explicit transaction control (`COMMIT`, `ROLLBACK` without `TO`, `BEGIN`, `XA`), `SET autocommit`, and on
 * MySQL and MariaDB every implicitly committing statement and every `CALL` except to a procedure in `safeProcedures`
 * (see {@link safeProcedureNames}). Savepoint statements are allowed because ORMs use them for nested transactions.
 */
export function refusedStatement(sql: string, provider: AdapterProvider, safeProcedures: ReadonlySet<string> = noProcedures): string | undefined {
  // Refused when any way the server might read the text finds a refused statement.
  for (const reading of readingsOf(provider)) {
    const refused = splitWith(sql, reading).find(statement => refuses(statement, provider, safeProcedures));
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/**
 * Whether a driver error means the database rolled the whole transaction back, so later statements would run outside
 * it and, with autocommit, a retried write would commit for real (spec/data-stores.md "Transaction-control statements
 * from the handler"): a MySQL or MariaDB deadlock (1213) or lock wait timeout (1205, which rolls back with
 * `innodb_rollback_on_timeout`; the provider can't see the setting, so it counts either way), or a SQL Server deadlock
 * victim (1205). The error may be wrapped by an ORM, so its causes are searched too.
 */
export function rollsBackTransaction(error: unknown, provider: AdapterProvider): boolean {
  const mysql = provider === 'mysql' || provider === 'mariadb';
  const mssql = provider === 'mssql' || provider === 'sqlserver';
  if (!mysql && !mssql) return false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    // mysql2 and mssql name the code `errno`, `code` or `number`; Prisma's driver adapters keep it as `originalCode`.
    const fields = current as {
      errno?: unknown; code?: unknown; number?: unknown; originalCode?: unknown; cause?: unknown; driverError?: unknown; originalError?: unknown;
    };
    const numbers = [fields.errno, fields.number, fields.code, fields.originalCode].map(value => Number(value));
    if (mysql && (numbers.includes(1213) || numbers.includes(1205) || fields.code === 'ER_LOCK_DEADLOCK' || fields.code === 'ER_LOCK_WAIT_TIMEOUT')) return true;
    if (mssql && numbers.includes(1205)) return true;
    current = fields.driverError ?? fields.originalError ?? fields.cause;
  }
  return false;
}

/**
 * The savepoint behind the commit backstop of spec/data-stores.md "Transaction-control statements from the handler",
 * which every SQL provider sets. No ORM generates this name, and a handler may not set, release or roll back to it
 * during a Preview.
 */
export const previewSavepoint = 'sendproof_preview';

/** A handler's savepoint statement naming {@link previewSavepoint}, including SQL Server's `SAVE TRANSACTION`. */
const previewSavepointStatement =
  /^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?|SAVE\s+TRAN(?:SACTION)?)\s+[`"[]?sendproof_preview[`"\]]?$/i;

const isSqlServer = (provider: AdapterProvider): boolean => provider === 'mssql' || provider === 'sqlserver';

/**
 * Sets {@link previewSavepoint} through `run`, which sends one statement on the Preview connection. Providers call it
 * right after opening the Preview transaction, and {@link previewSavepointHeld} before rolling back. SQL Server names
 * its savepoints with `SAVE TRANSACTION`.
 */
export async function setPreviewSavepoint(run: (sql: string) => Promise<unknown>, provider: AdapterProvider): Promise<void> {
  await run(isSqlServer(provider) ? 'SAVE TRANSACTION ' + previewSavepoint : 'SAVEPOINT ' + previewSavepoint);
}

/**
 * Whether nothing committed the Preview transaction since {@link setPreviewSavepoint}. Any failure answers false, since
 * it can't confirm the transaction is the Preview's, and the Preview then answers 500.
 *
 * MySQL, MariaDB, PostgreSQL and SQLite release the savepoint set when the Preview started: any commit, explicit or
 * implicit, erases every savepoint, so the release fails. Checking the start savepoint, rather than whether some
 * transaction is open now, also holds under MySQL `autocommit=0`, where a new transaction opens after a commit.
 *
 * SQL Server can't release a savepoint, so `@@TRANCOUNT` must still count the Preview transaction. `rows` reads the
 * result rows from what `run` answers for that query.
 */
export async function previewSavepointHeld(
  run: (sql: string) => Promise<unknown>,
  provider: AdapterProvider,
  rows: (result: unknown) => readonly Record<string, unknown>[] = result => result as Record<string, unknown>[],
): Promise<boolean> {
  try {
    if (isSqlServer(provider)) {
      const [row] = rows(await run('SELECT @@TRANCOUNT AS open_transactions, XACT_STATE() AS state'));
      return Number(row?.['open_transactions']) >= 1;
    }
    await run('RELEASE SAVEPOINT ' + previewSavepoint);
    return true;
  } catch (error) {
    // A PostgreSQL transaction a failed statement aborted (25P02) is still the open Preview transaction: a COMMIT in
    // that state only rolls back, so nothing could have committed. It refuses every statement, the release included.
    return (provider === 'postgres' || provider === 'postgresql') && sqlState(error) === '25P02';
  }
}

/** The SQLSTATE of a driver error, or of the error an ORM wrapped. */
function sqlState(error: unknown): unknown {
  const value = error as { code?: unknown; cause?: { code?: unknown }; driverError?: { code?: unknown } } | null;
  return value?.code ?? value?.driverError?.code ?? value?.cause?.code;
}

const readOnly = /^(?:SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|PRAGMA|VALUES|SET\s+(?:SESSION\s+)?TRANSACTION\b)/i;
const writingSelect = /\b(?:INTO|FOR\s+UPDATE|FOR\s+SHARE|NEXTVAL|SETVAL)\b/i;

/**
 * Whether a statement executed inside the Preview transaction can end or replace it (see {@link refusedStatement}).
 * Savepoint statements are allowed because Prisma uses them for nested transactions.
 */
export function endsTransaction(sql: string, provider: AdapterProvider, safeProcedures?: ReadonlySet<string>): boolean {
  return refusedStatement(sql, provider, safeProcedures) !== undefined;
}

/**
 * Whether a statement could change durable state when it runs outside the Preview
 * transaction. Plain reads are allowed; everything else is treated as a write, under any way the
 * provider's server might read the text.
 */
export function mayWrite(sql: string, provider?: AdapterProvider): boolean {
  return readingsOf(provider).some(reading => splitWith(sql, reading).some(statement => !readOnly.test(statement)
    || (/^SELECT\b/i.test(statement) && writingSelect.test(statement))));
}

/** Whether a statement is the physical ROLLBACK Prisma issues to finish a transaction. */
export function isRollback(sql: string): boolean {
  const statements = splitStatements(sql);
  return statements.length === 1 && /^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements[0]!);
}

const savepoint = /^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO)\b/i;

/**
 * Whether every statement only begins, ends or marks a transaction, without touching rows, under
 * every way the provider's server might read the text.
 */
export function controlsTransaction(sql: string, provider?: AdapterProvider): boolean {
  return readingsOf(provider).every(reading => {
    const statements = splitWith(sql, reading);
    return statements.length > 0 && statements.every(statement => transactionControl.test(statement)
      || setAutocommit.test(statement) || savepoint.test(statement));
  });
}

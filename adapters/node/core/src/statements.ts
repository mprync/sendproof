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
 * Split SQL text into statements, ignoring separators inside quotes and comments.
 *
 * The body of a MySQL executable comment is kept as statement text, because the server runs it:
 * `/*!COMMIT*\/` is a COMMIT, not a comment.
 */
export function splitStatements(sql: string): string[] {
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
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      current += ' ';
      continue;
    }
    const opener = char === '/' && next === '*' && !executable ? executableComment.exec(sql.slice(index, index + 16))?.[0] : undefined;
    if (opener) {
      executable = true;
      index += opener.length;
      current += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = closingQuote(sql, index, char);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '$' && sql[index - 1] !== undefined && /[\w$]/.test(sql[index - 1]!)) {
      current += char;
      index++;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index))?.[0];
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

function closingQuote(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '\\' && quote !== '"') {
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
 * Names are exact, as `name` or `schema.name`, optionally backtick-quoted, and compared case-sensitively with the name
 * a `CALL` uses: `CALL other.name()` is a different procedure from `name`. Wildcards, spaces and argument lists are
 * refused. Declaring a procedure is the host's statement that it never runs `COMMIT` or an implicitly committing
 * statement; one that does would end the Preview transaction (the `@@in_transaction` check then fails the Preview,
 * but the commit has already happened).
 */
export function safeProcedureNames(names: Iterable<string> = []): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const name of names) {
    const match = typeof name === 'string' ? procedureName.exec(name.trim()) : null;
    if (!match || match[0] !== name.trim()) {
      throw new TypeError(`Safe procedure names are exact names, such as "name" or "schema.name": ${JSON.stringify(name)}`);
    }
    declared.add(match[2] === undefined ? unquote(match[1]!) : unquote(match[1]!) + '.' + unquote(match[2]));
  }
  return declared;
}

/** Whether one statement, already split, would end or escape the Preview transaction. */
function refuses(statement: string, provider: AdapterProvider, safeProcedures: ReadonlySet<string>): boolean {
  if (transactionControl.test(statement) || setAutocommit.test(statement)) return true;
  if (provider !== 'mysql') return false;
  if (previewSavepointStatement.test(statement)) return true;
  const inner = mysqlSetStatement.exec(statement)?.[1];
  if (inner !== undefined) return refuses(inner.trim(), provider, safeProcedures);
  if (mysqlCall.test(statement)) {
    const name = calledProcedure(statement);
    return name === undefined || !safeProcedures.has(name);
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
  return splitStatements(sql).find(statement => refuses(statement, provider, safeProcedures));
}

/**
 * The savepoint behind the MySQL and MariaDB backstop of spec/data-stores.md "Transaction-control statements from the
 * handler". No ORM generates this name, and a handler may not set, release or roll back to it during a Preview.
 */
export const previewSavepoint = 'sendproof_preview';

/** A handler's `SAVEPOINT`, `RELEASE SAVEPOINT` or `ROLLBACK TO SAVEPOINT` naming {@link previewSavepoint}. */
const previewSavepointStatement =
  /^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?)\s+[`"]?sendproof_preview[`"]?$/i;

/**
 * Sets {@link previewSavepoint} through `run`, which sends one statement on the Preview connection. Providers call it
 * on MySQL and MariaDB right after opening the Preview transaction, and {@link previewSavepointHeld} before rolling back.
 */
export async function setPreviewSavepoint(run: (sql: string) => Promise<unknown>): Promise<void> {
  await run('SAVEPOINT ' + previewSavepoint);
}

/**
 * Whether the savepoint {@link setPreviewSavepoint} set when the Preview started still exists, which proves nothing
 * committed the Preview transaction. Any commit, explicit or implicit, erases every savepoint, so the release fails with
 * error 1305. Checking the start savepoint, rather than whether some transaction is open now, also holds under
 * `autocommit=0`, where MySQL opens a new transaction implicitly after a commit. Any failure answers false, since it
 * can't confirm the transaction is the Preview's.
 */
export async function previewSavepointHeld(run: (sql: string) => Promise<unknown>): Promise<boolean> {
  try {
    await run('RELEASE SAVEPOINT ' + previewSavepoint);
    return true;
  } catch {
    return false;
  }
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
 * transaction. Plain reads are allowed; everything else is treated as a write.
 */
export function mayWrite(sql: string): boolean {
  return splitStatements(sql).some(statement => !readOnly.test(statement)
    || (/^SELECT\b/i.test(statement) && writingSelect.test(statement)));
}

/** Whether a statement is the physical ROLLBACK Prisma issues to finish a transaction. */
export function isRollback(sql: string): boolean {
  const statements = splitStatements(sql);
  return statements.length === 1 && /^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?$/i.test(statements[0]!);
}

const savepoint = /^(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO)\b/i;

/** Whether every statement only begins, ends or marks a transaction, without touching rows. */
export function controlsTransaction(sql: string): boolean {
  const statements = splitStatements(sql);
  return statements.length > 0 && statements.every(statement => transactionControl.test(statement)
    || setAutocommit.test(statement) || savepoint.test(statement));
}

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
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i;

// MySQL commits the open transaction before (and after) these statements.
// https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
const mysqlImplicitCommit =
  /^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|START\s+REPLICA|STOP\s+REPLICA|CHANGE\s+REPLICATION)\b/i;
const mysqlTemporaryTable = /^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i;

const readOnly = /^(?:SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|PRAGMA|VALUES|SET\s+(?:SESSION\s+)?TRANSACTION\b)/i;
const writingSelect = /\b(?:INTO|FOR\s+UPDATE|FOR\s+SHARE|NEXTVAL|SETVAL)\b/i;

/**
 * Whether a statement executed inside the Preview transaction can end or replace it.
 * Savepoint statements are allowed because Prisma uses them for nested transactions.
 */
export function endsTransaction(sql: string, provider: AdapterProvider): boolean {
  return splitStatements(sql).some(statement => transactionControl.test(statement)
    || (provider === 'mysql' && mysqlImplicitCommit.test(statement) && !mysqlTemporaryTable.test(statement)));
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
  return statements.length > 0 && statements.every(statement => transactionControl.test(statement) || savepoint.test(statement));
}

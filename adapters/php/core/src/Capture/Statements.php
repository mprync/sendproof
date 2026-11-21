<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

/**
 * Lightweight SQL statement classification for the transaction-control rule of
 * spec/data-stores.md: during a Preview a provider refuses, before it reaches the database, any
 * statement that would end or escape the Preview transaction. The check is deliberately
 * conservative: an unrecognised statement that might end the transaction is refused.
 *
 * On MySQL and MariaDB `CALL` is refused too, because a stored procedure can commit, unless the
 * host declared the procedure safe by exact name; so are SQL-level `PREPARE` and `EXECUTE`, which
 * run statement text the guard never saw.
 *
 * Quotes and comments are read the way each server reads them by default: on MySQL backslashes
 * escape inside every string, `#` starts a comment and `--` does only when a space follows;
 * elsewhere a standard string has no backslash escapes (PostgreSQL's `E'...'` strings do) and
 * `$tag$` quotes a body. A literal that ended later than the server's would hide a statement the
 * server runs.
 */
final class Statements
{
    /** MySQL and MariaDB run the body of `/*! ... *\/` and `/*M! ... *\/` comments as SQL. */
    private const EXECUTABLE_COMMENT = '/^\/\*M?!\d*/';

    private const TRANSACTION_CONTROL = '/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i';

    /** A `SET` that changes autocommit anywhere in its list (`SET sql_mode = '', autocommit = 1`). */
    private const SET_AUTOCOMMIT = '/^SET\b.*(?<![\w$])AUTOCOMMIT\b/is';

    /** MySQL commits the open transaction before (and after) these statements. https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html */
    private const MYSQL_IMPLICIT_COMMIT = '/^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|CHECK\s+TABLES?|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|SET\s+DEFAULT\s+ROLE|START\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|STOP\s+(?:REPLICA|SLAVE|GROUP_REPLICATION)|CHANGE\s+(?:REPLICATION|MASTER)|IMPORT\s+TABLE|CLONE)\b/i';
    private const MYSQL_TEMPORARY_TABLE = '/^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i';

    /** SQL-level `PREPARE ... FROM` and `EXECUTE` (also MariaDB's `EXECUTE IMMEDIATE`): they run text the guard never sees. */
    private const MYSQL_EXECUTE = '/^(?:PREPARE|EXECUTE)\b/i';

    /** `CALL name`, `CALL schema.name`, with or without backticks; the name is captured. */
    private const MYSQL_CALL = '/^CALL\s+((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)/i';
    private const MYSQL_CALL_KEYWORD = '/^CALL\b/i';

    /** A declared safe procedure: a plain name, optionally qualified with its schema. */
    private const PROCEDURE_NAME = '/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/D';

    /**
     * Whether a statement executed inside the Preview transaction can end or replace it.
     * Savepoint statements are allowed, because ORMs use them for nested transactions. `$mysql`
     * adds the statements MySQL and MariaDB commit implicitly, `CALL` and `EXECUTE`.
     *
     * @param list<string> $safeProcedures lower-cased names from {@see normalizeProcedures()}
     * @param string|null $reserved a savepoint the provider owns: the handler may not release or roll back to it
     */
    public static function endsTransaction(string $sql, bool $mysql = false, array $safeProcedures = [], ?string $reserved = null): bool
    {
        return self::reason($sql, $mysql, $safeProcedures, $reserved) !== null;
    }

    /**
     * Why `$sql` would end or escape the Preview transaction, or null when it is safe.
     *
     * @param list<string> $safeProcedures
     */
    public static function reason(string $sql, bool $mysql = false, array $safeProcedures = [], ?string $reserved = null): ?string
    {
        foreach (self::split($sql, $mysql) as $statement) {
            $verb = strtoupper((string) strtok($statement, " \t\r\n("));
            if (preg_match(self::TRANSACTION_CONTROL, $statement) === 1 || preg_match(self::SET_AUTOCOMMIT, $statement) === 1) {
                return "the handler's {$verb} would end the Preview transaction";
            }
            if ($reserved !== null && preg_match('/^(?:RELEASE|ROLLBACK|SAVEPOINT)\b/i', $statement) === 1
                && preg_match('/(?<![\w$])`?' . preg_quote($reserved, '/') . '`?(?![\w$])/i', $statement) === 1) {
                return "the Preview's own savepoint is reserved for Sendproof";
            }
            if (!$mysql) {
                continue;
            }
            if (preg_match(self::MYSQL_CALL_KEYWORD, $statement) === 1) {
                if (preg_match(self::MYSQL_CALL, $statement, $match) === 1 && in_array(self::procedureKey($match[1]), $safeProcedures, true)) {
                    continue;
                }

                return 'a CALL can commit the Preview transaction inside the procedure; declare the procedure safe by exact name if it never commits';
            }
            if (preg_match(self::MYSQL_EXECUTE, $statement) === 1) {
                return "the handler's {$verb} runs a statement the Preview can't check";
            }
            if (preg_match(self::MYSQL_IMPLICIT_COMMIT, $statement) === 1 && preg_match(self::MYSQL_TEMPORARY_TABLE, $statement) !== 1) {
                return "the handler's {$verb} commits implicitly on MySQL";
            }
        }

        return null;
    }

    /**
     * Checks and lower-cases the host's declared safe procedures. MySQL and MariaDB procedure names
     * are case-insensitive, so `Refresh_Totals` and `refresh_totals` are one procedure. Exact names
     * only: wildcards and quoting are rejected rather than guessed at.
     *
     * @param iterable<mixed> $names
     * @return list<string>
     * @throws \InvalidArgumentException for anything but an exact name
     */
    public static function normalizeProcedures(iterable $names): array
    {
        $normalized = [];
        foreach ($names as $name) {
            if (!is_string($name) || preg_match(self::PROCEDURE_NAME, $name) !== 1) {
                throw new \InvalidArgumentException('A safe procedure must be an exact name such as "refresh_totals", not ' . var_export($name, true) . '.');
            }
            $normalized[strtolower($name)] = true;
        }

        return array_keys($normalized);
    }

    /** `` `Shop` . `Rebuild` `` becomes `shop.rebuild`; a quoted name that isn't a plain name never matches. */
    private static function procedureKey(string $name): string
    {
        $parts = preg_split('/\s*\.\s*/', $name) ?: [$name];

        return strtolower(implode('.', array_map(static fn (string $part): string => trim($part, '`'), $parts)));
    }

    /**
     * Splits SQL text into statements, ignoring separators inside quotes and comments.
     *
     * The body of a MySQL executable comment is kept as statement text, because the server runs it:
     * `/*!COMMIT*\/` is a COMMIT, not a comment.
     *
     * @param bool $mysql read quotes and comments the way MySQL and MariaDB do
     * @return list<string>
     */
    public static function split(string $sql, bool $mysql = false): array
    {
        $statements = [];
        $current = '';
        $index = 0;
        $executable = false;
        $length = strlen($sql);
        while ($index < $length) {
            $char = $sql[$index];
            $next = $sql[$index + 1] ?? '';
            if ($executable && $char === '*' && $next === '/') {
                $executable = false;
                $index += 2;
                $current .= ' ';
                continue;
            }
            $dashComment = $char === '-' && $next === '-'
                && (!$mysql || !isset($sql[$index + 2]) || ctype_space($sql[$index + 2]) || ctype_cntrl($sql[$index + 2]));
            if ($dashComment || ($mysql && $char === '#')) {
                $end = strpos($sql, "\n", $index);
                $index = $end === false ? $length : $end + 1;
                $current .= ' ';
                continue;
            }
            // Read as SQL on every database: a stricter check elsewhere, where only MySQL runs it.
            if ($char === '/' && $next === '*' && !$executable && preg_match(self::EXECUTABLE_COMMENT, substr($sql, $index, 16), $opener) === 1) {
                $executable = true;
                $index += strlen($opener[0]);
                $current .= ' ';
                continue;
            }
            if ($char === '/' && $next === '*') {
                $end = strpos($sql, '*/', $index + 2);
                $index = $end === false ? $length : $end + 2;
                $current .= ' ';
                continue;
            }
            if ($char === "'" || $char === '"' || $char === '`') {
                $end = self::closingQuote($sql, $index, $char, self::backslashEscapes($sql, $index, $char, $mysql));
                $current .= substr($sql, $index, $end - $index);
                $index = $end;
                continue;
            }
            if ($char === '$' && ($mysql || ($index > 0 && preg_match('/[\w$]/', $sql[$index - 1]) === 1))) {
                $current .= $char;
                $index++;
                continue;
            }
            if ($char === '$' && preg_match('/^\$[A-Za-z_]*\$/', substr($sql, $index), $tag) === 1) {
                $end = strpos($sql, $tag[0], $index + strlen($tag[0]));
                $stop = $end === false ? $length : $end + strlen($tag[0]);
                $current .= substr($sql, $index, $stop - $index);
                $index = $stop;
                continue;
            }
            if ($char === ';') {
                if (trim($current) !== '') {
                    $statements[] = trim($current);
                }
                $current = '';
                $index++;
                continue;
            }
            $current .= $char;
            $index++;
        }
        if (trim($current) !== '') {
            $statements[] = trim($current);
        }

        return $statements;
    }

    /** Whether a backslash escapes the next character inside the quote that opens at `$index`. */
    private static function backslashEscapes(string $sql, int $index, string $quote, bool $mysql): bool
    {
        if ($mysql) {
            return $quote !== '`';
        }

        return $quote === "'" && $index > 0 && ($sql[$index - 1] === 'E' || $sql[$index - 1] === 'e')
            && ($index === 1 || preg_match('/[\w$]/', $sql[$index - 2]) !== 1);
    }

    private static function closingQuote(string $sql, int $start, string $quote, bool $backslash): int
    {
        $length = strlen($sql);
        $index = $start + 1;
        while ($index < $length) {
            if ($backslash && $sql[$index] === '\\') {
                $index += 2;
                continue;
            }
            if ($sql[$index] === $quote) {
                if (($sql[$index + 1] ?? '') === $quote) {
                    $index += 2;
                    continue;
                }

                return $index + 1;
            }
            $index++;
        }

        return $length;
    }
}

<?php

declare(strict_types=1);

namespace Sendproof\Core\Capture;

/**
 * Lightweight SQL statement classification for the transaction-control rule of
 * spec/data-stores.md: during a Preview a provider refuses, before it reaches the database, any
 * statement that would end or escape the Preview transaction. The check is deliberately
 * conservative: an unrecognised statement that might end the transaction is refused.
 */
final class Statements
{
    /** MySQL and MariaDB run the body of `/*! ... *\/` and `/*M! ... *\/` comments as SQL. */
    private const EXECUTABLE_COMMENT = '/^\/\*M?!\d*/';

    private const TRANSACTION_CONTROL = '/^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)|PREPARE\s+TRANSACTION|XA\b|SET\s+(?:(?:SESSION|GLOBAL|LOCAL)\s+|@@(?:SESSION\.|GLOBAL\.)?)?AUTOCOMMIT\b|SET\s+IMPLICIT_TRANSACTIONS\b)/i';

    /** MySQL commits the open transaction before (and after) these statements. https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html */
    private const MYSQL_IMPLICIT_COMMIT = '/^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|GRANT|REVOKE|LOCK\s+TABLES?|UNLOCK\s+TABLES?|ANALYZE|OPTIMIZE|REPAIR|FLUSH|INSTALL|UNINSTALL|LOAD\s+(?:INDEX|DATA|XML)|CACHE\s+INDEX|RESET|SET\s+PASSWORD|START\s+REPLICA|STOP\s+REPLICA|CHANGE\s+REPLICATION)\b/i';
    private const MYSQL_TEMPORARY_TABLE = '/^(?:CREATE|DROP)\s+TEMPORARY\s+TABLE\b/i';

    /**
     * Whether a statement executed inside the Preview transaction can end or replace it.
     * Savepoint statements are allowed, because ORMs use them for nested transactions. `$mysql`
     * adds the statements MySQL and MariaDB commit implicitly.
     */
    public static function endsTransaction(string $sql, bool $mysql = false): bool
    {
        foreach (self::split($sql) as $statement) {
            if (preg_match(self::TRANSACTION_CONTROL, $statement) === 1) {
                return true;
            }
            if ($mysql && preg_match(self::MYSQL_IMPLICIT_COMMIT, $statement) === 1 && preg_match(self::MYSQL_TEMPORARY_TABLE, $statement) !== 1) {
                return true;
            }
        }

        return false;
    }

    /**
     * Splits SQL text into statements, ignoring separators inside quotes and comments.
     *
     * The body of a MySQL executable comment is kept as statement text, because the server runs it:
     * `/*!COMMIT*\/` is a COMMIT, not a comment.
     *
     * @return list<string>
     */
    public static function split(string $sql): array
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
            if ($char === '-' && $next === '-') {
                $end = strpos($sql, "\n", $index);
                $index = $end === false ? $length : $end + 1;
                $current .= ' ';
                continue;
            }
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
                $end = self::closingQuote($sql, $index, $char);
                $current .= substr($sql, $index, $end - $index);
                $index = $end;
                continue;
            }
            if ($char === '$' && $index > 0 && preg_match('/[\w$]/', $sql[$index - 1]) === 1) {
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

    private static function closingQuote(string $sql, int $start, string $quote): int
    {
        $length = strlen($sql);
        $index = $start + 1;
        while ($index < $length) {
            if ($sql[$index] === '\\' && $quote !== '"') {
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

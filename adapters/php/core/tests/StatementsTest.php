<?php

declare(strict_types=1);

namespace Sendproof\Core\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Sendproof\Core\Capture\Statements;

/** The statements a Preview refuses because they would end or escape its transaction. */
final class StatementsTest extends TestCase
{
    /** @return iterable<string,array{string,bool,bool}> */
    public static function statements(): iterable
    {
        foreach (['COMMIT', 'commit work', 'END', 'ROLLBACK', 'ABORT', 'BEGIN', 'START TRANSACTION', 'SET autocommit = 1', 'set session autocommit=1', 'PREPARE TRANSACTION \'x\'', 'SET IMPLICIT_TRANSACTIONS ON', "select 1; COMMIT", '/*!COMMIT*/', '-- note' . "\n" . 'COMMIT'] as $sql) {
            yield $sql => [$sql, false, true];
        }
        foreach (['SELECT 1', 'INSERT INTO t VALUES (1)', "select 'COMMIT;' as v", 'SAVEPOINT s1', 'RELEASE SAVEPOINT s1', 'ROLLBACK TO SAVEPOINT s1', 'ROLLBACK TO s1', '/* COMMIT */ select 1', 'select $$ COMMIT; $$'] as $sql) {
            yield $sql => [$sql, false, false];
        }
        // Statements MySQL commits implicitly count only on MySQL.
        foreach (['CREATE TABLE x (a int)', 'ALTER TABLE x ADD b int', 'DROP TABLE x', 'TRUNCATE x', 'LOCK TABLES x WRITE', 'RENAME TABLE a TO b'] as $sql) {
            yield 'mysql: ' . $sql => [$sql, true, true];
            yield 'other: ' . $sql => [$sql, false, false];
        }
        yield 'mysql temporary table' => ['CREATE TEMPORARY TABLE x (a int)', true, false];
    }

    #[DataProvider('statements')]
    public function testEndsTransaction(string $sql, bool $mysql, bool $expected): void
    {
        $this->assertSame($expected, Statements::endsTransaction($sql, $mysql));
    }
}

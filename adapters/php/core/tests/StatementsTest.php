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

    /** spec/data-stores.md, "Transaction-control statements from the handler", on MySQL and MariaDB. */
    public function testEveryMysqlEscapeIsRefused(): void
    {
        $refused = [
            'CALL sendproof_commit_probe()', 'call shop.refresh()', 'CALL `refresh`', '/*!50000 COMMIT */',
            '/*M!100100 CREATE TABLE t (n INT) */', 'SET @@session.autocommit = 1', "SET sql_mode = '', autocommit = 1",
            'CREATE TABLE sendproof_escape_1 (n INT)', 'CHECK TABLE t', 'STOP SLAVE', "CHANGE MASTER TO MASTER_HOST='h'",
            "IMPORT TABLE FROM '/x.sdi'", 'SET DEFAULT ROLE ALL TO u', 'EXECUTE stmt', "XA START 'x'",
            // A quote inside a comment, a "#" comment, or a backslash-escaped quote never hides what follows.
            "SELECT 1 # it's\n; COMMIT; SELECT 'x'", 'SELECT "a\\" "; COMMIT; SELECT "b"', 'SELECT 1--1; COMMIT',
            'SELECT $a$; COMMIT; SELECT $a$',
        ];
        foreach ($refused as $sql) {
            $this->assertTrue(Statements::endsTransaction($sql, true), $sql);
        }
        $allowed = [
            "SELECT 'CALL p(); COMMIT'", 'SELECT 1 /* CALL p() */', "INSERT INTO t VALUES ('a\\'; COMMIT; --')",
            'CREATE TEMPORARY TABLE t (n INT)', 'SAVEPOINT s1', 'ROLLBACK TO SAVEPOINT s1', 'SELECT `call` FROM t',
            'UPDATE t SET checked = 1', 'SET @x = 1', 'SELECT 1 -- COMMIT',
        ];
        foreach ($allowed as $sql) {
            $this->assertFalse(Statements::endsTransaction($sql, true), $sql);
        }
    }

    public function testDeclaredProceduresMatchByExactNameOnly(): void
    {
        $safe = Statements::normalizeProcedures(['refresh_totals', 'shop.Rebuild']);
        foreach (['CALL refresh_totals()', 'CALL REFRESH_TOTALS', 'call `refresh_totals`(1)', 'CALL shop.rebuild()', 'CALL `shop`.`rebuild`'] as $sql) {
            $this->assertFalse(Statements::endsTransaction($sql, true, $safe), $sql);
        }
        foreach (['CALL refresh_totals_all()', 'CALL other.refresh_totals()', 'CALL rebuild()', 'CALL refresh_totals(); COMMIT', 'CALL `refresh totals`()'] as $sql) {
            $this->assertTrue(Statements::endsTransaction($sql, true, $safe), $sql);
        }
        foreach (['refresh_*', '`p`', 'a.b.c', '', 3] as $bad) {
            try {
                Statements::normalizeProcedures([$bad]);
                $this->fail('Accepted ' . var_export($bad, true));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testTheReservedSavepointCannotBeReleasedOrRolledBackTo(): void
    {
        foreach (['RELEASE SAVEPOINT sendproof_preview', 'ROLLBACK TO SAVEPOINT `sendproof_preview`', 'SAVEPOINT SENDPROOF_PREVIEW'] as $sql) {
            $this->assertTrue(Statements::endsTransaction($sql, true, [], 'sendproof_preview'), $sql);
        }
        $this->assertFalse(Statements::endsTransaction('RELEASE SAVEPOINT sendproof_preview_2', true, [], 'sendproof_preview'));
    }

    public function testOtherDatabasesReadStandardStringsWithoutBackslashEscapes(): void
    {
        $this->assertTrue(Statements::endsTransaction("SELECT 'a\\'; COMMIT; --'"));
        $this->assertFalse(Statements::endsTransaction("SELECT E'a\\'; COMMIT; --'"));
        $this->assertFalse(Statements::endsTransaction('CALL p()'), 'CALL is refused on MySQL and MariaDB only');
    }
}

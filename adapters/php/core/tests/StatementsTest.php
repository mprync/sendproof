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
        foreach (['COMMIT', 'commit work', 'END', 'ROLLBACK', 'ABORT', 'BEGIN', 'START TRANSACTION', 'SET autocommit = 1', 'set session autocommit=1', 'PREPARE TRANSACTION \'x\'', "select 1; COMMIT", '/*!COMMIT*/', '-- note' . "\n" . 'COMMIT'] as $sql) {
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
            "PREPARE s FROM 'COMMIT'", 'PREPARE s FROM @sql', "EXECUTE IMMEDIATE 'COMMIT'", 'SELECT 1 /*! ; COMMIT */',
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
        $audit = Statements::normalizeProcedures(['audit']);
        $this->assertFalse(Statements::endsTransaction('CALL AUDIT()', true, $audit));
        $this->assertFalse(Statements::endsTransaction('CALL `Audit`()', true, $audit));
        $this->assertTrue(Statements::endsTransaction('CALL other.audit()', true, $audit));
        $this->assertTrue(Statements::endsTransaction('CALL `other`.`audit`()', true, $audit));
        foreach (['refresh_*', '`p`', 'a.b.c', '', 3] as $bad) {
            try {
                Statements::normalizeProcedures([$bad]);
                $this->fail('Accepted ' . var_export($bad, true));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testADeadlockOrARolledBackLockTimeoutEndsTheMysqlPreviewTransaction(): void
    {
        $on = static fn (): bool => true;
        $off = static fn (): bool => false;
        $this->assertNotNull(Statements::serverEndedTransaction(1213, true, $off));
        $this->assertNotNull(Statements::serverEndedTransaction('1213', true, $off));
        $this->assertNotNull(Statements::serverEndedTransaction(1205, true, $on));
        $this->assertNull(Statements::serverEndedTransaction(1205, true, $off), 'only the statement rolled back');
        $this->assertNull(Statements::serverEndedTransaction(1062, true, $on));
        $this->assertNull(Statements::serverEndedTransaction(1213, false, $on), 'PostgreSQL refuses later statements itself');
    }

    /** spec/data-stores.md: `SET IMPLICIT_TRANSACTIONS OFF` leaves the transaction alone, `ON` (alone or in a list) does not. */
    public function testOnlyExactlyImplicitTransactionsOffIsAllowed(): void
    {
        foreach (['SET IMPLICIT_TRANSACTIONS OFF', 'set implicit_transactions off;', "SET\tIMPLICIT_TRANSACTIONS  OFF"] as $allowed) {
            $this->assertFalse(Statements::endsTransaction($allowed), $allowed);
        }
        foreach (['SET IMPLICIT_TRANSACTIONS ON', 'SET NOCOUNT ON, IMPLICIT_TRANSACTIONS ON', 'SET NOCOUNT OFF, IMPLICIT_TRANSACTIONS OFF', 'SET IMPLICIT_TRANSACTIONS', 'SET IMPLICIT_TRANSACTIONS OFF; SET IMPLICIT_TRANSACTIONS ON'] as $refused) {
            $this->assertTrue(Statements::endsTransaction($refused), $refused);
        }
    }

    public function testSqlServerTransactionControlIsRefusedAndItsStartSavepointIsReserved(): void
    {
        foreach (['COMMIT TRAN', 'COMMIT TRANSACTION t1', 'ROLLBACK TRAN', 'ROLLBACK TRANSACTION', 'BEGIN TRAN', 'BEGIN TRANSACTION'] as $sql) {
            $this->assertTrue(Statements::endsTransaction($sql), $sql);
        }
        foreach (['SAVE TRANSACTION sendproof_preview', 'ROLLBACK TRANSACTION sendproof_preview', 'save tran [sendproof_preview]'] as $sql) {
            $this->assertNotNull(Statements::reason($sql, false, [], 'sendproof_preview'), $sql);
        }
        $this->assertNull(Statements::reason('SAVE TRANSACTION mine', false, [], 'sendproof_preview'), 'the handler may keep its own savepoints');
    }

    public function testASqlServerDeadlockVictimOrAnAbortedTransactionEndsThePreviewTransaction(): void
    {
        $off = static fn (): bool => false;
        $this->assertNotNull(Statements::serverEndedTransaction(1205, false, $off, true));
        $this->assertNotNull(Statements::serverEndedTransaction('1205', false, $off, true));
        $this->assertNull(Statements::serverEndedTransaction(2627, false, $off, true), 'a duplicate key only fails its statement');
        $this->assertNull(Statements::serverEndedTransaction(1213, false, $off, true), '1213 is MySQL');
        // No open transaction, or XACT_ABORT ON, means the server rolled back; the row is TRANCOUNT and the XACT_ABORT flag.
        $this->assertTrue(Statements::sqlServerTransactionGone([0, 0]));
        $this->assertTrue(Statements::sqlServerTransactionGone(['1', '1']));
        $this->assertTrue(Statements::sqlServerTransactionGone(null), 'unknown counts as gone');
        $this->assertFalse(Statements::sqlServerTransactionGone([1, 0]));
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
        $this->assertTrue(Statements::endsTransaction("SELECT E'a\\''; COMMIT"), 'the escaped quote ends nothing; the next one does');
        $this->assertFalse(Statements::endsTransaction('SELECT $$ ; COMMIT $$'));
        $this->assertTrue(Statements::endsTransaction('SELECT $body$ ; COMMIT $body$; COMMIT'));
        $this->assertTrue(Statements::endsTransaction("SELECT 2 #- '{a}'; COMMIT"), '# is an operator outside MySQL');
        $this->assertTrue(Statements::endsTransaction('SELECT "a\\"; COMMIT'), 'a PostgreSQL identifier has no backslash escapes');
        $this->assertFalse(Statements::endsTransaction('CALL p()'), 'CALL is refused on MySQL and MariaDB only');
    }
}

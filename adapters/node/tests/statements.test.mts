/**
 * The shared transaction-control classifier (spec/data-stores.md "Transaction-control statements from the
 * handler"), as every Node SQL provider applies it during a Preview.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { endsTransaction, refusedStatement, rollsBackTransaction, safeProcedureNames } from '@sendproof/core';

describe('Transaction-control classifier', () => {
  it('refuses MySQL CALL unless the host declared the procedure safe by exact name', () => {
    for (const sql of ['CALL sendproof_commit_probe()', 'call p', 'CALL `p`()', 'CALL app.p(1, 2)', 'SELECT 1; CALL p()',
      '/*!CALL p()*/', 'CALL "p"()']) {
      assert.ok(endsTransaction(sql, 'mysql'), sql);
    }
    const safe = safeProcedureNames(['audit_read', 'app.lookup']);
    for (const sql of ['CALL audit_read()', 'CALL `audit_read`', 'CALL app.lookup(1)', 'CALL `app` . `lookup`()']) {
      assert.ok(!endsTransaction(sql, 'mysql', safe), sql);
    }
    // Exact names only: another schema, another case or a prefix is a different procedure.
    // Routine names ignore case, as MySQL's do; a schema-qualified call matches only a declaration with that schema.
    for (const sql of ['CALL AUDIT_READ()', 'CALL `Audit_Read`()', 'CALL APP.LOOKUP(1)']) {
      assert.ok(!endsTransaction(sql, 'mysql', safe), sql);
    }
    assert.ok(!endsTransaction('CALL AUDIT()', 'mysql', safeProcedureNames(['audit'])));
    assert.ok(endsTransaction('CALL other.audit()', 'mysql', safeProcedureNames(['audit'])));
    for (const sql of ['CALL other.audit_read()', 'CALL lookup()', 'CALL audit_read_all()', 'CALL p()']) {
      assert.ok(endsTransaction(sql, 'mysql', safe), sql);
    }
    // CALL is MySQL's concern; PostgreSQL procedures can't commit a transaction they were called in.
    assert.ok(!endsTransaction('CALL p()', 'postgres'));
  });

  it('refuses SET autocommit wherever it appears in the assignment list', () => {
    for (const sql of ['SET autocommit = 1', 'SET @@session.autocommit = 1', 'SET sql_mode = \'\', autocommit = 1',
      'SET @x = 1, @@autocommit := 1', 'SET LOCAL autocommit TO on']) {
      assert.ok(endsTransaction(sql, 'mysql'), sql);
    }
    assert.ok(!endsTransaction('SET @x = 1', 'mysql'));
    assert.ok(!endsTransaction('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED', 'mysql'));
  });

  it('refuses every implicitly committing MySQL statement, including through SET STATEMENT and prepared SQL', () => {
    for (const sql of ['CHECK TABLE items', 'IMPORT TABLE FROM \'/tmp/t.sdi\'', 'START SLAVE', 'CHANGE MASTER TO MASTER_HOST = \'h\'',
      'START GROUP_REPLICATION', 'LOCK TABLE items WRITE', 'UNLOCK TABLES', 'RENAME TABLE a TO b', 'XA START \'x\'',
      'SET STATEMENT max_statement_time = 1 FOR COMMIT', 'SET STATEMENT max_statement_time = 1 FOR CREATE TABLE t (n INT)',
      'PREPARE s FROM \'COMMIT\'', 'EXECUTE s']) {
      assert.ok(endsTransaction(sql, 'mysql'), sql);
    }
    assert.ok(!endsTransaction('SET STATEMENT max_statement_time = 1 FOR SELECT 1', 'mysql'));
    assert.ok(!endsTransaction('DEALLOCATE PREPARE s', 'mysql'));
    assert.ok(!endsTransaction('DROP TEMPORARY TABLE t', 'mysql'));
  });

  it('refuses a handler touching the Preview savepoint on MySQL, and allows its own savepoints', () => {
    for (const sql of ['SAVEPOINT sendproof_preview', 'RELEASE SAVEPOINT sendproof_preview', 'release `sendproof_preview`',
      'ROLLBACK TO SAVEPOINT sendproof_preview', 'ROLLBACK WORK TO SENDPROOF_PREVIEW']) {
      assert.ok(endsTransaction(sql, 'mysql'), sql);
    }
    for (const sql of ['SAVEPOINT trx2', 'RELEASE SAVEPOINT trx2', 'ROLLBACK TO SAVEPOINT sendproof_preview_2']) {
      assert.ok(!endsTransaction(sql, 'mysql'), sql);
    }
  });

  it('reads MySQL text as the server does: # and -- comments, executable comments, both string readings, no $$ quoting', () => {
    for (const sql of [
      '# note\nCOMMIT', 'SELECT 1; # x\nCOMMIT', 'SELECT 1 --1; COMMIT', '/*!50000 COMMIT */', '/*M!100000 DROP TABLE t */',
      // NO_BACKSLASH_ESCAPES ends the string at the backslash; ANSI_QUOTES makes "..." an identifier without escapes.
      "SELECT 'a\\'; COMMIT; -- '", 'SELECT "a\\"; COMMIT; -- "',
      // $$ is no quote on MySQL.
      'SELECT $$; COMMIT; $$', 'SELECT 1; EXECUTE IMMEDIATE \'COMMIT\'', 'execute immediate @sql',
    ]) {
      assert.ok(endsTransaction(sql, 'mysql'), JSON.stringify(sql));
    }
    for (const sql of ['SELECT 1 -- COMMIT', 'SELECT 1 # COMMIT', "INSERT INTO t VALUES ('it''s; COMMIT')", 'SELECT `a;COMMIT` FROM t', 'SELECT 2--1']) {
      assert.ok(!endsTransaction(sql, 'mysql'), JSON.stringify(sql));
    }
  });

  it('reads PostgreSQL text as the server does: E strings, dollar quotes, nested comments, both string readings', () => {
    for (const sql of [
      // With standard_conforming_strings on, the backslash is a plain character and the string ends there.
      "SELECT 'x\\'; COMMIT; SELECT '", "SELECT E'x\\\\'; COMMIT; SELECT 'y'",
      // Nested block comments end only at the matching close.
      '/* outer /* inner */ still a comment */ COMMIT', 'SELECT "a\\"; COMMIT; --"',
    ]) {
      assert.ok(endsTransaction(sql, 'postgres'), JSON.stringify(sql));
    }
    for (const sql of ["SELECT E'it\\'s; COMMIT'", 'DO $$ BEGIN COMMIT; END $$', 'SELECT $body$; COMMIT; $body$', '/* a /* b */ COMMIT */ SELECT 1',
      'SELECT 1 # 2']) {
      assert.ok(!endsTransaction(sql, 'postgres'), JSON.stringify(sql));
    }
  });

  it('recognises errors after which the database rolled the whole transaction back', () => {
    assert.ok(rollsBackTransaction(Object.assign(new Error('x'), { errno: 1213 }), 'mysql'));
    assert.ok(rollsBackTransaction(Object.assign(new Error('x'), { code: 'ER_LOCK_WAIT_TIMEOUT' }), 'mysql'));
    assert.ok(rollsBackTransaction({ cause: { originalCode: '1213', kind: 'TransactionWriteConflict' } }, 'mysql'));
    assert.ok(rollsBackTransaction({ driverError: { errno: 1205 } }, 'mysql'));
    assert.ok(rollsBackTransaction({ originalError: { number: 1205 } }, 'mssql'));
    assert.ok(!rollsBackTransaction(Object.assign(new Error('x'), { errno: 1062 }), 'mysql'));
    assert.ok(!rollsBackTransaction(Object.assign(new Error('x'), { code: '40P01' }), 'postgres'));
  });

  it('names the refused statement', () => {
    assert.equal(refusedStatement('SELECT 1; CREATE TABLE t (n INT); SELECT 2', 'mysql'), 'CREATE TABLE t (n INT)');
    assert.equal(refusedStatement('SELECT 1', 'mysql'), undefined);
  });

  it('takes exact procedure names only', () => {
    for (const name of ['', ' ', 'p%', 'p*', 'a.b.c', 'p()', 'p q']) {
      assert.throws(() => safeProcedureNames([name]), TypeError, JSON.stringify(name));
    }
    assert.deepEqual([...safeProcedureNames(['`App`.`p`', 'Q'])], ['app.p', 'q']);
  });
});

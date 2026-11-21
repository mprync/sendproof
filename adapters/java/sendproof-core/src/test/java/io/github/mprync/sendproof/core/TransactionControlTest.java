package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The MySQL and MariaDB refusals of spec/data-stores.md "Transaction-control statements from the handler": implicitly
 * committing statements, {@code CALL} with its exact-name opt-out, and the MySQL lexical rules (executable comments,
 * backslash escapes, {@code #} and {@code -- } comments) that could otherwise hide a statement from the check.
 */
class TransactionControlTest {
    private static final Set<String> NONE = Set.of();

    @Test
    void mysqlRefusesEveryImplicitlyCommittingStatement() {
        for (String sql : List.of("CREATE TABLE sendproof_escape_1 (n INT)", "create index i on t (a)",
                "ALTER TABLE t ADD c INT", "DROP TABLE t", "RENAME TABLE a TO b", "TRUNCATE t", "LOCK TABLES t WRITE",
                "LOCK TABLE t WRITE", "UNLOCK TABLES", "GRANT SELECT ON t TO u", "REVOKE SELECT ON t FROM u",
                "CREATE USER u", "SET PASSWORD = 'x'", "ANALYZE TABLE t", "OPTIMIZE TABLE t", "REPAIR TABLE t",
                "CHECK TABLE t", "FLUSH PRIVILEGES", "INSTALL PLUGIN p SONAME 'p.so'", "UNINSTALL PLUGIN p",
                "LOAD INDEX INTO CACHE t", "LOAD DATA INFILE 'f' INTO TABLE t", "CACHE INDEX t IN c", "RESET MASTER",
                "START REPLICA", "STOP REPLICA", "CHANGE REPLICATION SOURCE TO SOURCE_HOST='h'", "IMPORT TABLE FROM 'f'",
                "XA START 'x'", "BEGIN", "BEGIN WORK", "START TRANSACTION", "COMMIT", "COMMIT AND CHAIN",
                "ROLLBACK", "ROLLBACK AND CHAIN", "PREPARE s FROM 'COMMIT'", "EXECUTE s", "EXECUTE IMMEDIATE 'COMMIT'",
                "execute immediate @sql", "/*M! EXECUTE IMMEDIATE 'COMMIT' */")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isNotNull();
            assertThat(TransactionControl.find(sql, "mariadb", NONE)).as(sql).isNotNull();
        }
    }

    @Test
    void mysqlRefusesEverySpellingOfSetAutocommit() {
        for (String sql : List.of("SET autocommit = 1", "SET autocommit=0", "SET SESSION autocommit = 1",
                "SET LOCAL autocommit = ON", "SET @@autocommit = 1", "SET @@session.autocommit = 1",
                "SET @@SESSION.AUTOCOMMIT=1", "SET @a = 1, @b = 2, @c = 3, autocommit = 1",
                "SET sql_mode = '', @@local.autocommit = 1")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isNotNull();
        }
        assertThat(TransactionControl.find("SET @autocommit = 1", "mysql", NONE)).as("a user variable").isNull();
        assertThat(TransactionControl.find("SET @v = 'autocommit'", "mysql", NONE)).isNull();
        assertThat(TransactionControl.find("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED", "mysql", NONE)).isNull();
    }

    @Test
    void mysqlRefusesCallUnlessTheHostDeclaredTheExactProcedure() {
        Set<String> safe = TransactionControl.safeProcedures(List.of("audit_touch", "reports.refresh_totals"));
        for (String sql : List.of("CALL sendproof_commit_probe()", "call sendproof_commit_probe", "CALL other.audit_touch()",
                "CALL audit_touch_all()", "{call sendproof_commit_probe(?)}", "{? = call sendproof_commit_probe(?)}",
                "CALL `sendproof_commit_probe`()", "CALL reports.audit_touch()")) {
            assertThat(TransactionControl.find(sql, "mysql", safe)).as(sql).isEqualTo("call");
        }
        for (String sql : List.of("CALL audit_touch()", "call AUDIT_TOUCH(?, ?)", "CALL `audit_touch`(1)",
                "CALL reports.refresh_totals()", "CALL `reports`.`refresh_totals`()", "{call audit_touch(?)}",
                "{?= call audit_touch(?)}")) {
            assertThat(TransactionControl.find(sql, "mysql", safe)).as(sql).isNull();
        }
        assertThat(TransactionControl.find("CALL audit_touch(); COMMIT", "mysql", safe)).isEqualTo("commit");
    }

    @Test
    void safeProceduresMatchAsMySqlNamesRoutines() {
        // Case-insensitive, backticks stripped, and a schema-qualified call matches only a declaration with that schema.
        Set<String> safe = TransactionControl.safeProcedures(List.of("audit"));
        assertThat(TransactionControl.find("CALL AUDIT()", "mysql", safe)).isNull();
        assertThat(TransactionControl.find("CALL `Audit`()", "mysql", safe)).isNull();
        assertThat(TransactionControl.find("CALL other.audit()", "mysql", safe)).isEqualTo("call");
        assertThat(TransactionControl.find("CALL `other`.`audit`()", "mysql", safe)).isEqualTo("call");
        Set<String> qualified = TransactionControl.safeProcedures(List.of("`Reports`.audit"));
        assertThat(TransactionControl.find("CALL reports.AUDIT()", "mysql", qualified)).isNull();
        assertThat(TransactionControl.find("CALL other.audit()", "mysql", qualified)).isEqualTo("call");
    }

    @Test
    void safeProceduresTakeExactNamesOnly() {
        for (String name : List.of("audit_*", "audit%", "", " ", "a?b")) {
            assertThatThrownBy(() -> TransactionControl.safeProcedures(List.of(name))).as(name)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(TransactionControl.safeProcedures(List.of("`Reports`.`Refresh`"))).containsExactly("reports.refresh");
    }

    @Test
    void mysqlRunsTheBodyOfAnExecutableComment() {
        for (String sql : List.of("/*!COMMIT*/", "/*!50001 COMMIT */", "/*M!100100 COMMIT */", "SELECT 1; /*! CALL p() */",
                "/*!80000 SET autocommit = 1 */")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isNotNull();
        }
        assertThat(TransactionControl.find("/* COMMIT */ SELECT 1", "mysql", NONE)).isNull();
        assertThat(TransactionControl.find("SELECT /*+ BKA(t) */ * FROM t", "mysql", NONE)).isNull();
    }

    @Test
    void mysqlCommentsAndQuotesCannotHideAStatement() {
        for (String sql : List.of(
                // A backslash escapes the quote, so the string ends at the second quote and COMMIT runs.
                "SELECT 'a\\''; COMMIT",
                "SELECT \"a\\\"\"; COMMIT",
                // With NO_BACKSLASH_ESCAPES the string ends at the backslash-quote instead.
                "SELECT 'a\\'; COMMIT; -- '",
                // MySQL's # comment ends at the line end; the quote inside it opens nothing.
                "SELECT 1 # it's\n; COMMIT",
                // "--" without a following space is two minus signs, not a comment.
                "SELECT 1--1; COMMIT",
                "INSERT INTO t VALUES (1);\nDROP TABLE t")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isNotNull();
        }
        for (String sql : List.of("SELECT 'it''s; COMMIT'", "SELECT 1 -- ; COMMIT", "SELECT 1 # ; COMMIT",
                "SELECT `commit` FROM t", "INSERT INTO t (a) VALUES ('CALL p()')", "UPDATE t SET n = n - -1",
                "SAVEPOINT s1", "RELEASE SAVEPOINT s1", "ROLLBACK TO SAVEPOINT s1", "ROLLBACK WORK TO s1",
                "SELECT * FROM t FOR UPDATE", "DO SLEEP(0)", "SHOW TABLES")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isNull();
        }
    }

    @Test
    void mysqlRefusesTheHandlerTouchingThePreviewSavepoint() {
        // The backstop's savepoint must stay as the Preview made it: releasing it, rolling back to it or making it again
        // (which would bring it back after a commit) would hide a commit from the check.
        for (String sql : List.of("RELEASE SAVEPOINT sendproof_preview", "release savepoint `SENDPROOF_PREVIEW`",
                "ROLLBACK TO SAVEPOINT sendproof_preview", "ROLLBACK WORK TO sendproof_preview",
                "ROLLBACK TO `sendproof_preview`", "SAVEPOINT sendproof_preview", "SELECT 1; SAVEPOINT sendproof_preview")) {
            assertThat(TransactionControl.find(sql, "mysql", NONE)).as(sql).isEqualTo("savepoint sendproof_preview");
        }
        assertThat(TransactionControl.find("SAVEPOINT sendproof_preview_2", "mysql", NONE)).isNull();
        assertThat(TransactionControl.find("ROLLBACK TO SAVEPOINT s1", "mysql", NONE)).isNull();
    }

    @Test
    void everyDatabaseRefusesTheHandlerTouchingThePreviewSavepoint() {
        for (String system : new String[] {"postgresql", "sqlite", "h2", "mssql", null}) {
            for (String sql : List.of("RELEASE SAVEPOINT sendproof_preview", "ROLLBACK TO SAVEPOINT sendproof_preview",
                    "SAVEPOINT \"sendproof_preview\"", "SAVE TRANSACTION sendproof_preview", "SAVE TRAN [sendproof_preview]",
                    "ROLLBACK TRANSACTION sendproof_preview")) {
                assertThat(TransactionControl.find(sql, system, NONE)).as(system + ": " + sql).isNotNull();
            }
            assertThat(TransactionControl.find("SAVE TRANSACTION nested", system, NONE)).as(system).isNull();
            assertThat(TransactionControl.find("ROLLBACK TO SAVEPOINT nested", system, NONE)).as(system).isNull();
        }
    }

    @Test
    void otherDatabasesReadStringsAsTheServerDoes() {
        // PostgreSQL's E'' strings take backslash escapes, so the string ends at the second quote and COMMIT runs.
        assertThat(TransactionControl.find("SELECT E'a\\''; COMMIT", "postgresql", NONE)).isEqualTo("commit");
        // A dollar-quoted string is one literal, whatever quotes it holds.
        assertThat(TransactionControl.find("SELECT $$it's$$; COMMIT", "postgresql", NONE)).isEqualTo("commit");
        assertThat(TransactionControl.find("SELECT $tag$; COMMIT $tag$", "postgresql", NONE)).isNull();
        assertThat(TransactionControl.find("SELECT 'it''s; COMMIT'", "postgresql", NONE)).isNull();
        assertThat(TransactionControl.find("UPDATE t SET n = $1 WHERE id = $2", "postgresql", NONE)).isNull();
    }

    @Test
    void deadlocksAndLockWaitTimeoutsRollTheTransactionBack() {
        var deadlock = new java.sql.SQLTransactionRollbackException("Deadlock found", "40001", 1213);
        var timeout = new java.sql.SQLException("Lock wait timeout exceeded", "HY000", 1205);
        assertThat(TransactionControl.rollsBackTransaction("mysql", deadlock)).isTrue();
        assertThat(TransactionControl.rollsBackTransaction("mariadb", timeout)).isTrue();
        assertThat(TransactionControl.rollsBackTransaction("mssql", timeout)).as("SQL Server's deadlock victim").isTrue();
        assertThat(TransactionControl.rollsBackTransaction("mssql", deadlock)).isFalse();
        assertThat(TransactionControl.rollsBackTransaction("postgresql", deadlock)).isFalse();
        assertThat(TransactionControl.rollsBackTransaction("mysql", new java.sql.SQLException("Duplicate", "23000", 1062)))
                .isFalse();
        var wrapped = new java.sql.SQLException("batch failed");
        wrapped.setNextException(deadlock);
        assertThat(TransactionControl.rollsBackTransaction("mysql", wrapped)).as("a chained deadlock").isTrue();
    }

    @Test
    void otherDatabasesKeepTheirOwnRules() {
        assertThat(TransactionControl.find("CALL refresh_totals()", "postgresql", NONE)).isNull();
        assertThat(TransactionControl.find("ANALYZE t", "postgresql", NONE)).isNull();
        assertThat(TransactionControl.find("ABORT", "postgresql", NONE)).isEqualTo("abort");
        assertThat(TransactionControl.find("SET SESSION autocommit = 1", "h2", NONE)).isNotNull();
        assertThat(TransactionControl.find("CREATE TABLE t (n INT)", null, NONE)).isNotNull();
    }
}

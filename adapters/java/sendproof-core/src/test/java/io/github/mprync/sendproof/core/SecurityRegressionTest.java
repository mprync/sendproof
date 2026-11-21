package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Regression tests from the security review: change redaction, transaction-control detection and trace IDs. */
class SecurityRegressionTest {

    @Test
    void secretColumnsAreRedactedInEveryPartOfAChange() {
        var change = new PreviewChange("update", "users", Map.of("id", 7, "api_key", "k-1"),
                Map.of("id", 7, "passwordHash", "old", "name", "Ada"), Map.of("id", 7, "passwordHash", "new", "name", "Ada"));
        PreviewChange snapshot = CaptureLimits.snapshotChanges(List.of(change)).changes().get(0);
        assertThat(((JsonNode) snapshot.key()).get("id").asInt()).isEqualTo(7);
        assertThat(((JsonNode) snapshot.key()).get("api_key").asText()).isEqualTo(SqlRedaction.REDACTED);
        assertThat(((JsonNode) snapshot.before()).get("passwordHash").asText()).isEqualTo(SqlRedaction.REDACTED);
        assertThat(((JsonNode) snapshot.after()).get("name").asText()).isEqualTo("Ada");
        assertThat(snapshot.toString()).doesNotContain("old").doesNotContain("\"new\"").doesNotContain("k-1");
    }

    @Test
    void aSecretTableHidesEveryValueButKeepsTheKey() {
        var change = new PreviewChange("insert", "api_tokens", Map.of("id", 1), null, Map.of("id", 1, "value", "t0k"));
        PreviewChange snapshot = CaptureLimits.snapshotChanges(List.of(change)).changes().get(0);
        assertThat(((JsonNode) snapshot.key()).get("id").asInt()).isEqualTo(1);
        assertThat(((JsonNode) snapshot.after()).get("value").asText()).isEqualTo(SqlRedaction.REDACTED);
        assertThat(((JsonNode) snapshot.after()).get("id").asText()).isEqualTo(SqlRedaction.REDACTED);
    }

    @Test
    void pluralsAndSessionIdentifiersAreSecret() {
        for (String name : List.of("api_tokens", "passwords", "password_hashes", "salts", "session_id", "sessionId",
                "SESSION_PRIMARY_ID", "client_keys")) {
            assertThat(SqlRedaction.looksSecret(name)).as(name).isTrue();
        }
        for (String name : List.of("sessions", "session_count", "status", "access", "keys", "primary_id", "addresses")) {
            assertThat(SqlRedaction.looksSecret(name)).as(name).isFalse();
        }
    }

    @Test
    void springSessionJdbcStatementsNeverShowTheSessionId() {
        // The statements Spring Session JDBC issues for its tables, with the session id or row id bound.
        for (String sql : List.of(
                "INSERT INTO SPRING_SESSION (PRIMARY_ID, SESSION_ID, CREATION_TIME, LAST_ACCESS_TIME, "
                        + "MAX_INACTIVE_INTERVAL, EXPIRY_TIME, PRINCIPAL_NAME) VALUES (?, ?, ?, ?, ?, ?, ?)",
                "UPDATE SPRING_SESSION SET SESSION_ID = ?, LAST_ACCESS_TIME = ? WHERE PRIMARY_ID = ?",
                "SELECT S.PRIMARY_ID FROM SPRING_SESSION S WHERE S.SESSION_ID = ?",
                "INSERT INTO SPRING_SESSION_ATTRIBUTES (SESSION_PRIMARY_ID, ATTRIBUTE_NAME, ATTRIBUTE_BYTES) "
                        + "VALUES (?, ?, ?)")) {
            var snapshot = SqlCapture.snapshot(sql, List.of(new SqlCapture.Binding("a1b2-session", "VARCHAR"),
                    new SqlCapture.Binding("c3d4", "VARCHAR"), new SqlCapture.Binding("x", "VARCHAR")), 1, true);
            assertThat(snapshot.sql().parameters()).as(sql)
                    .allMatch(parameter -> SqlRedaction.REDACTED.equals(parameter.value()));
        }
    }

    @Test
    void aSecretNamedPrimaryKeyIsRedactedInTheKey() {
        var change = new PreviewChange("delete", "sessions", Map.of("session_id", "abc"),
                Map.of("session_id", "abc", "user_id", 4), null);
        PreviewChange snapshot = CaptureLimits.snapshotChanges(List.of(change)).changes().get(0);
        assertThat(((JsonNode) snapshot.key()).get("session_id").asText()).isEqualTo(SqlRedaction.REDACTED);
        assertThat(((JsonNode) snapshot.before()).get("user_id").asInt()).isEqualTo(4);
    }

    @Test
    void transactionControlIsRecognisedInEveryStatement() {
        for (String sql : List.of("commit", " COMMIT WORK", "end", "begin", "start transaction", "rollback",
                "rollback work", "set autocommit = 1", "SET @@autocommit=1", "set implicit_transactions on",
                "create table t (id int)", "alter table t add c int", "drop table t", "truncate table t",
                "grant select on t to u", "lock tables t write", "unlock tables", "xa commit 'x'",
                "prepare transaction 'x'", "-- note\ncommit", "/* c */ commit", "select 1; commit",
                "insert into t values ('a;b'); drop table t")) {
            assertThat(TransactionControl.find(sql)).as(sql).isNotNull();
        }
        for (String sql : List.of("select * from t", "insert into t (a) values ('commit')", "update t set end_at = ?",
                "rollback to savepoint s1", "rollback work to savepoint s1", "savepoint s1",
                "release savepoint s1", "set transaction isolation level serializable", "merge into t using s on 1=1",
                "select 'x;commit'", "with x as (select 1) select * from x", "lock table t in exclusive mode")) {
            assertThat(TransactionControl.find(sql)).as(sql).isNull();
        }
    }

    @Test
    void traceIdsUseAllOneHundredTwentyEightBits() {
        var store = new TraceStore();
        var versions = new HashSet<Integer>();
        for (int i = 0; i < 64; i++) {
            versions.add(store.reserve(new TraceOwner("t", "s" + (i % 8), "")).id().version());
        }
        // A version-4 UUID fixes six bits; fully random IDs show many version nibbles.
        assertThat(versions.size()).isGreaterThan(1);
    }
}

package io.github.mprync.sendproof.cassandra;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.datastax.oss.driver.api.core.CqlSession;
import com.datastax.oss.driver.api.core.cql.BatchStatement;
import com.datastax.oss.driver.api.core.cql.BatchType;
import com.datastax.oss.driver.api.core.cql.BoundStatement;
import com.datastax.oss.driver.api.core.cql.PreparedStatement;
import com.datastax.oss.driver.api.core.cql.SimpleStatement;
import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;

/**
 * The Cassandra guard. Most tests run against a recording stand-in for the session, so they need no server and can say
 * exactly what reached "the wire"; one runs against the compose {@code cassandra} service and skips when it isn't up
 * ({@code docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra}).
 */
class CassandraStoreTest {
    private final CassandraStore store = CassandraStore.builder().name("tickets").build();
    private final List<Object> sent = Collections.synchronizedList(new ArrayList<>());
    private final CqlSession raw = recording(sent);
    private final CqlSession session = store.session(raw);

    /** A session that records the first argument of every call that would send something. */
    private static CqlSession recording(List<Object> sent) {
        return (CqlSession) Proxy.newProxyInstance(CqlSession.class.getClassLoader(), new Class<?>[] {CqlSession.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getKeyspace":
                            return Optional.empty();
                        case "toString":
                            return "recording session";
                        case "hashCode":
                            return 1;
                        case "equals":
                            return proxy == args[0];
                        case "prepare", "close", "getName":
                            return null;
                        default:
                            sent.add(args == null ? method.getName() : args[0]);
                    }
                    return method.getReturnType() == CompletionStage.class ? CompletableFuture.completedFuture(null) : null;
                });
    }

    private static BoundStatement bound(String preparedFrom) {
        PreparedStatement prepared = (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
                new Class<?>[] {PreparedStatement.class}, (proxy, method, args) -> method.getName().equals("getQuery") ? preparedFrom : null);
        return (BoundStatement) Proxy.newProxyInstance(BoundStatement.class.getClassLoader(), new Class<?>[] {BoundStatement.class},
                (proxy, method, args) -> method.getName().equals("getPreparedStatement") ? prepared : null);
    }

    private static void swallow(Runnable work) {
        try {
            work.run();
        } catch (RuntimeException refused) {
            // The handler catches the refusal and returns normally.
        }
    }

    @Test
    void aReadRunsAndIsLoggedWithItsLiteralsReplaced() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(store, () ->
                session.execute("SELECT id, status FROM inventory.tickets WHERE id = 'seeded' AND hits = 3")));
        JsonNode db = envelope.get("logs").get(0).get("db");
        assertThat(db.get("system").asText()).isEqualTo("cassandra");
        assertThat(db.get("operation").asText()).isEqualTo("SELECT");
        assertThat(db.get("target").asText()).isEqualTo("tickets");
        assertThat(db.get("namespace").asText()).isEqualTo("inventory");
        assertThat(db.get("statement").asText()).isEqualTo("SELECT id, status FROM inventory.tickets WHERE id = ? AND hits = ?");
        assertThat(envelope.toString()).doesNotContain("seeded");
        assertThat(sent).hasSize(1);
    }

    @Test
    void aWriteIsRefusedBeforeItIsSentAndTheHandlerCannotHideIt() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> session.execute("INSERT INTO tickets (id) VALUES ('x')")));
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"store\":\"cassandra\"").contains("\"operation\":\"INSERT\"")
                .contains("Preview unavailable: this operation writes to Cassandra");
        assertThat(sent).isEmpty();
    }

    @Test
    void theRefusalReachesTheHandlerAsThePreviewException() throws Exception {
        Harness.preview(store, () -> assertThatThrownBy(() -> session.execute("DELETE FROM tickets WHERE id = 'x'"))
                .isInstanceOf(PreviewWriteBlockedException.class));
    }

    @Test
    void everyBatchIsRefusedEvenWhenEmptyAndTextBatchesToo() throws Exception {
        for (Runnable batch : List.<Runnable>of(
                () -> session.execute(BatchStatement.newInstance(BatchType.LOGGED)),
                () -> session.execute(BatchStatement.newInstance(BatchType.UNLOGGED, SimpleStatement.newInstance("UPDATE t SET a = 1 WHERE id = 2"))),
                () -> session.execute("BEGIN BATCH INSERT INTO t (id) VALUES (1); APPLY BATCH"))) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(batch));
            assertThat(outcome.blocked()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"operation\":\"BATCH\"");
        }
        assertThat(sent).isEmpty();
    }

    @Test
    void aBoundStatementIsClassifiedByTheTextItWasPreparedFrom() throws Exception {
        assertThat(Harness.preview(store, () -> session.execute(bound("SELECT * FROM tickets WHERE id = ?"))).confirmed()).isTrue();
        PreviewOutcome write = Harness.preview(store, () -> swallow(() -> session.execute(bound("UPDATE tickets SET status = ? WHERE id = ?"))));
        assertThat(write.blocked()).isTrue();
        assertThat(new String(write.problem())).contains("\"operation\":\"UPDATE\"");
        assertThat(sent).hasSize(1);
    }

    @Test
    void aLightweightTransactionAndASecondStatementAreWrites() throws Exception {
        for (String text : List.of("INSERT INTO tickets (id) VALUES ('a') IF NOT EXISTS", "SELECT * FROM t; DELETE FROM t WHERE id = 1",
                "SELECT * FROM t WHERE a = 'unterminated", "")) {
            assertThat(Harness.preview(store, () -> swallow(() -> session.execute(text))).blocked()).as(text).isTrue();
        }
        assertThat(sent).isEmpty();
    }

    @Test
    void asyncAndReactiveCallsAreCheckedBeforeTheyAreSent() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> {
            assertThat(session.executeAsync("SELECT * FROM tickets").toCompletableFuture().join()).isNull();
            assertThatThrownBy(() -> session.executeAsync("TRUNCATE tickets")).isInstanceOf(PreviewWriteBlockedException.class);
            assertThatThrownBy(() -> session.executeAsync(SimpleStatement.newInstance("DROP TABLE tickets")))
                    .isInstanceOf(PreviewWriteBlockedException.class);
            assertThatThrownBy(() -> session.executeReactive("CREATE TABLE t (id text PRIMARY KEY)"))
                    .isInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(sent).hasSize(1);
    }

    @Test
    void prepareAndUseAreAllowedWhilePreparingAWriteDoesNotWrite() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> {
            session.prepare("INSERT INTO tickets (id) VALUES (?)");
            session.execute("USE inventory");
        });
        assertThat(outcome.confirmed()).isTrue();
        assertThat(sent).containsExactly("USE inventory");
    }

    @Test
    void aWriteOutsideAPreviewRunsAndIsNotBlocked() {
        session.execute("INSERT INTO tickets (id) VALUES ('sent')");
        session.execute(BatchStatement.newInstance(BatchType.LOGGED));
        assertThat(sent).hasSize(2);
    }

    @Test
    void anUnknownRequestOrMethodFailsClosed() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> assertThatThrownBy(() ->
                session.execute((com.datastax.oss.driver.api.core.cql.Statement<?>) Proxy.newProxyInstance(
                        BoundStatement.class.getClassLoader(), new Class<?>[] {com.datastax.oss.driver.api.core.cql.Statement.class},
                        (proxy, method, args) -> null))).isInstanceOf(PreviewWriteBlockedException.class));
        assertThat(outcome.blocked()).isTrue();
        assertThat(sent).isEmpty();
    }

    @Test
    void hostDeclaredReadsPassButNeverABatch() throws Exception {
        CassandraStore lenient = CassandraStore.builder().treatAsRead("MYSTMT", "BATCH").build();
        CqlSession mine = lenient.session(raw);
        assertThat(Harness.preview(lenient, () -> mine.execute("MYSTMT x")).confirmed()).isTrue();
        assertThat(Harness.preview(lenient, () -> swallow(() -> mine.execute("BEGIN BATCH APPLY BATCH"))).blocked()).isTrue();
    }

    @Test
    void aSessionIsNotWrappedTwiceAndReportsGuardMode() {
        assertThat(store.session(session)).isSameAs(session);
        assertThat(CassandraStore.isGuarded(session)).isTrue();
        assertThat(CassandraStore.isGuarded(raw)).isFalse();
        assertThat(store.describe().mode()).isEqualTo("guard");
        assertThat(store.describe().system()).isEqualTo("cassandra");
    }

    @Test
    void aWriteWithNoRequestBehindItFailsAnOpenPreviewUnlessDetached() throws Exception {
        var pool = Executors.newSingleThreadExecutor();
        try {
            PreviewOutcome outcome = Harness.preview(store, () -> {
                // Another thread the capture didn't follow: nothing says this isn't the Preview's own write.
                assertThatThrownBy(() -> pool.submit(() -> session.execute("INSERT INTO tickets (id) VALUES ('bg')")).get())
                        .isInstanceOf(ExecutionException.class).hasRootCauseInstanceOf(PreviewTransactionControlException.class);
            });
            assertThat(outcome.confirmed()).isFalse();
            assertThat(outcome.blocked()).isFalse();
            assertThat(outcome.status()).isEqualTo(500);
            assertThat(sent).isEmpty();

            PreviewOutcome detached = Harness.preview(store, () ->
                    pool.submit(() -> CaptureContext.detached(() -> session.execute("INSERT INTO tickets (id) VALUES ('bg')"))).get());
            assertThat(detached.confirmed()).isTrue();
            assertThat(sent).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theChecksFailWhenTheHookIsRemoved() throws Exception {
        // The raw session has no guard: the write is sent and the Preview confirms. The conformance checks catch this.
        PreviewOutcome outcome = Harness.preview(store, () -> raw.execute("INSERT INTO tickets (id) VALUES ('unhooked')"));
        assertThat(outcome.blocked()).isFalse();
        assertThat(sent).hasSize(1);
    }

    /** A session on the compose service; schema changes are slow on a busy host, so the request timeout is generous. */
    private static CqlSession connect() {
        var config = com.datastax.oss.driver.api.core.config.DriverConfigLoader.programmaticBuilder()
                .withDuration(com.datastax.oss.driver.api.core.config.DefaultDriverOption.REQUEST_TIMEOUT, java.time.Duration.ofSeconds(60))
                .withDuration(com.datastax.oss.driver.api.core.config.DefaultDriverOption.CONNECTION_INIT_QUERY_TIMEOUT, java.time.Duration.ofSeconds(10))
                .build();
        return CqlSession.builder().withConfigLoader(config).addContactPoint(new InetSocketAddress("127.0.0.1", 59042))
                .withLocalDatacenter("datacenter1").build();
    }

    @Test
    void againstARealCassandraAReadRunsAndABlockedWriteLeavesNothing() throws Exception {
        String keyspace = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        CqlSession real;
        try {
            real = connect();
        } catch (RuntimeException unreachable) {
            assumeTrue(false, "Cassandra isn't running: docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra");
            return;
        }
        try (real) {
            real.execute("CREATE KEYSPACE " + keyspace + " WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}");
            real.execute("CREATE TABLE " + keyspace + ".tickets (id text PRIMARY KEY, status text, hits int)");
            real.execute("INSERT INTO " + keyspace + ".tickets (id, status, hits) VALUES ('seeded', 'open', 3)");
            CqlSession guarded = store.session(real);
            PreparedStatement select = guarded.prepare("SELECT id, status, hits FROM " + keyspace + ".tickets WHERE id = ?");
            PreviewOutcome read = Harness.preview(store, () ->
                    assertThat(guarded.execute(select.bind("seeded")).one().getString("status")).isEqualTo("open"));
            assertThat(read.confirmed()).isTrue();
            PreviewOutcome write = Harness.preview(store, () -> {
                swallow(() -> guarded.execute("INSERT INTO " + keyspace + ".tickets (id, status, hits) VALUES ('blocked', 'new', 1)"));
                swallow(() -> guarded.execute(BatchStatement.newInstance(BatchType.LOGGED, SimpleStatement.newInstance(
                        "UPDATE " + keyspace + ".tickets SET status = 'closed' WHERE id = 'seeded' IF EXISTS"))));
            });
            assertThat(write.blocked()).isTrue();
            assertThat(real.execute("SELECT id FROM " + keyspace + ".tickets WHERE id = 'blocked'").one()).isNull();
            assertThat(real.execute("SELECT status FROM " + keyspace + ".tickets WHERE id = 'seeded'").one().getString("status")).isEqualTo("open");
            guarded.execute("INSERT INTO " + keyspace + ".tickets (id, status, hits) VALUES ('sent', 'new', 1)");
            assertThat(real.execute("SELECT id FROM " + keyspace + ".tickets WHERE id = 'sent'").one()).isNotNull();
        } finally {
            try (CqlSession cleanup = connect()) {
                cleanup.execute("DROP KEYSPACE IF EXISTS " + keyspace);
            } catch (RuntimeException ignored) {
                // Nothing to clean up when the server went away.
            }
        }
    }
}

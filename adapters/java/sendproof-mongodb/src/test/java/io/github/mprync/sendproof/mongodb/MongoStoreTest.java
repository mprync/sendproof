package io.github.mprync.sendproof.mongodb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.MongoCommandException;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.Updates;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.Document;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The MongoDB hook against the compose replica set ({@code docker compose -f tests/conformance/compose.yml up -d --wait
 * mongodb}). Tests skip, saying so, when the service doesn't answer a {@code hello}.
 */
class MongoStoreTest {
    private static final String URL = System.getenv().getOrDefault("BENCH_MONGODB_SERVER_URL",
            "mongodb://127.0.0.1:57017/?directConnection=true");
    private static boolean available;

    private MongoStore store;
    private MongoClient raw;
    private MongoClient client;
    private final String databaseName = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);

    @BeforeAll
    static void probe() {
        try (MongoClient probe = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(2, java.util.concurrent.TimeUnit.SECONDS)).build())) {
            probe.getDatabase("admin").runCommand(new Document("hello", 1));
            available = true;
        } catch (RuntimeException unreachable) {
            available = false;
        }
    }

    @BeforeEach
    void connect() {
        assumeTrue(available, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        store = MongoStore.builder().name("catalog").build();
        raw = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .addCommandListener(store.commandListener()).build());
        client = store.sync(raw);
        raw.getDatabase(databaseName).getCollection("documents").insertOne(new Document("_id", "seeded").append("name", "Seeded")
                .append("profile", new Document("city", "Leeds")).append("password_hash", "hashed:seeded"));
    }

    @AfterEach
    void drop() {
        if (raw != null) {
            raw.getDatabase(databaseName).drop();
            raw.close();
        }
    }

    private MongoCollection<Document> documents() {
        return client.getDatabase(databaseName).getCollection("documents");
    }

    private long committed(Object id) {
        return raw.getDatabase(databaseName).getCollection("documents").countDocuments(Filters.eq("_id", id));
    }

    @Test
    void aPreviewRollsBackAndReportsNestedRedactedChanges() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            documents().insertOne(new Document("_id", "new").append("name", "Draft").append("profile", new Document("city", "York"))
                    .append("password_hash", "hashed:secret").append("apiKey", "k"));
            documents().updateOne(Filters.eq("_id", "seeded"), Updates.combine(Updates.set("name", "Renamed"),
                    Updates.set("profile.city", "Hull")));
        }, store);

        JsonNode envelope = Harness.envelope(outcome);
        assertThat(envelope.get("rolledBack").asBoolean()).isTrue();
        JsonNode insert = change(envelope, "insert");
        assertThat(insert.get("store").asText()).isEqualTo("mongodb");
        assertThat(insert.get("table").asText()).isEqualTo("documents");
        assertThat(insert.get("namespace").asText()).isEqualTo(databaseName);
        assertThat(insert.get("key")).isEqualTo(Json.MAPPER.readTree("{\"_id\":\"new\"}"));
        assertThat(insert.get("before").isNull()).isTrue();
        assertThat(insert.get("after").get("profile").get("city").asText()).isEqualTo("York");
        assertThat(insert.get("after").get("password_hash").asText()).isEqualTo("[REDACTED]");
        assertThat(insert.get("after").get("apiKey").asText()).isEqualTo("[REDACTED]");
        JsonNode update = change(envelope, "update");
        assertThat(update.get("before").get("name").asText()).isEqualTo("Seeded");
        assertThat(update.get("after").get("name").asText()).isEqualTo("Renamed");
        assertThat(update.get("before").get("profile").get("city").asText()).isEqualTo("Leeds");
        assertThat(update.get("after").get("profile").get("city").asText()).isEqualTo("Hull");
        assertThat(update.has("via")).isFalse();
        // Db entries carry sanitized statements, never values.
        String logs = envelope.get("logs").toString();
        assertThat(logs).contains("\"system\":\"mongodb\"").contains("\"operation\":\"insert\"")
                .doesNotContain("hashed:secret").doesNotContain("Renamed").doesNotContain("saslStart");
        // An independent read finds nothing the Preview wrote.
        assertThat(committed("new")).isZero();
        assertThat(raw.getDatabase(databaseName).getCollection("documents").find(Filters.eq("_id", "seeded")).first().getString("name"))
                .isEqualTo("Seeded");
    }

    @Test
    void anUpsertAndAReplacementAreLabelled() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> {
            documents().updateOne(Filters.eq("_id", "made"), Updates.set("name", "Made"),
                    new com.mongodb.client.model.UpdateOptions().upsert(true));
            documents().replaceOne(Filters.eq("_id", "seeded"), new Document("name", "Replaced"));
        }, store));
        assertThat(change(envelope, "insert").get("via").asText()).isEqualTo("upsert");
        assertThat(change(envelope, "update").get("via").asText()).isEqualTo("replace");
        assertThat(committed("made")).isZero();
    }

    @Test
    void aggregateOutIsBlockedBeforeSendingWithItsReason() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> documents().aggregate(List.of(
                new Document("$match", new Document()), new Document("$out", "documents_archive"))).toCollection())
                .isInstanceOf(PreviewWriteBlockedException.class), store);

        assertThat(outcome.blocked()).isTrue();
        JsonNode problem = Json.MAPPER.readTree(outcome.problem());
        assertThat(problem.get("store").asText()).isEqualTo("mongodb");
        assertThat(problem.get("operation").asText()).isEqualTo("aggregate");
        assertThat(problem.get("detail").asText()).contains("$out");
        assertThat(raw.getDatabase(databaseName).listCollectionNames().into(new java.util.ArrayList<>())).doesNotContain("documents_archive");
    }

    @Test
    void aMergeNestedInAFacetStillBlocks() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> documents().aggregate(List.of(
                new Document("$facet", new Document("a", List.of(new Document("$merge", new Document("into", "x"))))))).first())
                .isInstanceOf(PreviewWriteBlockedException.class), store);
        assertThat(outcome.blocked()).isTrue();
    }

    @Test
    void anExplicitCreateAndCountAreBlocked() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> client.getDatabase(databaseName).createCollection("fresh"))
                .isInstanceOf(PreviewWriteBlockedException.class), store);
        assertThat(outcome.blocked()).isTrue();
        assertThat(Json.MAPPER.readTree(outcome.problem()).get("detail").asText()).contains("create");
        PreviewOutcome estimated = Harness.preview(() -> assertThatThrownBy(() -> documents().estimatedDocumentCount())
                .isInstanceOf(PreviewWriteBlockedException.class), store);
        assertThat(estimated.blocked()).isTrue();
    }

    @Test
    void creatingACollectionByInsertingIsAllowedAndRollsBack() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> client.getDatabase(databaseName).getCollection("brand_new")
                .insertOne(new Document("_id", 1)), store));
        assertThat(change(envelope, "insert").get("table").asText()).isEqualTo("brand_new");
        assertThat(raw.getDatabase(databaseName).listCollectionNames().into(new java.util.ArrayList<>())).doesNotContain("brand_new");
    }

    @Test
    void aWriteSentWithoutThePreviewSessionFailsThePreviewWith500() throws Exception {
        // The raw client has no session injection: this is the tripwire's job.
        PreviewOutcome outcome = Harness.preview(() -> raw.getDatabase(databaseName).getCollection("documents")
                .insertOne(new Document("_id", "escaped")), store);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.blocked()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
    }

    @Test
    void aForeignSessionIsRefusedAndFailsThePreview() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            try (ClientSession other = raw.startSession()) {
                assertThatThrownBy(() -> documents().insertOne(other, new Document("_id", "foreign")))
                        .isInstanceOf(io.github.mprync.sendproof.core.stores.PreviewTransactionControlException.class);
            }
        }, store);
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("foreign")).isZero();
    }

    @Test
    void aHandlerCommitOrAbortNeverReachesTheServerAndNeverConfirms() throws Exception {
        for (String ending : List.of("commitTransaction", "abortTransaction")) {
            PreviewOutcome outcome = Harness.preview(() -> {
                try (ClientSession session = client.startSession()) {
                    session.startTransaction();
                    documents().insertOne(session, new Document("_id", "ended-" + ending));
                    // The handler catches the refusal and carries on, as a careless one would.
                    try {
                        if (ending.equals("commitTransaction")) {
                            session.commitTransaction();
                        } else {
                            session.abortTransaction();
                        }
                    } catch (RuntimeException swallowed) {
                        // Swallowed.
                    }
                }
            }, store);
            assertThat(outcome.confirmed()).as(ending).isFalse();
            assertThat(outcome.status()).as(ending).isEqualTo(500);
            assertThat(committed("ended-" + ending)).as(ending).isZero();
        }
    }

    @Test
    void aRawCommitTransactionCommandIsRefusedBeforeSending() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> client.getDatabase(databaseName)
                .runCommand(new Document("commitTransaction", 1))).isInstanceOf(RuntimeException.class), store);
        assertThat(outcome.status()).isEqualTo(500);
    }

    @Test
    void aCommitThatReachesTheServerAroundTheGuardTripsTheTripwire() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ClientSession session = client.startSession();
            documents().insertOne(session, new Document("_id", "around"));
            // Through the raw client, with the Preview's own session: no guard sees it, monitoring does.
            raw.getDatabase("admin").runCommand(session, new Document("commitTransaction", 1));
        }, store);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
    }

    @Test
    void theHandlersOwnTransactionJoinsThePreview() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> {
            try (ClientSession session = client.startSession()) {
                session.withTransaction(() -> {
                    documents().insertOne(session, new Document("_id", "joined"));
                    return null;
                });
            }
        }, store));
        assertThat(change(envelope, "insert").get("key").get("_id").asText()).isEqualTo("joined");
        assertThat(committed("joined")).isZero();
    }

    @Test
    void beforeImagesComeFromTheTransactionStartNotFromLaterCommits() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> {
            // The first command establishes the transaction's snapshot.
            documents().find().first();
            // Another request commits a new document after the Preview began.
            // (On another thread, as another request would be: a write on this thread is an escape for the tripwire.)
            Thread other = new Thread(() -> CaptureContext.detached(() -> raw.getDatabase(databaseName).getCollection("documents")
                    .insertOne(new Document("_id", "concurrent").append("name", "Late"))));
            other.start();
            other.join();
            documents().updateMany(new Document(), Updates.set("touched", true));
        }, store));
        for (JsonNode change : envelope.get("changes")) {
            assertThat(change.get("key").get("_id").asText()).as("a document another request committed is not a Preview change")
                    .isEqualTo("seeded");
        }
        assertThat(envelope.get("changes")).hasSize(1);
        assertThat(committed("concurrent")).isEqualTo(1);
    }

    @Test
    void aPreviewThatOutlivesItsTimeLimitIsAbortedAndNeverConfirmed() throws Exception {
        MongoStore quick = MongoStore.builder().previewTimeout(Duration.ofMillis(400)).build();
        MongoClient quickRaw = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .addCommandListener(quick.commandListener()).build());
        try {
            MongoClient quickClient = quick.sync(quickRaw);
            PreviewOutcome outcome = Harness.preview(() -> {
                quickClient.getDatabase(databaseName).getCollection("documents").insertOne(new Document("_id", "slow"));
                Thread.sleep(1200);
                try {
                    quickClient.getDatabase(databaseName).getCollection("documents").insertOne(new Document("_id", "slower"));
                } catch (RuntimeException aborted) {
                    // The transaction is gone: the late write fails.
                }
            }, quick);
            assertThat(outcome.confirmed()).isFalse();
            assertThat(outcome.status()).isEqualTo(500);
            assertThat(committed("slow")).isZero();
            assertThat(committed("slower")).isZero();
        } finally {
            quickRaw.close();
        }
    }

    @Test
    void concurrentPreviewsAndSendsNeverShareASession() throws Exception {
        var results = new AtomicReference<List<PreviewOutcome>>();
        var latch = new CountDownLatch(2);
        var outcomes = java.util.Collections.synchronizedList(new java.util.ArrayList<PreviewOutcome>());
        for (String id : List.of("a", "b")) {
            new Thread(() -> {
                try {
                    outcomes.add(Harness.preview(() -> {
                        documents().insertOne(new Document("_id", "concurrent-" + id));
                        Thread.sleep(150);
                        documents().updateOne(Filters.eq("_id", "concurrent-" + id), Updates.set("n", 1));
                    }, store));
                } catch (Exception error) {
                    throw new AssertionError(error);
                } finally {
                    latch.countDown();
                }
            }).start();
        }
        // A Send in the middle commits normally and outside any Preview session.
        // A Send is a request: its thread is attributed, so it never fails the Previews that are open.
        CaptureContext.detached(() -> documents().insertOne(new Document("_id", "sent")));
        latch.await();
        results.set(outcomes);
        assertThat(outcomes).allSatisfy(outcome -> assertThat(outcome.confirmed()).isTrue());
        assertThat(committed("sent")).isEqualTo(1);
        assertThat(committed("concurrent-a") + committed("concurrent-b")).isZero();
    }

    @Test
    void aWriteConflictBetweenTwoPreviewsReachesTheHandler() throws Exception {
        var conflict = new AtomicReference<Throwable>();
        var firstWrote = new CountDownLatch(1);
        var secondDone = new CountDownLatch(1);
        Thread first = new Thread(() -> {
            try {
                Harness.preview(() -> {
                    documents().updateOne(Filters.eq("_id", "seeded"), Updates.set("name", "first"));
                    firstWrote.countDown();
                    secondDone.await();
                }, store);
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
        first.start();
        firstWrote.await();
        PreviewOutcome second = Harness.preview(() -> {
            try {
                documents().updateOne(Filters.eq("_id", "seeded"), Updates.set("name", "second"));
            } catch (MongoCommandException error) {
                conflict.set(error);
                throw error;
            }
        }, store);
        secondDone.countDown();
        first.join();
        assertThat(conflict.get()).isInstanceOf(MongoCommandException.class);
        assertThat(((MongoCommandException) conflict.get()).getErrorCodeName()).isEqualTo("WriteConflict");
        assertThat(second.confirmed()).isFalse();
    }

    @Test
    void aStandaloneServerRunsInGuardMode() throws Exception {
        // Simulate a standalone server's hello: no setName, no sessions.
        MongoStore guardOnly = MongoStore.builder().build();
        MongoClient own = withListener(guardOnly);
        var standaloneOnOwn = new DelegatingBackend(SyncSupport.backend(own)) {
            @Override
            public BsonDocument command(String database, BsonDocument command, Object session) {
                if (command.containsKey("hello")) {
                    super.command(database, command, session);
                    return new BsonDocument("isWritablePrimary", org.bson.BsonBoolean.TRUE).append("maxWireVersion", new BsonInt32(25));
                }
                return super.command(database, command, session);
            }
        };
        guardOnly.attach(standaloneOnOwn, SessionBinder.NONE);
        MongoDatabase database = guardOnly.guard(own.getDatabase(databaseName));

        assertThat(guardOnly.describe().mode()).isEqualTo("guard");
        assertThat(guardOnly.describe().reason()).contains("doesn't support transactions");
        PreviewOutcome outcome = Harness.preview(() -> {
            // Reads run.
            assertThat(database.getCollection("documents").find().first()).isNotNull();
            assertThatThrownBy(() -> database.getCollection("documents").insertOne(new Document("_id", "nope")))
                    .isInstanceOf(PreviewWriteBlockedException.class);
        }, guardOnly);
        assertThat(outcome.blocked()).isTrue();
        assertThat(committed("nope")).isZero();
    }

    @Test
    void aPreviewKeepsTheModeItBeganIn() throws Exception {
        var failures = new java.util.concurrent.atomic.AtomicInteger(1);
        MongoStore late = MongoStore.builder().build();
        MongoClient own = withListener(late);
        var flaky = new DelegatingBackend(SyncSupport.backend(own)) {
            @Override
            public BsonDocument command(String database, BsonDocument command, Object session) {
                if (command.containsKey("hello") && failures.getAndDecrement() > 0) {
                    throw new IllegalStateException("unreachable");
                }
                return super.command(database, command, session);
            }
        };
        late.attach(flaky, SessionBinder.NONE);
        MongoDatabase database = late.guard(own.getDatabase(databaseName));
        var firstOutcome = new AtomicReference<PreviewOutcome>();
        firstOutcome.set(Harness.preview(() -> {
            // Detection failed when this Preview began, so it runs in guard mode. Detection now succeeds for the next one.
            assertThat(late.describe().mode()).isEqualTo("preview");
            assertThatThrownBy(() -> database.getCollection("documents").insertOne(new Document("_id", "late")))
                    .isInstanceOf(PreviewWriteBlockedException.class);
        }, late));
        assertThat(firstOutcome.get().blocked()).isTrue();
        assertThat(committed("late")).isZero();
    }

    @Test
    void theTripwireIsProvenOnTheGuardedClientItselfNotByOtherClientsCommands() throws Exception {
        // The store's listener is registered on `raw`, but the store is attached to a second client that has none.
        MongoClient bare = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL)).build());
        try {
            MongoStore unproven = MongoStore.builder().build();
            unproven.sync(bare);
            // Commands from `raw`, which does report to the listener, don't count as proof for `bare`.
            raw.getDatabase(databaseName).getCollection("documents").countDocuments();
            assertThat(unproven.describe().mode()).isEqualTo("guard");
            assertThat(unproven.describe().reason()).contains("command listener");
            // So a Preview there guards instead of claiming a rollback it can't verify.
            PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> unproven.guard(bare.getDatabase(databaseName))
                    .getCollection("documents").insertOne(new Document("_id", "x"))).isInstanceOf(PreviewWriteBlockedException.class), unproven);
            assertThat(outcome.blocked()).isTrue();
        } finally {
            bare.close();
        }
        assertThat(store.describe().mode()).as("the client with its own listener").isEqualTo("preview");
    }

    @Test
    void aWriteWithNoRequestAttributionFailsEveryOpenPreviewUnlessDetached() throws Exception {
        for (boolean detached : new boolean[] {false, true}) {
            String id = detached ? "worker-detached" : "worker";
            PreviewOutcome outcome = Harness.preview(() -> {
                documents().find().first();
                Thread worker = new Thread(() -> {
                    Runnable write = () -> raw.getDatabase(databaseName).getCollection("documents").insertOne(new Document("_id", id));
                    if (detached) {
                        CaptureContext.detached(write);
                    } else {
                        write.run();
                    }
                });
                worker.start();
                worker.join();
            }, store);
            assertThat(outcome.confirmed()).as("detached=" + detached).isEqualTo(detached);
            if (!detached) {
                assertThat(outcome.status()).isEqualTo(500);
            }
        }
    }

    @Test
    void aPreviewSessionUsedFromAnotherThreadIsStillThePreviewsOwnWrite() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> {
            ClientSession session = client.startSession();
            Thread other = new Thread(() -> documents().insertOne(session, new Document("_id", "hopped")));
            other.start();
            other.join();
        }, store));
        assertThat(change(envelope, "insert").get("key").get("_id").asText()).isEqualTo("hopped");
        assertThat(committed("hopped")).isZero();
    }

    private final List<MongoClient> extra = new java.util.ArrayList<>();

    /** A client that reports to {@code other}'s listener: the tripwire must be proven on the client a store guards. */
    private MongoClient withListener(MongoStore other) {
        MongoClient made = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .addCommandListener(other.commandListener()).build());
        extra.add(made);
        return made;
    }

    @AfterEach
    void closeExtra() {
        extra.forEach(MongoClient::close);
    }

    private static JsonNode change(JsonNode envelope, String operation) {
        for (JsonNode change : envelope.get("changes")) {
            if (change.get("operation").asText().equals(operation) && change.has("store")) {
                return change;
            }
        }
        throw new AssertionError("No " + operation + " change in " + envelope.get("changes"));
    }

    /** Delegates every call, so a test overrides only what it simulates. */
    private static class DelegatingBackend implements MongoBackend {
        private final MongoBackend delegate;

        DelegatingBackend(MongoBackend delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean reactive() {
            return delegate.reactive();
        }

        @Override
        public Class<?> sessionType() {
            return delegate.sessionType();
        }

        @Override
        public Class<?> clientType() {
            return delegate.clientType();
        }

        @Override
        public Class<?> clusterType() {
            return delegate.clusterType();
        }

        @Override
        public Class<?> databaseType() {
            return delegate.databaseType();
        }

        @Override
        public Class<?> collectionType() {
            return delegate.collectionType();
        }

        @Override
        public Object startTransaction() {
            return delegate.startTransaction();
        }

        @Override
        public String lsid(Object session) {
            return delegate.lsid(session);
        }

        @Override
        public boolean inTransaction(Object session) {
            return delegate.inTransaction(session);
        }

        @Override
        public void abort(Object session) {
            delegate.abort(session);
        }

        @Override
        public void end(Object session) {
            delegate.end(session);
        }

        @Override
        public BsonDocument command(String database, BsonDocument command, Object session) {
            return delegate.command(database, command, session);
        }

        @Override
        public List<BsonDocument> find(String database, String collection, BsonDocument filter, BsonDocument projection,
                                       int limit, Object session) {
            return delegate.find(database, collection, filter, projection, limit, session);
        }

        @Override
        public Object failed(RuntimeException failure) {
            return delegate.failed(failure);
        }
    }
}

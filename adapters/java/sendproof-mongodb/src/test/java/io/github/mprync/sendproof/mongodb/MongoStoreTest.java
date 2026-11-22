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
    void aCommitOfThePreviewSessionThroughAnotherClientIsNeverSent() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ClientSession session = client.startSession();
            documents().insertOne(session, new Document("_id", "around"));
            // Through the raw client, with the handler's session: the driver must refuse it before anything is sent.
            try {
                raw.getDatabase("admin").runCommand(session, new Document("commitTransaction", 1));
            } catch (RuntimeException refused) {
                // A careless handler swallows the refusal.
            }
        }, store);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("around")).as("the Preview transaction must never commit").isZero();
    }

    @Test
    void theHandlersSessionLeadsOnlyToTheGuardedClient() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ClientSession session = client.startSession();
            documents().insertOne(session, new Document("_id", "originator"));
            Object originator = session.getOriginator();
            assertThat(originator).isNotSameAs(raw).isInstanceOf(MongoClient.class);
            assertThat(java.lang.reflect.Proxy.isProxyClass(originator.getClass())).isTrue();
            try {
                ((MongoClient) originator).getDatabase("admin").runCommand(session, new Document("commitTransaction", 1));
            } catch (RuntimeException refused) {
                // Swallowed.
            }
        }, store);
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("originator")).as("the Preview transaction must never commit").isZero();
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
    void aWriteBetweenTheTimeLimitAbortAndTheSessionEndNeverCommits() throws Exception {
        // The time limit aborts the transaction on its own thread while the handler may still be running. A command sent
        // after the abort, while the session is still open, must not run outside the transaction and commit.
        MongoStore quick = MongoStore.builder().previewTimeout(Duration.ofMillis(300)).build();
        MongoClient own = withListener(quick);
        var aborted = new CountDownLatch(1);
        var proceed = new CountDownLatch(1);
        var slowEnd = new DelegatingBackend(SyncSupport.backend(own)) {
            @Override
            public void end(Object session) {
                aborted.countDown();
                try {
                    proceed.await(5, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                super.end(session);
            }
        };
        quick.attach(slowEnd, SessionBinder.NONE);
        MongoDatabase database = quick.guard(own.getDatabase(databaseName));
        PreviewOutcome outcome = Harness.preview(() -> {
            database.getCollection("documents").insertOne(new Document("_id", "before-limit"));
            aborted.await(5, java.util.concurrent.TimeUnit.SECONDS);
            try {
                database.getCollection("documents").insertOne(new Document("_id", "after-abort"));
            } catch (RuntimeException refused) {
                // The Preview is over: the late write is refused.
            } finally {
                proceed.countDown();
            }
        }, quick);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("before-limit")).isZero();
        assertThat(committed("after-abort")).as("a write after the abort must not commit").isZero();
    }

    @Test
    void handlesDerivedWithOtherOptionsStayGuarded() throws Exception {
        var concern = com.mongodb.WriteConcern.W1;
        var primary = com.mongodb.ReadPreference.primary();
        java.util.Map<String, Harness.Handler> writes = new java.util.LinkedHashMap<>();
        writes.put("d1", () -> documents().withWriteConcern(concern).insertOne(new Document("_id", "d1")));
        writes.put("d2", () -> documents().withReadPreference(primary).withReadConcern(com.mongodb.ReadConcern.LOCAL)
                .withDocumentClass(BsonDocument.class).insertOne(new BsonDocument("_id", new org.bson.BsonString("d2"))));
        // (withTimeout is guarded too, but the driver refuses to change timeoutMS inside a transaction.)
        writes.put("d3", () -> documents().withCodecRegistry(MongoClientSettings.getDefaultCodecRegistry())
                .insertOne(new Document("_id", "d3")));
        writes.put("d4", () -> client.getDatabase(databaseName).withWriteConcern(concern).withReadPreference(primary)
                .getCollection("documents", Document.class).insertOne(new Document("_id", "d4")));
        writes.put("d5", () -> client.withWriteConcern(concern).withReadPreference(primary).getDatabase(databaseName)
                .getCollection("documents").insertOne(new Document("_id", "d5")));
        for (var write : writes.entrySet()) {
            // Each write joins the Preview transaction: one that escaped would answer 500, and none commits.
            JsonNode envelope = Harness.envelope(Harness.preview(write.getValue(), store));
            assertThat(change(envelope, "insert").get("key").get("_id").asText()).as(write.getKey()).isEqualTo(write.getKey());
            assertThat(committed(write.getKey())).as(write.getKey()).isZero();
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
        assertThat(guardOnly.describe().reason()).isEqualTo(MongoEngine.STANDALONE_REASON)
                .isEqualTo("Preview unavailable: this MongoDB server doesn't support transactions");
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

    @Test
    void anUnreachableServerRunsInGuardModeWithItsOwnReasonAndIsAskedAgain() throws Exception {
        // Nothing listens here: the hello can't be sent, which says nothing about transactions.
        MongoStore nowhere = MongoStore.builder().build();
        MongoClient unreachable = MongoClients.create(MongoClientSettings.builder()
                .applyConnectionString(new ConnectionString("mongodb://127.0.0.1:1/?directConnection=true"))
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(300, java.util.concurrent.TimeUnit.MILLISECONDS))
                .addCommandListener(nowhere.commandListener()).build());
        extra.add(unreachable);
        nowhere.sync(unreachable);
        assertThat(nowhere.describe().mode()).isEqualTo("guard");
        assertThat(nowhere.describe().reason()).isEqualTo(MongoEngine.UNREACHABLE_REASON).isEqualTo(
                "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode");
        assertThat(MongoEngine.UNREACHABLE_REASON).isNotEqualTo(MongoEngine.STANDALONE_REASON);
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> nowhere.guard(unreachable.getDatabase(databaseName))
                .getCollection("documents").insertOne(new Document("_id", "unreachable")))
                .isInstanceOf(PreviewWriteBlockedException.class), nowhere);
        assertThat(outcome.blocked()).isTrue();

        // Once the server answers, detection runs again and Preview is available.
        var failures = new java.util.concurrent.atomic.AtomicInteger(1);
        MongoStore later = MongoStore.builder().build();
        MongoClient own = withListener(later);
        later.attach(new DelegatingBackend(SyncSupport.backend(own)) {
            @Override
            public BsonDocument command(String database, BsonDocument command, Object session) {
                if (command.containsKey("hello") && failures.getAndDecrement() > 0) {
                    throw new com.mongodb.MongoSocketOpenException("unreachable", new com.mongodb.ServerAddress());
                }
                return super.command(database, command, session);
            }
        }, SessionBinder.NONE);
        assertThat(later.describe().reason()).isEqualTo(MongoEngine.UNREACHABLE_REASON);
        assertThat(later.describe().mode()).isEqualTo("preview");
    }

    @Test
    void aPreviewWhoseAbortIsLostAnswers500AtOnceAndStillReleasesItsLocks() throws Exception {
        raw.getDatabase(databaseName).getCollection("documents").updateOne(Filters.eq("_id", "seeded"), Updates.set("n", 0));
        try (Proxy proxy = new Proxy(URL)) {
            // A store that reaches MongoDB only through the proxy and gives up quickly when it can't: when the
            // connection is cut, the driver's own abort fails and the driver hides that.
            MongoStore proxied = MongoStore.builder().build();
            MongoClient through = MongoClients.create(MongoClientSettings.builder()
                    .applyConnectionString(new ConnectionString("mongodb://127.0.0.1:" + proxy.port() + "/?directConnection=true"))
                    .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(1, java.util.concurrent.TimeUnit.SECONDS))
                    .addCommandListener(proxied.commandListener()).build());
            extra.add(through);
            MongoClient guarded = proxied.sync(through);
            assertThat(proxied.describe().mode()).isEqualTo("preview");
            var restorer = new Thread(() -> {
                try {
                    Thread.sleep(8000);
                } catch (InterruptedException interrupted) {
                    return;
                }
                proxy.restore();
            });
            long[] started = new long[1];
            PreviewOutcome outcome = Harness.preview(() -> {
                guarded.getDatabase(databaseName).getCollection("documents").updateOne(Filters.eq("_id", "seeded"), Updates.inc("n", 1));
                // The network fails after the handler, before the Preview finishes, and stays down for 8 seconds.
                proxy.cut();
                restorer.start();
                started[0] = System.nanoTime();
            }, proxied);
            Duration waited = Duration.ofNanos(System.nanoTime() - started[0]);
            assertThat(waited).as("the reply waited for the network").isLessThan(Duration.ofSeconds(6));
            assertThat(outcome.status()).isEqualTo(500);
            assertThat(outcome.confirmed()).as("a rollback the server never acknowledged is never claimed").isFalse();
            // The session is killed in the background once the network is back; without that the transaction holds its
            // write lock until the server's 60-second lifetime limit.
            var write = java.util.concurrent.CompletableFuture.runAsync(() -> raw.getDatabase(databaseName)
                    .getCollection("documents").updateOne(Filters.eq("_id", "seeded"), Updates.inc("n", 10)));
            write.get(20, java.util.concurrent.TimeUnit.SECONDS);
            Document seeded = raw.getDatabase(databaseName).getCollection("documents").find(Filters.eq("_id", "seeded")).first();
            assertThat(seeded.getInteger("n")).as("nothing of the Preview was committed").isEqualTo(10);
            restorer.join();
        }
    }

    @Test
    void aPreviewWhoseAbortAloneIsLostStillCapturesThenAnswers500AndReleasesItsLocks() throws Exception {
        raw.getDatabase(databaseName).getCollection("documents").updateOne(Filters.eq("_id", "seeded"), Updates.set("n", 0));
        var succeeded = java.util.Collections.synchronizedList(new java.util.ArrayList<String>());
        var failed = java.util.Collections.synchronizedList(new java.util.ArrayList<String>());
        try (Proxy proxy = new Proxy(URL)) {
            MongoStore proxied = MongoStore.builder().build();
            MongoClient through = MongoClients.create(MongoClientSettings.builder()
                    .applyConnectionString(new ConnectionString("mongodb://127.0.0.1:" + proxy.port() + "/?directConnection=true"))
                    .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(1, java.util.concurrent.TimeUnit.SECONDS))
                    .addCommandListener(proxied.commandListener())
                    .addCommandListener(new com.mongodb.event.CommandListener() {
                        @Override
                        public void commandSucceeded(com.mongodb.event.CommandSucceededEvent event) {
                            succeeded.add(event.getCommandName());
                        }

                        @Override
                        public void commandFailed(com.mongodb.event.CommandFailedEvent event) {
                            failed.add(event.getCommandName());
                        }
                    }).build());
            extra.add(through);
            MongoClient guarded = proxied.sync(through);
            assertThat(proxied.describe().mode()).isEqualTo("preview");
            long[] armed = new long[1];
            PreviewOutcome outcome = Harness.preview(() -> {
                guarded.getDatabase(databaseName).getCollection("documents").updateOne(Filters.eq("_id", "seeded"), Updates.inc("n", 1));
                // Only the abort is lost: the proxy closes the connection on it, and every other command goes through.
                proxy.dropAborts(true);
                succeeded.clear();
                armed[0] = System.nanoTime();
            }, proxied);
            assertThat(Duration.ofNanos(System.nanoTime() - armed[0])).isLessThan(Duration.ofSeconds(6));
            assertThat(succeeded).as("change capture read through the proxy").contains("find");
            assertThat(failed).contains("abortTransaction");
            assertThat(outcome.status()).isEqualTo(500);
            assertThat(outcome.confirmed()).as("a rollback the server never acknowledged is never claimed").isFalse();
            // The network is fine, so killSessions ends the transaction straight away.
            long released = System.nanoTime();
            java.util.concurrent.CompletableFuture.runAsync(() -> raw.getDatabase(databaseName).getCollection("documents")
                    .updateOne(Filters.eq("_id", "seeded"), Updates.inc("n", 10))).get(20, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(Duration.ofNanos(System.nanoTime() - released)).isLessThan(Duration.ofSeconds(5));
            assertThat(succeeded).contains("killSessions");
            Document seeded = raw.getDatabase(databaseName).getCollection("documents").find(Filters.eq("_id", "seeded")).first();
            assertThat(seeded.getInteger("n")).as("nothing of the Preview was committed").isEqualTo(10);
        }
    }

    @Test
    void aKillSessionsTryAgainstAnUnreachableServerNeverHoldsTheRetryWindowOpen() throws Exception {
        // Nothing listens here, and the client keeps the driver's default 30-second server selection timeout.
        MongoStore nowhere = MongoStore.builder().build();
        MongoClient unreachable = MongoClients.create(MongoClientSettings.builder()
                .applyConnectionString(new ConnectionString("mongodb://127.0.0.1:1/?directConnection=true"))
                .addCommandListener(nowhere.commandListener()).build());
        extra.add(unreachable);
        nowhere.sync(unreachable);
        long started = System.nanoTime();
        String failure = nowhere.engine().killSession(new BsonDocument("id",
                new org.bson.BsonBinary(UUID.randomUUID(), org.bson.UuidRepresentation.STANDARD)));
        Duration took = Duration.ofNanos(System.nanoTime() - started);
        assertThat(failure).contains("couldn't be reached");
        assertThat(took).as("the whole retry window").isBetween(Duration.ofSeconds(9), Duration.ofSeconds(13));
    }

    @Test
    void aNormalPreviewSendsNoKillSessions() throws Exception {
        var names = java.util.Collections.synchronizedList(new java.util.ArrayList<String>());
        MongoStore watched = MongoStore.builder().build();
        MongoClient own = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .addCommandListener(watched.commandListener())
                .addCommandListener(new com.mongodb.event.CommandListener() {
                    @Override
                    public void commandStarted(com.mongodb.event.CommandStartedEvent event) {
                        names.add(event.getCommandName());
                    }
                }).build());
        extra.add(own);
        MongoClient guarded = watched.sync(own);
        MongoCollection<Document> collection = guarded.getDatabase(databaseName).getCollection("documents");
        Harness.envelope(Harness.preview(() -> collection.insertOne(new Document("_id", "normal")), watched));
        Harness.envelope(Harness.preview(() -> collection.find().first(), watched));
        Harness.envelope(Harness.preview(() -> { }, watched));
        Thread.sleep(500);
        assertThat(names).contains("abortTransaction").doesNotContain("killSessions");
        assertThat(committed("normal")).isZero();
    }

    /** A TCP proxy to the compose MongoDB that can cut every connection and refuse new ones: the network failing. */
    static final class Proxy implements AutoCloseable {
        private final java.net.ServerSocket listener;
        private final List<java.net.Socket> open = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        private volatile boolean down;
        private volatile boolean dropAborts;

        Proxy(String url) throws java.io.IOException {
            var upstream = new com.mongodb.ServerAddress(new ConnectionString(url).getHosts().get(0));
            listener = new java.net.ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
            Thread accept = new Thread(() -> {
                while (!listener.isClosed()) {
                    try {
                        java.net.Socket client = listener.accept();
                        if (down) {
                            client.close();
                            continue;
                        }
                        java.net.Socket server = new java.net.Socket(upstream.getHost(), upstream.getPort());
                        open.add(client);
                        open.add(server);
                        forward(client, server);
                        pump(server, client);
                    } catch (java.io.IOException closed) {
                        // The listener closed, or the upstream refused this connection.
                    }
                }
            }, "mongo-test-proxy");
            accept.setDaemon(true);
            accept.start();
        }

        int port() {
            return listener.getLocalPort();
        }

        /** While set, a connection that carries an {@code abortTransaction} is closed instead, before it reaches the server. */
        void dropAborts(boolean drop) {
            dropAborts = drop;
        }

        /** Copies the driver's requests to the server message by message, so an abort can be recognised and lost. */
        private void forward(java.net.Socket client, java.net.Socket server) {
            Thread thread = new Thread(() -> {
                try {
                    var in = new java.io.DataInputStream(new java.io.BufferedInputStream(client.getInputStream()));
                    var out = server.getOutputStream();
                    while (true) {
                        byte[] header = new byte[4];
                        in.readFully(header);
                        int length = java.nio.ByteBuffer.wrap(header).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();
                        byte[] message = java.util.Arrays.copyOf(header, length);
                        in.readFully(message, 4, length - 4);
                        if (dropAborts && isAbort(message)) {
                            return;
                        }
                        out.write(message);
                        out.flush();
                    }
                } catch (java.io.IOException cut) {
                    // A cut connection.
                } finally {
                    try {
                        client.close();
                        server.close();
                    } catch (java.io.IOException ignored) {
                        // Already closed.
                    }
                }
            });
            thread.setDaemon(true);
            thread.start();
        }

        /** Whether a wire message is an OP_MSG whose body (section kind 0) starts with {@code abortTransaction}. */
        private static boolean isAbort(byte[] message) {
            byte[] name = "abortTransaction\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            // Header (16 bytes, opCode at 12), flag bits (4), section kind (1), document length (4), element type (1).
            int at = 26;
            return message.length >= at + name.length
                    && java.nio.ByteBuffer.wrap(message, 12, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt() == 2013
                    && message[20] == 0
                    && java.util.Arrays.equals(message, at, at + name.length, name, 0, name.length);
        }

        private static void pump(java.net.Socket from, java.net.Socket to) {
            Thread thread = new Thread(() -> {
                try {
                    from.getInputStream().transferTo(to.getOutputStream());
                } catch (java.io.IOException cut) {
                    // A cut connection.
                } finally {
                    try {
                        from.close();
                        to.close();
                    } catch (java.io.IOException ignored) {
                        // Already closed.
                    }
                }
            });
            thread.setDaemon(true);
            thread.start();
        }

        /** Closes every open connection and refuses new ones until {@link #restore}. */
        void cut() throws java.io.IOException {
            down = true;
            synchronized (open) {
                for (java.net.Socket socket : open) {
                    socket.close();
                }
                open.clear();
            }
        }

        void restore() {
            down = false;
        }

        @Override
        public void close() throws java.io.IOException {
            listener.close();
            cut();
        }
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
        public BsonDocument command(String database, BsonDocument command, long timeoutMs) {
            return delegate.command(database, command, timeoutMs);
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

        @Override
        public Object returned(Object value) {
            return delegate.returned(value);
        }
    }
}

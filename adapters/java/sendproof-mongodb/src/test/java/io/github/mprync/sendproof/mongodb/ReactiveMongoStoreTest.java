package io.github.mprync.sendproof.mongodb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.reactivestreams.client.ClientSession;
import com.mongodb.reactivestreams.client.MongoClient;
import com.mongodb.reactivestreams.client.MongoClients;
import com.mongodb.reactivestreams.client.MongoCollection;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.util.List;
import java.util.UUID;
import org.bson.Document;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The reactive streams flavor, which Ktor's coroutine driver sits on: the same hook, blocked on by the tests. */
class ReactiveMongoStoreTest {
    private static final String URL = System.getenv().getOrDefault("BENCH_MONGODB_SERVER_URL",
            "mongodb://127.0.0.1:57017/?directConnection=true");

    private final String databaseName = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private MongoStore store;
    private MongoClient raw;
    private MongoClient client;

    @BeforeEach
    void connect() {
        store = MongoStore.builder().name("catalog").build();
        raw = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(URL))
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(2, java.util.concurrent.TimeUnit.SECONDS))
                .addCommandListener(store.commandListener()).contextProvider((com.mongodb.reactivestreams.client.ReactiveContextProvider)
                        store.reactiveContextProvider()).build());
        try {
            ReactiveBackend.first(raw.getDatabase("admin").runCommand(new Document("hello", 1)));
        } catch (RuntimeException unreachable) {
            raw.close();
            assumeTrue(false, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        }
        client = store.reactive(raw);
        ReactiveBackend.first(raw.getDatabase(databaseName).getCollection("documents").insertOne(new Document("_id", "seeded").append("name", "Seeded")));
    }

    @AfterEach
    void drop() {
        if (raw != null) {
            ReactiveBackend.first(raw.getDatabase(databaseName).drop());
            raw.close();
        }
    }

    private MongoCollection<Document> documents() {
        return client.getDatabase(databaseName).getCollection("documents");
    }

    private long committed(Object id) {
        return ReactiveBackend.first(raw.getDatabase(databaseName).getCollection("documents")
                .countDocuments(new Document("_id", id)));
    }

    @Test
    void aPreviewRollsBackAndReportsChanges() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ReactiveBackend.first(documents().insertOne(new Document("_id", "new").append("name", "Draft").append("password_hash", "h")));
            ReactiveBackend.first(documents().updateOne(new Document("_id", "seeded"), new Document("$set", new Document("name", "Renamed"))));
        }, store);
        JsonNode envelope = Harness.envelope(outcome);
        assertThat(envelope.get("changes")).hasSize(2);
        assertThat(envelope.get("changes").get(0).get("store").asText()).isEqualTo("mongodb");
        assertThat(envelope.toString()).contains("[REDACTED]").doesNotContain("\"h\"");
        assertThat(committed("new")).isZero();
    }

    @Test
    void aWriteAroundTheGuardTripsTheTripwireOnTheDriversOwnThreads() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> ReactiveBackend.first(raw.getDatabase(databaseName)
                .getCollection("documents").insertOne(new Document("_id", "escaped"))), store);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
    }

    @Test
    void aHandlerCommitFailsAsAPublisherAndNeverConfirms() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ClientSession session = ReactiveBackend.first(client.startSession());
            ReactiveBackend.first(documents().insertOne(session, new Document("_id", "ended")));
            assertThatThrownBy(() -> ReactiveBackend.first(session.commitTransaction())).hasMessageContaining("commitTransaction");
        }, store);
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("ended")).isZero();
    }

    @Test
    void theHandlersOwnSessionJoinsThePreviewAsAPublisher() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(() -> {
            // The reactive driver hands out sessions as a Publisher, and so must the guarded client.
            ClientSession session = ReactiveBackend.first(client.startSession());
            session.startTransaction();
            ReactiveBackend.first(documents().insertOne(session, new Document("_id", "joined")));
        }, store));
        assertThat(envelope.get("changes")).hasSize(1);
        assertThat(envelope.get("changes").get(0).get("key").get("_id").asText()).isEqualTo("joined");
        assertThat(committed("joined")).isZero();
    }

    @Test
    void aCommitOfThePreviewSessionThroughAnotherClientIsNeverSent() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> {
            ClientSession session = ReactiveBackend.first(client.startSession());
            ReactiveBackend.first(documents().insertOne(session, new Document("_id", "around")));
            assertThat(session.getOriginator()).isNotSameAs(raw);
            try {
                ReactiveBackend.first(raw.getDatabase("admin").runCommand(session, new Document("commitTransaction", 1)));
            } catch (RuntimeException refused) {
                // Swallowed.
            }
        }, store);
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(committed("around")).as("the Preview transaction must never commit").isZero();
    }

    @Test
    void anOutStageIsBlockedBeforeSending() throws Exception {
        PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> documents().aggregate(List.of(
                new Document("$out", "archive")))).isInstanceOf(PreviewWriteBlockedException.class), store);
        assertThat(outcome.blocked()).isTrue();
    }
}

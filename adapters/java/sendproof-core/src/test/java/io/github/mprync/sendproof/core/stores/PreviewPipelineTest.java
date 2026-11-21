package io.github.mprync.sendproof.core.stores;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.CapturedResponse;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DataStoreSession;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewExecution;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The guard's mark, the pipeline order of spec/data-stores.md and the 409 response. */
@SuppressWarnings("try")
class PreviewPipelineTest {
    private final List<String> events = new ArrayList<>();

    private final class Provider implements PreviewProvider {
        Exception rollbackFailure;

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public PreviewSession begin() {
            events.add("sql begin");
            return new PreviewSession() {
                @Override
                public List<PreviewChange> changes() {
                    return List.of(new PreviewChange("insert", "items", Map.of("id", 1), null, Map.of("id", 1)));
                }

                @Override
                public void rollback() throws Exception {
                    events.add("sql rollback");
                    if (rollbackFailure != null) {
                        throw rollbackFailure;
                    }
                }

                @Override
                public void close() {
                    events.add("sql close");
                }
            };
        }
    }

    private final class Store implements DataStore {
        Exception finishFailure;

        @Override
        public String system() {
            return "mongodb";
        }

        @Override
        public Description describe() {
            return new Description("mongodb", "catalog", "preview", null);
        }

        @Override
        public DataStoreSession begin(RequestCapture capture) {
            events.add("store begin");
            return new DataStoreSession() {
                @Override
                public void finish(RequestCapture c) throws Exception {
                    events.add("store finish");
                    c.change(new PreviewChange("insert", "documents", Map.of("_id", "d1"), null,
                            Map.of("_id", "d1", "password_hash", "h", "profile", Map.of("apiKey", "k", "city", "York")),
                            "mongodb", "catalog", null));
                    if (finishFailure != null) {
                        throw finishFailure;
                    }
                }

                @Override
                public void close() {
                    events.add("store close");
                }
            };
        }
    }

    private record Response(int status) implements CapturedResponse {
        @Override
        public Map<String, List<String>> headers() {
            return Map.of();
        }

        @Override
        public JsonNode body() {
            return null;
        }

        @Override
        public boolean exceededLimit() {
            return false;
        }
    }

    private static PreviewExecution begin(Provider provider, Store... stores) throws Exception {
        var execution = new PreviewExecution(System.nanoTime());
        try (var ignored = CaptureContext.enter(execution.capture())) {
            execution.begin(provider, List.of(stores));
        }
        return execution;
    }

    @Test
    void theGuardDoesNothingOutsideAPreviewAndBlocksAWriteInsideOne() throws Exception {
        StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null);
        var send = new RequestCapture();
        send.begin(false, System.nanoTime());
        try (var ignored = CaptureContext.enter(send)) {
            StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null);
        }
        var preview = new RequestCapture();
        preview.begin(true, System.nanoTime());
        try (var ignored = CaptureContext.enter(preview)) {
            StoreGuard.guard("redis", "GET", CommandKind.READ, null);
            assertThatThrownBy(() -> StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null))
                    .isInstanceOf(PreviewWriteBlockedException.class)
                    .hasMessage("Preview unavailable: this operation writes to Redis");
            assertThatThrownBy(() -> StoreGuard.guard("dynamodb", "PutItem", CommandKind.WRITE, null))
                    .isInstanceOf(PreviewWriteBlockedException.class);
        }
        // The first block wins, and the refused command is logged as a blocked Db entry.
        assertThat(preview.blocked().operation()).isEqualTo("INCR");
        assertThat(preview.blocked().store()).isEqualTo("redis");
        assertThat(preview.finish().logs()).anySatisfy(log -> {
            assertThat(log.level()).isEqualTo("Db");
            assertThat(log.db().blocked()).isTrue();
        });
        assertThat(send.blocked()).isNull();
    }

    @Test
    void aBlockedPreviewAnswers409EvenWhenTheHandlerCaughtTheErrorAndReturned200() throws Exception {
        var provider = new Provider();
        var execution = begin(provider);
        try (var ignored = CaptureContext.enter(execution.capture())) {
            try {
                StoreGuard.guard("redis", "GETDEL", CommandKind.WRITE, null);
            } catch (PreviewWriteBlockedException swallowed) {
                // The handler swallows the refusal.
            }
        }
        execution.markCompleted();
        var outcome = execution.finish(new Response(200), null);

        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.blocked()).isTrue();
        assertThat(outcome.status()).isEqualTo(409);
        JsonNode problem = Json.MAPPER.readTree(outcome.problem());
        assertThat(problem.get("code").asText()).isEqualTo("preview_unavailable");
        assertThat(problem.get("store").asText()).isEqualTo("redis");
        assertThat(problem.get("operation").asText()).isEqualTo("GETDEL");
        assertThat(problem.get("rolledBack").asBoolean()).isFalse();
        assertThat(problem.has("body")).isFalse();
        assertThat(events).containsSubsequence("sql begin", "sql rollback", "sql close");
    }

    @Test
    void aHandlerThatThrowsAfterABlockStillGets409() throws Exception {
        var execution = begin(new Provider());
        try (var ignored = CaptureContext.enter(execution.capture())) {
            assertThatThrownBy(() -> StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null)).isNotNull();
        }
        var outcome = execution.finish(new Response(500), new PreviewWriteBlockedException("redis", "INCR", "x"));
        assertThat(outcome.status()).isEqualTo(409);
        assertThat(outcome.blocked()).isTrue();
    }

    @Test
    void aTransactionControlFaultAnswers500EvenAfterABlock() throws Exception {
        var execution = begin(new Provider());
        try (var ignored = CaptureContext.enter(execution.capture())) {
            assertThat(StoreGuard.refuseInPreview("a handler commit")).isNotNull();
            assertThatThrownBy(() -> StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null)).isNotNull();
        }
        execution.markCompleted();
        var outcome = execution.finish(new Response(200), null);
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(outcome.blocked()).isFalse();
        assertThat(outcome.confirmed()).isFalse();
    }

    @Test
    void storesAbortBeforeSqlRollsBackAndAFailedAbortOutranksABlock() throws Exception {
        var provider = new Provider();
        var store = new Store();
        var execution = begin(provider, store);
        try (var ignored = CaptureContext.enter(execution.capture())) {
            assertThatThrownBy(() -> StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null)).isNotNull();
        }
        store.finishFailure = new IllegalStateException("abort failed");
        execution.markCompleted();
        var outcome = execution.finish(new Response(200), null);

        assertThat(events).containsExactly("sql begin", "store begin", "store finish", "sql rollback", "store close", "sql close");
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(outcome.blocked()).isFalse();
    }

    @Test
    void everyCleanupStepRunsEvenWhenOneStoresAbortAndCloseFail() throws Exception {
        var provider = new Provider();
        var failing = new Store();
        failing.finishFailure = new IllegalStateException("abort failed");
        var second = new Store();
        var execution = begin(provider, failing, second);
        execution.markCompleted();
        var outcome = execution.finish(new Response(200), null);

        // Both stores finish and close and the SQL transaction rolls back, whatever one of them throws.
        assertThat(events.stream().filter("store finish"::equals).count()).isEqualTo(2);
        assertThat(events.stream().filter("store close"::equals).count()).isEqualTo(2);
        assertThat(events).contains("sql rollback", "sql close");
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(outcome.confirmed()).isFalse();
    }

    @Test
    void aFailedSqlRollbackOutranksABlock() throws Exception {
        var provider = new Provider();
        provider.rollbackFailure = new IllegalStateException("rollback failed");
        var execution = begin(provider);
        try (var ignored = CaptureContext.enter(execution.capture())) {
            assertThatThrownBy(() -> StoreGuard.guard("redis", "INCR", CommandKind.WRITE, null)).isNotNull();
        }
        execution.markCompleted();
        assertThat(execution.finish(new Response(200), null).status()).isEqualTo(500);
    }

    @Test
    void aConfirmedPreviewMergesStoreChangesAndRedactsNestedSecrets() throws Exception {
        var execution = begin(new Provider(), new Store());
        execution.markCompleted();
        var outcome = execution.finish(new Response(201), null);

        assertThat(outcome.confirmed()).isTrue();
        JsonNode envelope = Json.MAPPER.readTree(outcome.json());
        JsonNode changes = envelope.get("changes");
        assertThat(changes).hasSize(2);
        JsonNode document = changes.get(1);
        assertThat(document.get("store").asText()).isEqualTo("mongodb");
        assertThat(document.get("namespace").asText()).isEqualTo("catalog");
        assertThat(document.get("after").get("password_hash").asText()).isEqualTo("[REDACTED]");
        assertThat(document.get("after").get("profile").get("apiKey").asText()).isEqualTo("[REDACTED]");
        assertThat(document.get("after").get("profile").get("city").asText()).isEqualTo("York");
        assertThat(changes.get(0).has("store")).isFalse();
    }

    @Test
    void aPreviewRunsWithoutASqlProviderWhenOnlyStoresAreHooked() throws Exception {
        var execution = begin(null, new Store());
        try (var ignored = CaptureContext.enter(execution.capture())) {
            execution.capture().db(DbEntry.of("mongodb", "find").withTarget("documents").withElapsed(1.5));
        }
        execution.markCompleted();
        var outcome = execution.finish(new Response(200), null);

        assertThat(outcome.confirmed()).isTrue();
        JsonNode envelope = Json.MAPPER.readTree(outcome.json());
        assertThat(envelope.get("logs").get(0).get("db").get("system").asText()).isEqualTo("mongodb");
        assertThat(envelope.get("logs").get(0).get("message").asText()).isEqualTo("find documents");
        assertThat(events).containsExactly("store begin", "store finish", "store close");
    }

    @Test
    void theGuardChecksFailWhenTheHookIsRemoved() throws Exception {
        // The negative test: without the guard call a write sails through and the Preview confirms. The conformance
        // checks (and the hooks' own tests) assert a 409 for this exact scenario, so they fail when a hook is unhooked.
        var execution = begin(new Provider());
        execution.markCompleted();
        assertThat(execution.finish(new Response(200), null).blocked()).isFalse();
    }
}

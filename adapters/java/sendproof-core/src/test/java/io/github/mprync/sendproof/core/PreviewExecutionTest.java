package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class PreviewExecutionTest {

    private static final class Provider implements PreviewProvider {
        final AtomicInteger rolledBack = new AtomicInteger();
        final AtomicInteger closed = new AtomicInteger();
        Exception rollbackFailure;
        Exception closeFailure;
        Exception beginFailure;

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public PreviewSession begin() throws Exception {
            if (beginFailure != null) {
                throw beginFailure;
            }
            return new PreviewSession() {
                @Override
                public List<PreviewChange> changes() {
                    return List.of(new PreviewChange("insert", "items", Map.of("id", 1), null, Map.of("id", 1)));
                }

                @Override
                public void rollback() throws Exception {
                    rolledBack.incrementAndGet();
                    if (rollbackFailure != null) {
                        throw rollbackFailure;
                    }
                }

                @Override
                public void close() throws Exception {
                    closed.incrementAndGet();
                    if (closeFailure != null) {
                        throw closeFailure;
                    }
                }
            };
        }
    }

    private record Response(int status, boolean exceeded) implements CapturedResponse {
        @Override
        public Map<String, List<String>> headers() {
            return Map.of("Content-Type", List.of("application/json"), "Set-Cookie", List.of("a=b"),
                    "Location", List.of("/x"), "X-Custom", List.of("v"));
        }

        @Override
        public JsonNode body() {
            return new TextNode("ok");
        }

        @Override
        public boolean exceededLimit() {
            return exceeded;
        }
    }

    @Test
    void aCompletedPreviewIsConfirmedAfterRollbackAndDisposal() throws Exception {
        var provider = new Provider();
        var execution = new PreviewExecution(System.nanoTime());
        execution.begin(provider);
        execution.markCompleted();
        var outcome = execution.finish(new Response(201, false), null);

        assertThat(outcome.confirmed()).isTrue();
        assertThat(provider.rolledBack).hasValue(1);
        assertThat(provider.closed).hasValue(1);
        var envelope = Json.MAPPER.readTree(outcome.json());
        assertThat(envelope.get("rolledBack").asBoolean()).isTrue();
        assertThat(envelope.get("status").asInt()).isEqualTo(201);
        assertThat(envelope.get("headers").has("set-cookie")).isFalse();
        assertThat(envelope.get("headers").has("location")).isFalse();
        assertThat(envelope.get("headers").get("x-custom").asText()).isEqualTo("v");
        assertThat(outcome.serverTiming()).startsWith("auth;dur=");
    }

    @Test
    void aFailedRollbackIsNeverConfirmedButStillDisposes() throws Exception {
        var provider = new Provider();
        provider.rollbackFailure = new IllegalStateException("injected");
        var execution = new PreviewExecution(System.nanoTime());
        execution.begin(provider);
        execution.markCompleted();
        var outcome = execution.finish(new Response(200, false), null);

        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(provider.closed).hasValue(1);
    }

    @Test
    void aHandlerFailureRollsBackAndIsNotConfirmed() throws Exception {
        var provider = new Provider();
        var execution = new PreviewExecution(System.nanoTime());
        execution.begin(provider);
        var outcome = execution.finish(new Response(500, false), new IllegalStateException("boom"));

        assertThat(outcome.confirmed()).isFalse();
        assertThat(outcome.status()).isEqualTo(500);
        assertThat(provider.rolledBack).hasValue(1);
        assertThat(provider.closed).hasValue(1);
    }

    @Test
    void anOversizedResponseIsRejectedWith413() throws Exception {
        var provider = new Provider();
        var execution = new PreviewExecution(System.nanoTime());
        execution.begin(provider);
        execution.markCompleted();
        var outcome = execution.finish(new Response(200, true), new PreviewResponseTooLargeException());

        assertThat(outcome.status()).isEqualTo(413);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(provider.rolledBack).hasValue(1);
    }

    @Test
    void aDisposalFailureWithholdsConfirmation() throws Exception {
        var provider = new Provider();
        provider.closeFailure = new IllegalStateException("close");
        var execution = new PreviewExecution(System.nanoTime());
        execution.begin(provider);
        execution.markCompleted();

        assertThat(execution.finish(new Response(200, false), null).confirmed()).isFalse();
    }

    @Test
    void aProviderThatCannotBeginNeverReachesTheHandler() {
        var provider = new Provider();
        provider.beginFailure = new IllegalStateException("no connection");
        var execution = new PreviewExecution(System.nanoTime());
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, () -> execution.begin(provider));
        var outcome = execution.finish(new Response(500, false), null);
        assertThat(outcome.confirmed()).isFalse();
        assertThat(provider.closed).hasValue(0);
    }

    @Test
    void anUnexecutedRequestMapsTheHostStatus() {
        var execution = new PreviewExecution(System.nanoTime());
        assertThat(execution.finish(new Response(401, false), null).status()).isEqualTo(401);
        execution = new PreviewExecution(System.nanoTime());
        assertThat(execution.finish(new Response(403, false), null).status()).isEqualTo(403);
        execution = new PreviewExecution(System.nanoTime());
        assertThat(execution.finish(new Response(302, false), null).status()).isEqualTo(401);
        execution = new PreviewExecution(System.nanoTime());
        assertThat(execution.finish(new Response(200, false), null).status()).isEqualTo(409);
        execution = new PreviewExecution(System.nanoTime());
        assertThat(execution.finish(new Response(503, false), null).status()).isEqualTo(503);
    }
}

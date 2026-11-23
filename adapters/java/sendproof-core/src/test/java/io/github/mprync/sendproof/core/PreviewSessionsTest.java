package io.github.mprync.sendproof.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class PreviewSessionsTest {
    private static final TraceOwner ADMIN = TraceOwner.of("cookie", "admin", "/tenant");
    private static final TraceOwner VIEWER = TraceOwner.of("cookie", "viewer", "/tenant");

    @Test
    void rejectsForeignAndOverlappingRequestsAndLimitsAdmission() {
        try (var sessions = new PreviewSessions()) {
            HeldStore store = new HeldStore();
            var opened = sessions.open(ADMIN, null, List.of(store));
            assertThat(opened.id()).matches("[0-9a-f]{32}");
            assertCode("session_not_found", () -> sessions.enter(opened.id(), VIEWER));
            assertCode("session_not_found", () -> sessions.enter(opened.id(), PreviewSessions.owner(null, false, "/tenant")));
            try (var lease = sessions.enter(opened.id(), ADMIN)) {
                assertCode("session_busy", () -> sessions.enter(opened.id(), ADMIN));
            }
            for (int i = 1; i < 4; i++) {
                sessions.open(ADMIN, null, List.of(store));
            }
            assertCode("session_limit", () -> sessions.open(ADMIN, null, List.of(store)));
            try (var lease = sessions.enter(opened.id(), ADMIN)) {
                lease.end();
            }
            assertCode("session_not_found", () -> sessions.enter(opened.id(), ADMIN));
            sessions.open(ADMIN, null, List.of(store));
        }
    }

    @Test
    void closesIdleAndExpiredSessionsAndDefersActiveCleanup() {
        var time = new AtomicLong();
        var store = new HeldStore();
        try (var sessions = new PreviewSessions(1, 10, time::get)) {
            var idle = sessions.open(ADMIN, null, List.of(store));
            Transaction first = store.transaction;
            time.set(Duration.ofSeconds(1).toNanos());
            sessions.expire();
            assertThat(first.closed).isTrue();
            assertCode("session_not_found", () -> sessions.enter(idle.id(), ADMIN));

            var running = sessions.open(ADMIN, null, List.of(store));
            try (var lease = sessions.enter(running.id(), ADMIN)) {
                time.set(Duration.ofSeconds(12).toNanos());
                sessions.expire();
                assertThat(store.transaction.closed).isFalse();
                assertCode("session_not_found", () -> sessions.enter(running.id(), ADMIN));
            }
            assertThat(store.transaction.closed).isTrue();
            sessions.open(ADMIN, null, List.of(store));
            assertThat(store.transaction.closed).isFalse();
        }
        assertThat(store.transaction.closed).isTrue();
    }

    @Test
    void refusedStepDoesNotAdvanceOrDiscardEarlierWrites() throws Exception {
        var store = new HeldStore();
        try (var sessions = new PreviewSessions()) {
            String id = sessions.open(ADMIN, null, List.of(store)).id();
            assertThat(step(sessions, id, store.transaction, 201).confirmed()).isTrue();
            assertThat(step(sessions, id, store.transaction, 500).status()).isEqualTo(500);
            assertThat(store.transaction.value).isEqualTo(1);
            var result = step(sessions, id, store.transaction, 201);
            assertThat(Json.MAPPER.readTree(result.json()).path("session").path("step").asInt()).isEqualTo(2);
            try (var lease = sessions.enter(id, ADMIN)) {
                lease.rewind(2);
                assertThat(store.transaction.value).isEqualTo(1);
                lease.rewind(1);
                assertThat(store.transaction.value).isZero();
            }
        }
    }

    @Test
    void failedAcquisitionReleasesEarlierStoresAndReturnsProtocolProblem() {
        try (var sessions = new PreviewSessions()) {
            var store = new HeldStore();
            var busy = new HeldStore() {
                @Override
                public HeldPreview beginHeldStore() throws HeldPreview.StoreBusy {
                    throw new HeldPreview.StoreBusy("fixture.db");
                }
            };
            var problem = assertThrows(PreviewSessions.Refusal.class, () -> sessions.open(ADMIN, null, List.of(store, busy)));
            assertThat(problem.problem()).containsEntry("code", "store_busy").containsEntry("idleTimeoutSeconds", 300);
            assertThat(store.transaction.closed).isTrue();
        }
    }

    private static PreviewOutcome step(PreviewSessions sessions, String id, Transaction transaction, int status) throws Exception {
        var execution = new PreviewExecution(System.nanoTime());
        execution.join(sessions, id, ADMIN);
        execution.begin(null);
        transaction.value++;
        execution.markCompleted();
        return execution.finish(new Response(status), null);
    }

    private static void assertCode(String code, Runnable call) {
        assertThat(assertThrows(PreviewSessions.Refusal.class, call::run).problem()).containsEntry("code", code);
    }

    private static class HeldStore implements DataStore {
        Transaction transaction;

        @Override
        public String system() {
            return "fixture";
        }

        @Override
        public Description describe() {
            return new Description(system(), null, "preview", null);
        }

        @Override
        public boolean supportsHeldStore() {
            return true;
        }

        @Override
        public HeldPreview beginHeldStore() throws HeldPreview.StoreBusy {
            transaction = new Transaction();
            return transaction;
        }
    }

    private static final class Transaction implements HeldPreview {
        int value;
        boolean closed;

        @Override
        public Step begin(RequestCapture capture) {
            return () -> { };
        }

        @Override
        public Checkpoint checkpoint() {
            int before = value;
            return () -> value = before;
        }

        @Override
        public void close() {
            value = 0;
            closed = true;
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
}

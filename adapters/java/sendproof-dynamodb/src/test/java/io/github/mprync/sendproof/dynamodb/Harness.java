package io.github.mprync.sendproof.dynamodb;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.CapturedResponse;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewExecution;
import io.github.mprync.sendproof.core.PreviewOutcome;
import java.util.List;
import java.util.Map;

/** Runs a handler as a Preview or as an observed capture, the way a framework adapter does. */
@SuppressWarnings("try")
final class Harness {
    private Harness() {
    }

    @FunctionalInterface
    interface Handler {
        void run() throws Exception;
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

    static PreviewOutcome preview(Handler handler) throws Exception {
        var execution = new PreviewExecution(System.nanoTime());
        Throwable failure = null;
        PreviewOutcome outcome;
        try (var ignored = CaptureContext.enter(execution.capture())) {
            execution.begin(null, List.of());
            try {
                handler.run();
                execution.markCompleted();
            } catch (Throwable error) {
                failure = error;
            }
            outcome = execution.finish(new Response(200), failure);
        }
        return outcome;
    }

    static JsonNode envelope(PreviewOutcome outcome) throws Exception {
        if (!outcome.confirmed()) {
            throw new AssertionError("Expected a confirmed Preview but got " + outcome.status()
                    + (outcome.blocked() ? " " + new String(outcome.problem()) : ""));
        }
        return Json.MAPPER.readTree(outcome.json());
    }
}

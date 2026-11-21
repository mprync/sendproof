package io.github.mprync.sendproof.redis;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.CapturedResponse;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.PreviewExecution;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.List;
import java.util.Map;

/** Runs a handler as a Preview, or as an observed send, the way a framework adapter does. */
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

    static PreviewOutcome preview(Handler handler, DataStore... stores) throws Exception {
        var execution = new PreviewExecution(System.nanoTime());
        Throwable failure = null;
        PreviewOutcome outcome;
        try (var ignored = CaptureContext.enter(execution.capture())) {
            execution.begin(null, List.of(stores));
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

    /** Runs a handler under an observed-send capture (a trace) and returns it. */
    static RequestCapture observed(Handler handler) throws Exception {
        var capture = new RequestCapture();
        capture.begin(false, System.nanoTime());
        try (var ignored = CaptureContext.enter(capture)) {
            handler.run();
        }
        return capture;
    }

    static JsonNode envelope(PreviewOutcome outcome) throws Exception {
        if (!outcome.confirmed()) {
            throw new AssertionError("Expected a confirmed Preview but got " + outcome.status()
                    + (outcome.blocked() ? " " + new String(outcome.problem()) : ""));
        }
        return Json.MAPPER.readTree(outcome.json());
    }
}

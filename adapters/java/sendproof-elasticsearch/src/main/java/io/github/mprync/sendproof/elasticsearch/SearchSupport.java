package io.github.mprync.sendproof.elasticsearch;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreClassifier.Classified;
import io.github.mprync.sendproof.core.stores.StoreRedaction;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

/**
 * What the Elasticsearch and the OpenSearch hooks share: they differ in the client library they decorate, not in how a
 * request is classified or logged.
 */
final class SearchSupport {
    private SearchSupport() {
    }

    /** The store a hook reports to: its host-declared reads, and the guard-and-log entry point. */
    interface Starter {
        /** Guards the classified request and starts its {@code Db} entry; throws when a Preview must refuse it. */
        Observation start(Classified classified, String target, String statement);

        Set<String> hostReads();
    }

    /** Computes the request body lines at most once. */
    private static final class Lines implements Supplier<List<String>> {
        private final Supplier<List<String>> source;
        private List<String> lines;

        Lines(Supplier<List<String>> source) {
            this.source = source;
        }

        @Override
        public List<String> get() {
            if (lines == null) {
                try {
                    lines = source.get();
                } catch (RuntimeException unreadable) {
                    lines = List.of();
                }
            }
            return lines;
        }
    }

    /**
     * Classifies a request, refuses it when it is a write during a Preview, and starts its log entry.
     *
     * @param method the HTTP method
     * @param path   the request path, without the client's prefix; a query string is ignored
     * @param lines  the body as JSON text, one entry per NDJSON line, or empty; read only when it is needed
     */
    static Observation begin(Starter starter, String method, String path, Supplier<List<String>> lines) {
        var body = new Lines(lines);
        Classified classified = StoreClassifier.search(method, path, null, starter.hostReads());
        if (classified.operation().equals("sql.query")) {
            // A SQL endpoint is a read only when the body's query is one SELECT, SHOW or DESCRIBE.
            List<String> all = body.get();
            classified = StoreClassifier.search(method, path, all.size() == 1 ? all.get(0) : null, starter.hostReads());
        }
        String statement = CaptureContext.current() == null ? null : statement(body.get());
        return starter.start(classified, StoreClassifier.searchTarget(path), statement);
    }

    /** The body with every literal replaced by {@code ?}, one line per NDJSON line; {@code null} when there is none. */
    static String statement(List<String> lines) {
        if (lines.isEmpty()) {
            return null;
        }
        var out = new StringBuilder();
        for (String line : lines) {
            if (line.isBlank()) {
                continue;
            }
            if (out.length() > 0) {
                out.append('\n');
            }
            try {
                out.append(StoreRedaction.sanitizeDocument(Json.MAPPER.convertValue(Json.MAPPER.readTree(line), Object.class)));
            } catch (java.io.IOException | IllegalArgumentException notJson) {
                out.append('?');
            }
        }
        return out.length() == 0 ? null : out.toString();
    }
}

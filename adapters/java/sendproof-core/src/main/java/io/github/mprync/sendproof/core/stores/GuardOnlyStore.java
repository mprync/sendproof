package io.github.mprync.sendproof.core.stores;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DataStoreSession;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.Set;

/**
 * The shared part of the batch-two stores (Cassandra, Elasticsearch, OpenSearch, Cosmos DB, Firestore), all of which
 * run in {@code guard} mode: reads run, and the first write of a Preview is refused before it is sent.
 *
 * <p>A hook classifies each command with {@link StoreClassifier}, then calls {@link #observe}. That refuses a write
 * during a Preview ({@link PreviewWriteBlockedException}, the Preview's blocked mark, a blocked {@code Db} entry) and
 * otherwise returns an {@link Observation} the hook completes when the reply arrives, which records the {@code Db}
 * entry on the capture that was current when the command was sent.
 *
 * <p>Taking part in a Preview is only bookkeeping: {@link #begin} remembers that the Preview is open, so a write that
 * arrives with no request attribution can fail it ({@link StoreGuard#guardCall}).
 */
public abstract class GuardOnlyStore implements DataStore {
    private final String system;
    private final String name;
    private final Set<String> reads;

    /**
     * @param system the store id
     * @param name   a display label, or {@code null}
     * @param reads  host-declared reads (exact operation names), or {@code null}
     */
    protected GuardOnlyStore(String system, String name, Set<String> reads) {
        this.system = system;
        this.name = name;
        this.reads = reads;
    }

    @Override
    public final String system() {
        return system;
    }

    @Override
    public Description describe() {
        return new Description(system, name, "guard", null);
    }

    /** The host-declared reads, or {@code null}. */
    protected final Set<String> reads() {
        return reads;
    }

    @Override
    @SuppressWarnings("try")
    public final DataStoreSession begin(RequestCapture capture) {
        AutoCloseable open = StoreGuard.openPreview(capture);
        return new DataStoreSession() {
            @Override
            public void finish(RequestCapture finished) {
                // Nothing to capture or abort: the guard refused every write before it was sent.
            }

            @Override
            public void close() throws Exception {
                open.close();
            }
        };
    }

    /**
     * Guards one classified command and starts its {@code Db} entry. A connection-level (session) command is allowed and
     * never logged.
     *
     * @param target    the table, index or container, or {@code null}
     * @param namespace the keyspace or database, or {@code null}
     * @param statement the sanitized statement, which never carries a value, or {@code null}
     * @return what to complete when the reply arrives
     * @throws PreviewWriteBlockedException when a write is refused during a Preview
     */
    protected final Observation observe(StoreClassifier.Classified classified, String target, String namespace, String statement) {
        StoreGuard.guardCall(system, classified.operation(), classified.kind(), null);
        RequestCapture capture = CaptureContext.current();
        if (capture == null || classified.kind() == CommandKind.SESSION) {
            return Observation.NONE;
        }
        DbEntry entry = DbEntry.of(system, classified.operation());
        if (target != null) {
            entry = entry.withTarget(target);
        }
        if (namespace != null) {
            entry = entry.withNamespace(namespace);
        }
        if (statement != null) {
            entry = entry.withStatement(statement);
        }
        return new Observation(capture, entry, System.nanoTime());
    }

    /** A command that was allowed and is on its way; complete it once, with the reply or the failure. */
    public static final class Observation {
        /** What a hook gets for a command that isn't logged. */
        static final Observation NONE = new Observation(null, null, 0);

        private final RequestCapture capture;
        private DbEntry entry;
        private final long startedNanos;
        private boolean done;

        private Observation(RequestCapture capture, DbEntry entry, long startedNanos) {
            this.capture = capture;
            this.entry = entry;
            this.startedNanos = startedNanos;
        }

        /** Whether the command is being logged: false outside a capture and for a session command. */
        public boolean logged() {
            return capture != null;
        }

        /**
         * Adds what is only known once the request message has been seen (a streaming call's first message), before the
         * entry is recorded. A {@code null} argument leaves the field as it was; the statement must not carry a value.
         */
        public synchronized void describe(String target, String namespace, String statement) {
            if (capture == null || done) {
                return;
            }
            if (target != null) {
                entry = entry.withTarget(target);
            }
            if (namespace != null) {
                entry = entry.withNamespace(namespace);
            }
            if (statement != null) {
                entry = entry.withStatement(statement);
            }
        }

        /**
         * Records the entry. Later calls do nothing.
         *
         * @param rows    documents, rows or items returned or matched, or {@code null} when unknown
         * @param failure what the store answered with, or {@code null}; only its type name is kept
         */
        public void complete(Integer rows, Throwable failure) {
            finish(rows, failure == null ? null : failure.getClass().getSimpleName());
        }

        /**
         * Records the entry. Later calls do nothing.
         *
         * @param rows  documents, rows or items returned or matched, or {@code null} when unknown
         * @param error the store's error code name, such as {@code NOT_FOUND}, or {@code null} for success
         */
        public synchronized void finish(Integer rows, String error) {
            if (capture == null || done) {
                return;
            }
            done = true;
            DbEntry finished = entry.withRows(rows).withElapsed((System.nanoTime() - startedNanos) / 1_000_000.0);
            if (error != null) {
                finished = finished.withError(error);
            }
            capture.db(finished);
        }
    }
}

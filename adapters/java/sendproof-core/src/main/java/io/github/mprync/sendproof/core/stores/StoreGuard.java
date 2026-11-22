package io.github.mprync.sendproof.core.stores;

import io.github.mprync.sendproof.core.BlockedWrite;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * The write guard of {@code spec/data-stores.md}: the single decision point every store hook calls before it sends a
 * command, plus the helpers hooks share.
 *
 * <p>Outside a Preview the guard does nothing, so Send and observed Send are never blocked. In a Preview it records the
 * first refused write on the request's capture and throws {@link PreviewWriteBlockedException}. The capture's mark, not
 * the handler's response, decides the outcome: a handler that catches the exception and returns 200 still produces a
 * 409.
 */
public final class StoreGuard {
    private static final Map<String, String> NAMES = Map.of("mongodb", "MongoDB", "redis", "Redis", "dynamodb", "DynamoDB",
            "cassandra", "Cassandra", "elasticsearch", "Elasticsearch", "opensearch", "OpenSearch", "cosmosdb", "Cosmos DB",
            "firestore", "Firestore");

    /** The Previews that are open now, as far as batch-two guard hooks know (see {@link GuardOnlyStore}). */
    private static final Set<RequestCapture> OPEN = java.util.concurrent.ConcurrentHashMap.newKeySet();

    private StoreGuard() {
    }

    /** Registers an open Preview until the returned handle closes; hooks that have no session of their own use it through {@link GuardOnlyStore}. */
    static AutoCloseable openPreview(RequestCapture capture) {
        OPEN.add(capture);
        return () -> OPEN.remove(capture);
    }

    /**
     * Like {@link #guard(String, String, CommandKind, String)}, for the batch-two hooks, with the attribution rule: a write
     * on a thread with no request behind it while a Preview is open could be that Preview's own write, sent from a thread
     * the capture didn't follow. Nothing can say it isn't, so it is refused before it is sent and every open Preview is blocked (409). Work
     * that belongs to no request (a scheduler, a background worker) runs inside {@link CaptureContext#detached} to be
     * exempt.
     */
    public static void guardCall(String store, String operation, CommandKind kind, String detail) {
        RequestCapture preview = currentPreview();
        if (preview == null && kind == CommandKind.WRITE && CaptureContext.current() == null && !CaptureContext.attributed()
                && !OPEN.isEmpty()) {
            // Treated as the open Previews' own write: refused before it is sent, and every open Preview is blocked (409).
            String reason = detail != null ? detail : writeReason(store);
            for (RequestCapture open : OPEN) {
                open.block(new BlockedWrite(store, operation, reason));
                open.db(DbEntry.blocked(store, operation));
            }
            throw new PreviewWriteBlockedException(store, operation, reason);
        }
        guard(preview, store, operation, kind, detail);
    }

    /** The display name of a store id; unknown ids are shown as given. */
    public static String storeName(String store) {
        return NAMES.getOrDefault(store, store);
    }

    /** The reason shown for a write to a guarded store: {@code Preview unavailable: this operation writes to Redis}. */
    public static String writeReason(String store) {
        return "Preview unavailable: this operation writes to " + storeName(store);
    }

    /** The reason for a command MongoDB refuses inside a transaction. */
    public static String refusedReason(String operation) {
        return "Preview unavailable: MongoDB can't run " + operation + " inside a transaction";
    }

    /** The capture of the Preview running on this thread, or {@code null} outside a Preview. */
    public static RequestCapture currentPreview() {
        RequestCapture capture = CaptureContext.current();
        return capture != null && capture.inPreviewScope() ? capture : null;
    }

    /**
     * Call before sending a store command. Does nothing outside a Preview or for anything but a write. In a Preview it
     * marks the capture blocked (the first block wins), logs a blocked {@code Db} entry and throws.
     *
     * @param detail replaces the default "writes to &lt;Store&gt;" reason, or {@code null}
     * @throws PreviewWriteBlockedException when a write is refused
     */
    public static void guard(String store, String operation, CommandKind kind, String detail) {
        guard(currentPreview(), store, operation, kind, detail);
    }

    /** Same as {@link #guard(String, String, CommandKind, String)} for a capture the caller already holds. */
    public static void guard(RequestCapture capture, String store, String operation, CommandKind kind, String detail) {
        if (kind != CommandKind.WRITE || capture == null) {
            return;
        }
        String reason = detail != null ? detail : writeReason(store);
        capture.block(new BlockedWrite(store, operation, reason));
        capture.db(DbEntry.blocked(store, operation));
        throw new PreviewWriteBlockedException(store, operation, reason);
    }

    /**
     * Refuses something that would end or escape the Preview transaction. Records the fault on the current Preview, so
     * the Preview fails with 500 even if the handler catches the exception, and returns it for the caller to throw.
     * Outside a Preview it returns {@code null}.
     */
    public static PreviewTransactionControlException refuseInPreview(String message) {
        RequestCapture capture = currentPreview();
        if (capture == null) {
            return null;
        }
        var failure = new PreviewTransactionControlException(message);
        capture.refuse(failure);
        return failure;
    }

    /**
     * Validates the optional label a host gives a store for capabilities {@code dataStores}. Discovery is shown to anyone
     * who can open the workbench, so the label must be a display name such as {@code catalog}: never a connection
     * string, URL, host:port, user or password.
     *
     * @return the label, or {@code null} when none was given
     */
    public static String storeLabel(String name) {
        if (name == null) {
            return null;
        }
        if (name.isBlank() || name.length() > 64 || name.chars().anyMatch(c -> Character.isISOControl(c) || "/\\@=;:?#%".indexOf(c) >= 0)) {
            throw new IllegalArgumentException(
                    "A data store name must be a display label such as \"catalog\", not a connection string, URL or host.");
        }
        return name;
    }

    /**
     * Normalizes host-declared reads into an exact-match set.
     *
     * @param transform how each name is normalized before it is compared (for example upper-casing)
     * @return the set, or {@code null} when no names were given
     */
    public static Set<String> readSet(List<String> names, UnaryOperator<String> transform) {
        if (names == null || names.isEmpty()) {
            return null;
        }
        var set = new LinkedHashSet<String>();
        for (String name : names) {
            if (name == null || name.isEmpty() || name.chars().anyMatch(c -> c == '*' || c == '?' || Character.isWhitespace(c))) {
                throw new IllegalArgumentException("treatAsRead takes exact command names, without wildcards.");
            }
            set.add(transform.apply(name));
        }
        return Set.copyOf(set);
    }

    /** Upper-cases a name the way Redis and DynamoDB reads are compared. */
    public static String upper(String name) {
        return name.toUpperCase(Locale.ROOT);
    }
}

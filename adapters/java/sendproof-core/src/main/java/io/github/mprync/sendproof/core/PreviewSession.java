package io.github.mprync.sendproof.core;

import java.util.List;

/**
 * A rollback-only unit of work for one preview. The core calls {@link #rollback()} once the handler and its response
 * callbacks finish, then {@link #close()} on every path, including failures.
 */
public interface PreviewSession extends AutoCloseable {

    /** Returns snapshots of the changes captured so far. Available until {@link #close()}. */
    List<PreviewChange> changes();

    /** Returns whether the provider omitted changes because it reached a capture limit. */
    default boolean changesTruncated() {
        return false;
    }

    /**
     * Rolls back every write made through the session. A failure prevents the preview from being confirmed.
     *
     * @throws Exception when the rollback cannot be confirmed
     */
    void rollback() throws Exception;

    /** Releases resources. Must be safe after a failed or completed rollback. */
    @Override
    void close() throws Exception;
}

package io.github.mprync.sendproof.core;

import java.util.List;

/** Captures row changes during an ordinary (committing) send. It never manages the transaction. */
public interface PreviewObservation extends AutoCloseable {

    /** Returns snapshots of the changes captured so far. Available until {@link #close()}. */
    List<PreviewChange> changes();

    /** Returns whether the provider omitted changes because it reached a capture limit. */
    default boolean changesTruncated() {
        return false;
    }

    /** Stops capturing and releases resources. */
    @Override
    void close();
}

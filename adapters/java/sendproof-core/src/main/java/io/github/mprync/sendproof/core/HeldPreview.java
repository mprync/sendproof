package io.github.mprync.sendproof.core;

import java.util.List;

/** A rollback-only transaction pinned to one store for the lifetime of a Preview session. */
public interface HeldPreview extends AutoCloseable {
    Checkpoint checkpoint() throws Exception;

    Step begin(RequestCapture capture) throws Exception;

    /** Rolls the entire transaction back and releases its resources. */
    @Override
    void close() throws Exception;

    interface Checkpoint {
        void rollback() throws Exception;

        default void discard() throws Exception {
        }
    }

    /** Per-request enrollment and capture, released before the core rewinds a checkpoint. */
    interface Step extends AutoCloseable {
        default void finish() throws Exception {
        }

        default List<PreviewChange> changes() {
            return List.of();
        }

        default boolean changesTruncated() {
            return false;
        }

        @Override
        void close() throws Exception;
    }

    /** A store could not be acquired promptly because it is already locked. */
    final class StoreBusy extends Exception {
        public StoreBusy(String store) {
            super(store);
        }
    }

    /** The server aborted or expired a transaction that remained under adapter control. */
    final class TransactionEnded extends Exception {
        public TransactionEnded(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** The adapter can no longer vouch for the transaction or its rollback. */
    final class UnsafeTransaction extends Exception {
        public UnsafeTransaction(String message, Throwable cause) {
            super(message, cause);
        }
    }
}

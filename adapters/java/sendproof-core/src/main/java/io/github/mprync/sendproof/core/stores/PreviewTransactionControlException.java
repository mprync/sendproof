package io.github.mprync.sendproof.core.stores;

/**
 * Thrown when a handler tries to end or escape the Preview transaction: a raw SQL {@code COMMIT}, a MongoDB
 * {@code commitTransaction}, or a store command sent with a session other than the Preview's. The Preview answers 500
 * without confirmation even if the handler catches it.
 */
public final class PreviewTransactionControlException extends IllegalStateException {
    private static final long serialVersionUID = 1L;

    /** Creates the refusal with the explanation the log shows. */
    public PreviewTransactionControlException(String message) {
        super(message);
    }
}

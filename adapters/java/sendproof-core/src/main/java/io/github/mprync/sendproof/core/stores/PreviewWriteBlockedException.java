package io.github.mprync.sendproof.core.stores;

/**
 * Thrown to the handler when the write guard refuses a command during a Preview. No byte of the command reached the
 * store. The Preview is already marked blocked, so a handler that catches this and returns 200 still produces a 409.
 */
public final class PreviewWriteBlockedException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final String store;
    private final String operation;

    /**
     * Creates the refusal.
     *
     * @param store     the store id, such as {@code redis}
     * @param operation the refused command or action name, never its arguments
     * @param detail    the sentence shown to the user
     */
    public PreviewWriteBlockedException(String store, String operation, String detail) {
        super(detail);
        this.store = store;
        this.operation = operation;
    }

    /** The store id, such as {@code redis}. */
    public String store() {
        return store;
    }

    /** The refused command or action name. */
    public String operation() {
        return operation;
    }
}

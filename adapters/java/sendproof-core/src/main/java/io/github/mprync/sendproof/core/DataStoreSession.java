package io.github.mprync.sendproof.core;

/**
 * One Preview's use of a data store that can roll back. {@link #finish} runs after the handler and before the SQL
 * rollback; {@link #close} runs on every path afterwards.
 */
public interface DataStoreSession extends AutoCloseable {

    /**
     * Captures the Preview's changes, records them with {@link RequestCapture#change}, and aborts the store's
     * transaction. A failure prevents the Preview from being confirmed. Nothing the Preview wrote is ever committed.
     *
     * @throws Exception when a change could not be captured or the abort could not be confirmed
     */
    void finish(RequestCapture capture) throws Exception;

    /** Releases the session and any binding to the request thread. Must be safe after a failed {@link #finish}. */
    @Override
    void close() throws Exception;
}

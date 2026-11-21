package io.github.mprync.sendproof.core;

/**
 * Data-layer integration that enrolls a whole request in a transaction that is always rolled back.
 *
 * <p>A provider must begin on the same connection or unit of work that the request handler will use, so every write
 * the handler makes is covered. Implementations that cannot guarantee this for an operation must not be registered.
 */
public interface PreviewProvider {

    /** Returns whether the provider can currently enroll requests. An unavailable provider yields no preview operations. */
    boolean isAvailable();

    /**
     * Returns a short, non-secret display label for the database, or {@code null}. Never return a connection string,
     * host name or credentials.
     */
    default String database() {
        return null;
    }

    /**
     * Starts the rollback-only unit of work for the current request thread. It is called immediately before the
     * request handler runs.
     *
     * @return the session that supplies changes and performs the rollback; never {@code null}
     * @throws Exception when the unit of work cannot be started; the preview is then not confirmed
     */
    PreviewSession begin() throws Exception;

    /**
     * Starts capturing row changes for an ordinary send without managing its transaction.
     *
     * @return the observation, or {@code null} when this provider cannot observe changes
     * @throws Exception when observation cannot start; the send then proceeds without a trace
     */
    default PreviewObservation beginObservation() throws Exception {
        return null;
    }
}

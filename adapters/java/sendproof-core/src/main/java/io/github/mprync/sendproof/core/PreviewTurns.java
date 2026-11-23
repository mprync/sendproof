package io.github.mprync.sendproof.core;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Lets one MySQL or MariaDB Preview run at a time through a provider.
 *
 * <p>InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the same key and
 * the first one rolls back, as every Preview does, the waiters each hold that shared lock and each need the exclusive
 * one, so InnoDB aborts all but one with a deadlock (error 1213). Sent for real, the first insert would commit and the
 * others would get a duplicate-key error instead, and no isolation level avoids it. Previews therefore take turns, as
 * SQLite previews queue for the write lock. Sends and observed sends never wait for a turn.
 *
 * <p>The turn is per process: Previews sent to different processes or servers of one application still run at the same
 * time, so they can still hit the deadlock. When that happens the Preview fails safely and nothing is written.
 */
public final class PreviewTurns {
    /** How long a Preview waits for its turn before it gives up and fails. */
    private static final long WAIT_SECONDS = 60;

    private final Semaphore turn = new Semaphore(1, true);

    /** Returns whether a provider whose database has this system id must serialize its Previews. */
    public static boolean needed(String system) {
        return "mysql".equals(system) || "mariadb".equals(system);
    }

    /**
     * Waits for this provider's turn, in arrival order. Call {@link #release()} exactly once when the Preview's
     * transaction has ended, or when beginning it failed.
     *
     * @throws IllegalStateException when the turn doesn't come within a minute or the thread is interrupted
     */
    public void acquire() {
        try {
            if (!turn.tryAcquire(WAIT_SECONDS, TimeUnit.SECONDS)) {
                throw new IllegalStateException("A Sendproof preview waited " + WAIT_SECONDS + " seconds for its turn.");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while a Sendproof preview waited for its turn.", interrupted);
        }
    }

    /** Hands the turn to the next waiting Preview. */
    public void release() {
        turn.release();
    }

    /** Session admission fails promptly while another Preview owns the turn. */
    public boolean tryAcquire() {
        return turn.tryAcquire();
    }

    /** Wraps a session so closing it hands the turn on, once, even if closing fails. */
    public PreviewSession holding(PreviewSession session) {
        return new PreviewSession() {
            private boolean released;

            @Override
            public java.util.List<PreviewChange> changes() {
                return session.changes();
            }

            @Override
            public boolean changesTruncated() {
                return session.changesTruncated();
            }

            @Override
            public void rollback() throws Exception {
                session.rollback();
            }

            @Override
            public void close() throws Exception {
                try {
                    session.close();
                } finally {
                    synchronized (this) {
                        if (!released) {
                            released = true;
                            release();
                        }
                    }
                }
            }
        };
    }
}

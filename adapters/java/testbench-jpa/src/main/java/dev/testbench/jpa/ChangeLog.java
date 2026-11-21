package dev.testbench.jpa;

import dev.testbench.core.CaptureLimits;
import dev.testbench.core.PreviewChange;
import java.util.ArrayList;
import java.util.List;

/** The row changes recorded for one request on one thread. Hibernate's listeners write into the current log. */
final class ChangeLog {
    private static final ThreadLocal<ChangeLog> CURRENT = new ThreadLocal<>();

    private final List<PreviewChange> changes = new ArrayList<>();
    private boolean truncated;
    private final ChangeLog previous;

    private ChangeLog(ChangeLog previous) {
        this.previous = previous;
    }

    /** Makes a new log current for this thread until {@link #close()}. */
    static ChangeLog open() {
        ChangeLog log = new ChangeLog(CURRENT.get());
        CURRENT.set(log);
        return log;
    }

    /** Returns the log for this thread, or {@code null} when no preview or observation is running. */
    static ChangeLog current() {
        return CURRENT.get();
    }

    synchronized void add(PreviewChange change, boolean clipped) {
        truncated |= clipped;
        if (changes.size() >= CaptureLimits.CHANGES) {
            truncated = true;
            return;
        }
        changes.add(change);
    }

    synchronized List<PreviewChange> changes() {
        return List.copyOf(changes);
    }

    synchronized boolean truncated() {
        return truncated;
    }

    /** Restores the log that was current before this one. */
    void close() {
        if (previous == null) {
            CURRENT.remove();
        } else {
            CURRENT.set(previous);
        }
    }
}

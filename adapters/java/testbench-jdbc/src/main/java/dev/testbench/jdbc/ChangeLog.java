package dev.testbench.jdbc;

import dev.testbench.core.CaptureLimits;
import dev.testbench.core.PreviewChange;
import java.util.ArrayList;
import java.util.List;

/** The row changes recorded for one request, bounded by {@link CaptureLimits#CHANGES}. */
final class ChangeLog {
    private final List<PreviewChange> changes = new ArrayList<>();
    private boolean truncated;

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
}

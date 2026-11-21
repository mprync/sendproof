package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewObservation;
import java.util.List;

/** Captures entity changes during an ordinary send. It does not touch the transaction. */
final class JpaObservation implements PreviewObservation {
    private final ChangeLog log = ChangeLog.open();

    @Override
    public List<PreviewChange> changes() {
        return log.changes();
    }

    @Override
    public boolean changesTruncated() {
        return log.truncated();
    }

    @Override
    public void close() {
        log.close();
    }
}

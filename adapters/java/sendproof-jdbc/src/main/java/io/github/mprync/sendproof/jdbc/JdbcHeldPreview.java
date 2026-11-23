package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewSavepoint;
import io.github.mprync.sendproof.core.RequestCapture;
import java.sql.SQLException;
import java.util.List;

/** Reuses the ordinary JDBC connection guards and attaches a fresh capture scope at each checkpoint. */
final class JdbcHeldPreview implements HeldPreview {
    private final JdbcPreviewSession transaction;
    private final Runnable release;
    private PreviewSavepoint stepStart;
    private long nextName;

    JdbcHeldPreview(JdbcPreviewSession transaction, Runnable release) {
        this.transaction = transaction;
        this.release = release;
    }

    private PreviewSavepoint point() throws SQLException {
        return PreviewSavepoint.open(transaction.physical(), transaction.system(),
                PreviewSavepoint.NAME + "_" + nextName++);
    }

    @Override
    public Checkpoint checkpoint() throws SQLException {
        var point = point();
        stepStart = point;
        return new Checkpoint() {
            @Override
            public void rollback() throws SQLException {
                point.rollback();
            }

            @Override
            public void discard() throws SQLException {
                point.release();
            }
        };
    }

    @Override
    public Step begin(RequestCapture capture) throws SQLException {
        JdbcScope scope = JdbcScope.current();
        if (scope == null || scope.session() != null) {
            throw new IllegalStateException("No free JDBC scope for the held Preview step.");
        }
        var witness = point();
        transaction.step(stepStart, witness);
        scope.session(transaction);
        return new Step() {
            @Override
            public void finish() throws Exception {
                transaction.checkHeld();
                // A caught PostgreSQL error leaves the transaction aborted. The core can still rewind this step.
                try {
                    witness.check();
                } catch (SQLException failure) {
                    if (failure.getSQLState() != null && failure.getSQLState().startsWith("08")) {
                        throw new TransactionEnded("The database connection for the held Preview ended.", failure);
                    }
                    throw failure;
                }
                try {
                    witness.release();
                } catch (SQLException missing) {
                    throw new UnsafeTransaction("The held Preview's SQL savepoint is gone.", missing);
                }
            }

            @Override
            public List<PreviewChange> changes() {
                return scope.changes().changes();
            }

            @Override
            public boolean changesTruncated() {
                return scope.changes().truncated();
            }

            @Override
            public void close() {
                scope.session(null);
                transaction.step(null, null);
            }
        };
    }

    @Override
    public void close() throws SQLException {
        try {
            transaction.endHeld();
        } finally {
            release.run();
        }
    }
}

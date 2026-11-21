package dev.testbench.jdbc;

import dev.testbench.core.PreviewChange;
import dev.testbench.core.PreviewSession;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;

/**
 * One preview's transaction: a single connection with auto-commit off that every borrower of the
 * {@link PreviewDataSource} shares, rolled back at the end and then released.
 */
final class JdbcPreviewSession implements PreviewSession {
    private final JdbcScope scope;
    private final Connection real;
    private final Connection shared;
    private volatile boolean closed;
    private volatile boolean rolledBackEarly;

    JdbcPreviewSession(JdbcScope scope, Connection real) throws SQLException {
        this.scope = scope;
        this.real = real;
        try {
            real.setAutoCommit(false);
        } catch (SQLException | RuntimeException failure) {
            closeQuietly(real);
            throw failure;
        }
        this.shared = SharedConnection.of(real, this);
        scope.session(this);
    }

    Connection connection() {
        return shared;
    }

    boolean isClosed() {
        return closed;
    }

    void rolledBackEarly() {
        rolledBackEarly = true;
    }

    /** Returns whether application code rolled the shared transaction back before the preview ended. */
    boolean wasRolledBackEarly() {
        return rolledBackEarly;
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
    public void rollback() throws SQLException {
        real.rollback();
    }

    @Override
    public void close() throws SQLException {
        closed = true;
        scope.session(null);
        try {
            real.setAutoCommit(true);
        } finally {
            real.close();
        }
    }

    private static void closeQuietly(Connection connection) {
        try {
            connection.close();
        } catch (SQLException ignored) {
            // The original failure is the one worth reporting.
        }
    }
}

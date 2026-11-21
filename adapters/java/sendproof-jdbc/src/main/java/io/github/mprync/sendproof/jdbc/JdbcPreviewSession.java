package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewSession;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import net.ttddyy.dsproxy.proxy.ProxyJdbcObject;

/**
 * One preview's transaction: a single connection with auto-commit off that every borrower of the
 * {@link PreviewDataSource} shares, rolled back at the end and then released.
 *
 * <p>While the session is open its physical connection is registered so {@link PreviewConnectionGuard} and
 * {@link JdbcCaptureListener} can recognise it however application code reached it (for example through
 * {@code Statement.getConnection()}), and refuse anything that would end the transaction. A refusal is remembered and
 * makes {@link #rollback()} fail, so the preview is never confirmed even if the handler swallowed the error.
 */
final class JdbcPreviewSession implements PreviewSession {
    /** Open sessions by the connection objects that identify them (the proxy and the pool's connection). */
    private static final Map<Object, JdbcPreviewSession> OPEN = Collections.synchronizedMap(new IdentityHashMap<>());

    private final JdbcScope scope;
    private final Connection real;
    private final Object target;
    private final Connection shared;
    private volatile boolean closed;
    private volatile boolean rolledBackEarly;
    private volatile String violation;

    JdbcPreviewSession(JdbcScope scope, Connection real) throws SQLException {
        this.scope = scope;
        this.real = real;
        try {
            real.setAutoCommit(false);
        } catch (SQLException | RuntimeException failure) {
            closeQuietly(real);
            throw failure;
        }
        this.target = real instanceof ProxyJdbcObject proxy ? proxy.getTarget() : null;
        this.shared = SharedConnection.of(real, this);
        OPEN.put(real, this);
        if (target != null) {
            OPEN.put(target, this);
        }
        scope.session(this);
    }

    /** Returns the open session that owns {@code connection}, or {@code null}. */
    static JdbcPreviewSession owning(Object connection) {
        if (connection == null || OPEN.isEmpty()) {
            return null;
        }
        JdbcPreviewSession session = OPEN.get(connection);
        return session == null || session.closed ? null : session;
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

    /**
     * Records that application code tried to end or escape the preview transaction and returns the exception to throw.
     */
    IllegalStateException refuse(String action) {
        String message = action + " is not allowed during a Sendproof preview: it would end the rolled-back "
                + "transaction, so the operation is not previewable.";
        if (violation == null) {
            violation = message;
        }
        return new IllegalStateException(message);
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
        if (violation != null) {
            throw new IllegalStateException(violation);
        }
    }

    @Override
    public void close() throws SQLException {
        closed = true;
        OPEN.remove(real);
        if (target != null) {
            OPEN.remove(target);
        }
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

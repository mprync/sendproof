package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.PreviewSavepoint;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.TransactionControl;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.ttddyy.dsproxy.proxy.ProxyJdbcObject;

/**
 * One preview's transaction: a single connection with auto-commit off that every borrower of the
 * {@link PreviewDataSource} shares, rolled back at the end and then released.
 *
 * <p>While the session is open its physical connection is registered so {@link PreviewConnectionGuard} and
 * {@link JdbcCaptureListener} can recognise it however application code reached it (for example through
 * {@code Statement.getConnection()}), and refuse anything that would end the transaction. A refusal is remembered and
 * makes {@link #rollback()} fail, so the preview is never confirmed even if the handler swallowed the error.
 *
 * <p>On MySQL and MariaDB the session also refuses {@code CALL} (except declared safe procedures) and the rest of
 * MySQL's implicit-commit list, and keeps a {@link PreviewSavepoint} as a backstop: if the savepoint is gone when the
 * Preview ends, something committed the transaction and {@link #rollback()} fails.
 */
final class JdbcPreviewSession implements PreviewSession {
    /** Open sessions by the connection objects that identify them (the proxy and the pool's connection). */
    private static final Map<Object, JdbcPreviewSession> OPEN = Collections.synchronizedMap(new IdentityHashMap<>());

    private final JdbcScope scope;
    private final Connection real;
    private final Object target;
    private final Connection shared;
    private final String system;
    private final Set<String> safeProcedures;
    private final PreviewSavepoint savepoint;
    private volatile boolean closed;
    private volatile boolean finishing;
    private volatile boolean rolledBackEarly;
    private volatile boolean lost;
    private volatile String violation;

    JdbcPreviewSession(JdbcScope scope, Connection real, String system, Set<String> safeProcedures) throws SQLException {
        this.scope = scope;
        this.real = real;
        this.system = system;
        this.safeProcedures = safeProcedures == null ? Set.of() : safeProcedures;
        this.target = real instanceof ProxyJdbcObject proxy ? proxy.getTarget() : null;
        try {
            real.setAutoCommit(false);
            // On the pool's connection, past the SQL capture, so the probe never shows in the request's SQL log.
            this.savepoint = TransactionControl.isMySql(system)
                    ? PreviewSavepoint.open(target instanceof Connection physical ? physical : real) : null;
        } catch (SQLException | RuntimeException failure) {
            closeQuietly(real);
            throw failure;
        }
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

    /** Whether the database rolled the Preview transaction back on its own; every later statement is then refused. */
    boolean isLost() {
        return lost;
    }

    /**
     * Records a failed statement. A deadlock or lock wait timeout (or, on SQL Server, any error that leaves
     * {@code @@TRANCOUNT} at 0, as under {@code XACT_ABORT ON}) means the database rolled the whole Preview transaction
     * back: later statements would run outside it, so they are refused and the Preview fails. The handler still gets the
     * original error.
     */
    void failed(SQLException error) {
        if (finishing || lost) {
            return;
        }
        if (TransactionControl.rollsBackTransaction(system, error)
                || (TransactionControl.isSqlServer(system) && sqlServerTransactionGone())) {
            lost = true;
            refuse("Running SQL after the database rolled the Preview transaction back");
        }
    }

    /** Asks SQL Server, on the pool's connection past the SQL capture, whether a transaction is still open. */
    private boolean sqlServerTransactionGone() {
        Connection physical = target instanceof Connection connection ? connection : real;
        try (var statement = physical.createStatement(); var rows = statement.executeQuery("SELECT @@TRANCOUNT")) {
            return !rows.next() || rows.getInt(1) == 0;
        } catch (SQLException unknown) {
            return true;
        }
    }

    /** The SQL provider id the session's refusals follow. */
    String system() {
        return system;
    }

    /** Procedures the host declared never commit. */
    Set<String> safeProcedures() {
        return safeProcedures;
    }

    /**
     * Records that application code rolled the shared transaction back. Nothing escapes a rollback, but it erases the
     * backstop savepoint, so the savepoint is made again; failing that, the Preview can't be confirmed.
     */
    void rolledBackEarly() {
        if (finishing) {
            return; // The session's own final rollback.
        }
        rolledBackEarly = true;
        if (savepoint != null) {
            try {
                savepoint.reopen();
            } catch (SQLException failure) {
                refuse("Restoring the Preview's savepoint after a rollback");
            }
        }
    }

    /** Returns whether application code rolled the shared transaction back before the preview ended. */
    boolean wasRolledBackEarly() {
        return rolledBackEarly;
    }

    /**
     * Refuses a JDBC savepoint call that names the backstop savepoint ({@code setSavepoint(name)},
     * {@code releaseSavepoint(sp)}, {@code rollback(sp)}); the driver sends these without passing the SQL capture.
     */
    void checkSavepointCall(String method, Object[] args) {
        if (savepoint == null || args == null || args.length != 1) {
            return;
        }
        String name = null;
        if (args[0] instanceof String text) {
            name = text;
        } else if (args[0] instanceof Savepoint point) {
            try {
                name = point.getSavepointName();
            } catch (SQLException | RuntimeException unnamed) {
                return;
            }
        }
        if (name != null && name.replace("`", "").equalsIgnoreCase(PreviewSavepoint.NAME)) {
            throw refuse("Connection." + method + "() of the Preview's savepoint");
        }
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

    /**
     * Checks the backstop savepoint, then rolls back. Fails when the handler was refused something or the savepoint is
     * gone, so the Preview answers 500 without confirmation; the rollback runs either way.
     */
    @Override
    public void rollback() throws SQLException {
        finishing = true;
        IllegalStateException ended = null;
        if (savepoint != null) {
            try {
                savepoint.verify();
            } catch (IllegalStateException failure) {
                ended = failure;
            }
        }
        real.rollback();
        if (violation != null) {
            throw new IllegalStateException(violation);
        }
        if (ended != null) {
            throw ended;
        }
    }

    @Override
    public void close() throws SQLException {
        finishing = true;
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

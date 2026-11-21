package io.github.mprync.sendproof.jdbc;

import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.function.BooleanSupplier;
import java.util.logging.Logger;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;

/**
 * Wraps the application's {@link DataSource} so Sendproof can enroll a request in one transaction and observe its SQL.
 * Give this data source to your data access code instead of the pool. Outside a preview it behaves like the pool.
 * During a preview every borrower, on any thread that carries the request's {@link JdbcScope}, receives the preview's
 * single connection, whose {@code commit} and {@code close} do nothing.
 *
 * <p>During a preview, statements and calls that would end the shared transaction ({@code COMMIT}, DDL, a
 * {@code commit()} reached through {@code Statement.getConnection()}, unwrapping to the driver's connection) are
 * refused and the preview is not confirmed (see {@link PreviewConnectionGuard}).
 *
 * <p>SQL is logged for every request that has an active capture, and simple single-row {@code INSERT}, {@code UPDATE}
 * and {@code DELETE} statements are reported as row changes (see {@link JdbcCaptureListener}).
 */
public final class PreviewDataSource implements DataSource {
    private final DataSource proxy;
    private volatile boolean systemResolved;
    private volatile String system;

    /**
     * Wraps {@code target}.
     *
     * @param showValues says whether non-secret bound values may be shown in captured SQL
     */
    public PreviewDataSource(DataSource target, BooleanSupplier showValues) {
        this.proxy = ProxyDataSourceBuilder.create(target).listener(new JdbcCaptureListener(showValues))
                .methodListener(new PreviewConnectionGuard()).build();
    }

    /**
     * Wraps {@code target} with bound SQL values hidden (secret-named values are always hidden). Use
     * {@link #PreviewDataSource(DataSource, BooleanSupplier)} to show values in a development environment.
     */
    public PreviewDataSource(DataSource target) {
        this(target, () -> false);
    }

    /** The SQL provider id of the wrapped database (see {@code DatabaseSystem}), resolved once; {@code null} if unknown. */
    String databaseSystem() {
        if (!systemResolved) {
            try (Connection connection = proxy.getConnection()) {
                system = io.github.mprync.sendproof.core.DatabaseSystem.of(connection.getMetaData().getDatabaseProductName());
            } catch (SQLException | RuntimeException error) {
                system = null;
            }
            systemResolved = true;
        }
        return system;
    }

    /**
     * Starts the preview transaction for the request that owns the current {@link JdbcScope}.
     *
     * @param system         the SQL provider id, which selects the MySQL refusals and backstop, or {@code null} to use
     *                       the wrapped database's own
     * @param safeProcedures procedures the host declared never commit, normalised by {@code TransactionControl}
     */
    JdbcPreviewSession beginPreview(String system, java.util.Set<String> safeProcedures) throws SQLException {
        JdbcScope scope = JdbcScope.current();
        if (scope == null) {
            throw new IllegalStateException("No Sendproof request scope is active on this thread.");
        }
        return new JdbcPreviewSession(scope, proxy.getConnection(), system != null ? system : databaseSystem(),
                safeProcedures);
    }

    @Override
    public Connection getConnection() throws SQLException {
        JdbcScope scope = JdbcScope.current();
        JdbcPreviewSession session = scope == null ? null : scope.session();
        return session == null ? proxy.getConnection() : session.connection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        JdbcScope scope = JdbcScope.current();
        JdbcPreviewSession session = scope == null ? null : scope.session();
        return session == null ? proxy.getConnection(username, password) : session.connection();
    }

    @Override
    public <T> T unwrap(Class<T> type) throws SQLException {
        return type.isInstance(this) ? type.cast(this) : proxy.unwrap(type);
    }

    @Override
    public boolean isWrapperFor(Class<?> type) throws SQLException {
        return type.isInstance(this) || proxy.isWrapperFor(type);
    }

    @Override
    public PrintWriter getLogWriter() throws SQLException {
        return proxy.getLogWriter();
    }

    @Override
    public void setLogWriter(PrintWriter out) throws SQLException {
        proxy.setLogWriter(out);
    }

    @Override
    public void setLoginTimeout(int seconds) throws SQLException {
        proxy.setLoginTimeout(seconds);
    }

    @Override
    public int getLoginTimeout() throws SQLException {
        return proxy.getLoginTimeout();
    }

    @Override
    public Logger getParentLogger() throws SQLFeatureNotSupportedException {
        return proxy.getParentLogger();
    }
}

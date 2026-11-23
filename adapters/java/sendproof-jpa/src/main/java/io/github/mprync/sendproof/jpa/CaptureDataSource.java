package io.github.mprync.sendproof.jpa;

import java.sql.Connection;
import java.sql.SQLException;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import net.ttddyy.dsproxy.support.ProxyDataSource;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource;

/**
 * Wraps the application's {@link DataSource} so every JDBC command can be observed. It keeps the original's lifecycle:
 * closing the wrapper closes the pool, and {@code unwrap} still reaches the real pool.
 */
final class CaptureDataSource extends DelegatingDataSource implements AutoCloseable {
    private final DataSource original;
    private final QueryExecutionListener listener;

    CaptureDataSource(DataSource original, QueryExecutionListener listener) {
        super(capture(original, listener));
        this.original = original;
        this.listener = listener;
    }

    private static ProxyDataSource capture(DataSource target, QueryExecutionListener listener) {
        return ProxyDataSourceBuilder.create(target).listener(listener).methodListener(new JpaConnectionGuard()).build();
    }

    boolean canPin() {
        return !(original instanceof DelegatingDataSource || original instanceof AbstractRoutingDataSource
                || original instanceof SingleConnectionDataSource);
    }

    Connection openPhysical() throws SQLException {
        return original.getConnection();
    }

    Connection capturePinned(Connection connection) throws SQLException {
        return capture(new SingleConnectionDataSource(connection, false), listener).getConnection();
    }

    @Override
    public Connection getConnection() throws SQLException {
        PinnedConnection pinned = PinnedConnection.current();
        return pinned == null ? super.getConnection() : pinned.borrow(this);
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        PinnedConnection pinned = PinnedConnection.current();
        if (pinned != null) {
            throw pinned.refuse("A credential-specific connection was requested");
        }
        return super.getConnection(username, password);
    }

    @Override
    public DataSource getTargetDataSource() {
        PinnedConnection pinned = PinnedConnection.current();
        if (pinned != null) {
            throw pinned.refuse("The unguarded DataSource was requested");
        }
        return super.getTargetDataSource();
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
        if (iface.isInstance(this)) {
            return iface.cast(this);
        }
        if (PinnedConnection.current() != null) {
            throw new SQLException("The pinned Preview DataSource cannot be unwrapped.");
        }
        return super.unwrap(iface);
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) throws SQLException {
        return iface.isInstance(this) || PinnedConnection.current() == null && super.isWrapperFor(iface);
    }

    @Override
    public void close() {
        try {
            if (original instanceof AutoCloseable closeable) {
                closeable.close();
            } else {
                original.getClass().getMethod("close").invoke(original);
            }
        } catch (NoSuchMethodException error) {
            // The pool has no close method; nothing to release.
        } catch (Exception error) {
            throw new IllegalStateException("The data source could not be closed.", error);
        }
    }
}

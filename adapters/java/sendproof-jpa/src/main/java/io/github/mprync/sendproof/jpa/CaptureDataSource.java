package io.github.mprync.sendproof.jpa;

import javax.sql.DataSource;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import net.ttddyy.dsproxy.support.ProxyDataSourceBuilder;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/**
 * Wraps the application's {@link DataSource} so every JDBC command can be observed. It keeps the original's lifecycle:
 * closing the wrapper closes the pool, and {@code unwrap} still reaches the real pool.
 */
final class CaptureDataSource extends DelegatingDataSource implements AutoCloseable {
    private final DataSource original;

    CaptureDataSource(DataSource original, QueryExecutionListener listener) {
        super(ProxyDataSourceBuilder.create(original).listener(listener).methodListener(new JpaConnectionGuard()).build());
        this.original = original;
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

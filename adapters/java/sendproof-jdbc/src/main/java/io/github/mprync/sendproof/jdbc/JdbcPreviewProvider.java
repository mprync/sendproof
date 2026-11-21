package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import java.sql.SQLException;
import java.util.function.Supplier;

/**
 * A preview provider for applications that reach their database through a {@link PreviewDataSource}. It works with
 * any JDBC-based access layer (plain JDBC, Exposed, jOOQ, JDBI) in frameworks without ambient transactions.
 *
 * <p>The request must run with its {@link JdbcScope} current. Writes made through other connections are not enrolled
 * and are not rolled back.
 */
public final class JdbcPreviewProvider implements PreviewProvider {
    private final PreviewDataSource dataSource;
    private final Supplier<String> database;

    /**
     * Creates the provider.
     *
     * @param database supplies a short non-secret label for the database, or {@code null}
     */
    public JdbcPreviewProvider(PreviewDataSource dataSource, Supplier<String> database) {
        this.dataSource = dataSource;
        this.database = database;
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public String database() {
        return database.get();
    }

    @Override
    public String databaseSystem() {
        return dataSource.databaseSystem();
    }

    @Override
    public PreviewSession begin() throws SQLException {
        return dataSource.beginPreview();
    }

    @Override
    public PreviewObservation beginObservation() {
        JdbcScope scope = JdbcScope.current();
        if (scope == null) {
            return null;
        }
        return new PreviewObservation() {
            @Override
            public java.util.List<io.github.mprync.sendproof.core.PreviewChange> changes() {
                return scope.changes().changes();
            }

            @Override
            public boolean changesTruncated() {
                return scope.changes().truncated();
            }

            @Override
            public void close() {
                // The scope's lifetime belongs to the web adapter.
            }
        };
    }
}

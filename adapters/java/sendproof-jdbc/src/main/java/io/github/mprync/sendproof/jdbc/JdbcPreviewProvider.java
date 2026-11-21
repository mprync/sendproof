package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.PreviewObservation;
import io.github.mprync.sendproof.core.PreviewProvider;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.PreviewTurns;
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
    private final Supplier<String> system;
    private final PreviewTurns turns = new PreviewTurns();

    /**
     * Creates the provider.
     *
     * @param database supplies a short non-secret label for the database, or {@code null}
     */
    public JdbcPreviewProvider(PreviewDataSource dataSource, Supplier<String> database) {
        this(dataSource, database, dataSource::databaseSystem);
    }

    /**
     * Creates the provider with an explicit SQL provider id ({@code postgresql}, {@code mysql} ...), for capabilities
     * {@code database.system} and to decide whether Previews take turns.
     */
    public JdbcPreviewProvider(PreviewDataSource dataSource, Supplier<String> database, Supplier<String> system) {
        this.dataSource = dataSource;
        this.database = database;
        this.system = system;
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
        return system.get();
    }

    /**
     * On MySQL and MariaDB one Preview runs at a time per provider: see {@link PreviewTurns}. The turn is taken before
     * the connection is borrowed and handed on when the session closes.
     */
    @Override
    public PreviewSession begin() throws SQLException {
        if (!PreviewTurns.needed(system.get())) {
            return dataSource.beginPreview();
        }
        turns.acquire();
        try {
            return turns.holding(dataSource.beginPreview());
        } catch (SQLException | RuntimeException | Error failure) {
            turns.release();
            throw failure;
        }
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

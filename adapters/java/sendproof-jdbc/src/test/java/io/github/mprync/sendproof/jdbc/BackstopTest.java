package io.github.mprync.sendproof.jdbc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.RequestCapture;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

/**
 * The start-savepoint backstop of spec/data-stores.md "Transaction-control statements from the handler" on every SQL
 * database: a commit by a route the pre-send guard can't see (here, the driver's own connection, past every Sendproof
 * wrapper) makes the Preview fail with 500 instead of confirming. Server databases skip, saying so, when their compose
 * service doesn't answer.
 */
class BackstopTest {

    /** A database to run the scenario on: how to reach it and its SQL provider id. */
    private record Database(String system, DataSource source, Runnable cleanup) {
    }

    @Test
    void h2() throws Exception {
        var source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        scenario(new Database("h2", source, () -> { }));
    }

    @Test
    void sqlite() throws Exception {
        Path file = Files.createTempFile("sendproof-backstop", ".db");
        var source = new org.sqlite.SQLiteDataSource();
        source.setUrl("jdbc:sqlite:" + file);
        scenario(new Database("sqlite", source, () -> file.toFile().delete()));
    }

    @Test
    void postgresql() throws Exception {
        String server = "jdbc:postgresql://127.0.0.1:55432/postgres";
        assumeTrue(answers(server, "bench", "bench_local"),
                "PostgreSQL isn't running: docker compose -f tests/conformance/compose.yml up -d --wait postgres");
        String name = "sp_jdbc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        admin(server, "bench", "bench_local", "CREATE DATABASE " + name);
        var source = new org.postgresql.ds.PGSimpleDataSource();
        source.setURL("jdbc:postgresql://127.0.0.1:55432/" + name);
        source.setUser("bench");
        source.setPassword("bench_local");
        scenario(new Database("postgresql", source, () -> admin(server, "bench", "bench_local", "DROP DATABASE IF EXISTS " + name)));
    }

    /**
     * A unique violation the handler answers with 409 leaves the PostgreSQL transaction aborted; the check (a rollback to
     * the savepoint, which also unwinds a nested savepoint the handler left open) still succeeds, so the Preview stays
     * confirmable.
     */
    @Test
    void aPostgreSqlHandlerErrorAnsweredAs409KeepsThePreviewConfirmable() throws Exception {
        String server = "jdbc:postgresql://127.0.0.1:55432/postgres";
        assumeTrue(answers(server, "bench", "bench_local"),
                "PostgreSQL isn't running: docker compose -f tests/conformance/compose.yml up -d --wait postgres");
        String name = "sp_jdbc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        admin(server, "bench", "bench_local", "CREATE DATABASE " + name);
        try {
            var source = new org.postgresql.ds.PGSimpleDataSource();
            source.setURL("jdbc:postgresql://127.0.0.1:55432/" + name);
            source.setUser("bench");
            source.setPassword("bench_local");
            try (Connection connection = source.getConnection(); Statement statement = connection.createStatement()) {
                statement.execute("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100))");
                statement.execute("INSERT INTO items (id, name) VALUES ('taken', 'x')");
            }
            var enrolled = new PreviewDataSource(source, () -> true);
            var provider = new JdbcPreviewProvider(enrolled, () -> "Test", () -> "postgresql");
            Exception failure = preview(provider, enrolled, connection -> {
                try (Statement statement = connection.createStatement()) {
                    statement.execute("SAVEPOINT handler_nested");
                }
                try {
                    insert(connection, "taken");
                } catch (SQLException uniqueViolation) {
                    // The handler answers 409; the transaction is now aborted.
                }
            });
            assertThat(failure).as("the Preview stays confirmable").isNull();
        } finally {
            admin(server, "bench", "bench_local", "DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
        }
    }

    @Test
    void sqlServer() throws Exception {
        String server = "jdbc:sqlserver://127.0.0.1:51433;encrypt=false;trustServerCertificate=true;loginTimeout=3";
        assumeTrue(answers(server, "sa", "BenchLocal_2026!"),
                "SQL Server isn't running: docker compose -f tests/conformance/compose.yml up -d --wait sqlserver");
        String name = "sp_jdbc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        admin(server, "sa", "BenchLocal_2026!", "CREATE DATABASE " + name);
        var source = new com.microsoft.sqlserver.jdbc.SQLServerDataSource();
        source.setURL(server + ";databaseName=" + name);
        source.setUser("sa");
        source.setPassword("BenchLocal_2026!");
        scenario(new Database("mssql", source, () -> admin(server, "sa", "BenchLocal_2026!",
                "ALTER DATABASE " + name + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + name)));
    }

    /**
     * The handler inserts, something commits around every guard, and the handler writes again in whatever transaction
     * follows. The commit really happened (the first row persists), so the Preview must answer 500, not confirm.
     */
    private void scenario(Database database) throws Exception {
        try {
            try (Connection connection = database.source().getConnection(); Statement statement = connection.createStatement()) {
                statement.execute("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100))");
            }
            var physical = new AtomicReference<Connection>();
            var enrolled = new PreviewDataSource(recording(database.source(), physical), () -> true);
            var provider = new JdbcPreviewProvider(enrolled, () -> "Test", database::system);

            assertThat(preview(provider, enrolled, connection -> insert(connection, "kept"))).as("an ordinary Preview").isNull();
            assertThat(count(database, "kept")).isZero();

            Exception failure = preview(provider, enrolled, connection -> {
                insert(connection, "escaped");
                physical.get().commit();
                insert(connection, "after");
            });
            assertThat(failure).as("the backstop fails the Preview").isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("committed");
            assertThat(count(database, "escaped")).as("the commit the guard couldn't see happened").isEqualTo(1);
            assertThat(count(database, "after")).isZero();
        } finally {
            database.cleanup().run();
        }
    }

    private interface Handler {
        void run(Connection connection) throws Exception;
    }

    private static Exception preview(JdbcPreviewProvider provider, PreviewDataSource enrolled, Handler handler) throws Exception {
        var scope = new JdbcScope();
        var capture = new RequestCapture();
        try (var ignored = scope.enter(); var capturing = CaptureContext.enter(capture)) {
            capture.begin(true, System.nanoTime());
            PreviewSession session = provider.begin();
            try {
                try (Connection connection = enrolled.getConnection()) {
                    handler.run(connection);
                }
                try {
                    session.rollback();
                    return null;
                } catch (Exception rollbackFailure) {
                    return rollbackFailure;
                }
            } finally {
                session.close();
            }
        }
    }

    private static void insert(Connection connection, String id) throws SQLException {
        try (var statement = connection.prepareStatement("INSERT INTO items (id, name) VALUES (?, 'x')")) {
            statement.setString(1, id);
            statement.executeUpdate();
        }
    }

    private static long count(Database database, String id) throws SQLException {
        try (Connection connection = database.source().getConnection();
             var statement = connection.prepareStatement("SELECT COUNT(*) FROM items WHERE id = ?")) {
            statement.setString(1, id);
            try (ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1);
            }
        }
    }

    /** Hands out the driver's connections and remembers the last one, so a test can commit past every wrapper. */
    private static DataSource recording(DataSource target, AtomicReference<Connection> last) {
        return (DataSource) Proxy.newProxyInstance(BackstopTest.class.getClassLoader(), new Class<?>[] {DataSource.class},
                (proxy, method, args) -> {
                    try {
                        Object result = method.invoke(target, args);
                        if (result instanceof Connection connection) {
                            last.set(connection);
                        }
                        return result;
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static boolean answers(String url, String user, String password) {
        try (Connection probe = DriverManager.getConnection(url, user, password)) {
            return probe.isValid(3);
        } catch (SQLException unreachable) {
            return false;
        }
    }

    private static void admin(String url, String user, String password, String sql) {
        try (Connection connection = DriverManager.getConnection(url, user, password);
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        } catch (SQLException failure) {
            throw new IllegalStateException(failure);
        }
    }
}

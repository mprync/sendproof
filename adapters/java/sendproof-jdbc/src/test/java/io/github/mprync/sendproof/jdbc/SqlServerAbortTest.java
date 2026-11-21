package io.github.mprync.sendproof.jdbc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.microsoft.sqlserver.jdbc.SQLServerDataSource;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.RequestCapture;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * spec/data-stores.md "Transaction-control statements from the handler": when SQL Server ends the Preview transaction
 * on its own (deadlock victim 1205, or any error under {@code XACT_ABORT ON}), every further statement in the Preview is
 * refused and the Preview fails, even though the handler caught the error. Runs against the compose SQL Server
 * ({@code docker compose -f tests/conformance/compose.yml up -d --wait sqlserver}) and skips when it doesn't answer.
 */
class SqlServerAbortTest {
    private static final String SERVER = "jdbc:sqlserver://127.0.0.1:51433;encrypt=false;trustServerCertificate=true;"
            + "loginTimeout=3";
    private static final String USER = "sa";
    private static final String PASSWORD = "BenchLocal_2026!";
    private static boolean available;

    private final String database = "sp_jdbc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private PreviewDataSource enrolled;
    private JdbcPreviewProvider provider;

    @BeforeAll
    static void probe() {
        try (Connection probe = DriverManager.getConnection(SERVER, USER, PASSWORD)) {
            available = probe.isValid(3);
        } catch (SQLException unreachable) {
            available = false;
        }
    }

    @BeforeEach
    void create() throws SQLException {
        assumeTrue(available, "SQL Server isn't running: docker compose -f tests/conformance/compose.yml up -d --wait sqlserver");
        admin("CREATE DATABASE " + database);
        try (Connection connection = connect(); Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100))");
            statement.execute("INSERT INTO items (id, name) VALUES ('a', 'a'), ('b', 'b')");
        }
        var source = new SQLServerDataSource();
        source.setURL(SERVER + ";databaseName=" + database);
        source.setUser(USER);
        source.setPassword(PASSWORD);
        enrolled = new PreviewDataSource(source, () -> true);
        provider = new JdbcPreviewProvider(enrolled, () -> "Test");
    }

    @AfterEach
    void drop() throws SQLException {
        if (available) {
            admin("ALTER DATABASE " + database + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + database);
        }
    }

    @Test
    void theProviderKnowsItIsSqlServer() {
        assertThat(provider.databaseSystem()).isEqualTo("mssql");
    }

    @Test
    void afterTheDeadlockVictimErrorEveryFurtherStatementIsRefused() throws Exception {
        try (Connection other = connect()) {
            other.setAutoCommit(false);
            run(other, "UPDATE items SET name = 'other' WHERE id = 'b'");
            var original = new AtomicReference<SQLException>();
            Exception failure = preview(connection -> {
                // The Preview is made the victim, as a lower-priority session would be.
                run(connection, "SET DEADLOCK_PRIORITY LOW");
                run(connection, "UPDATE items SET name = 'preview' WHERE id = 'a'");
                var blocked = new Thread(() -> {
                    try {
                        run(other, "UPDATE items SET name = 'other' WHERE id = 'a'");
                    } catch (SQLException ignored) {
                        // The other side wins the deadlock.
                    }
                });
                blocked.start();
                Thread.sleep(300);
                try {
                    run(connection, "UPDATE items SET name = 'preview' WHERE id = 'b'");
                } catch (SQLException deadlock) {
                    original.set(deadlock);
                }
                blocked.join(20_000);
                assertThatThrownBy(() -> run(connection, "INSERT INTO items (id, name) VALUES ('retry', 'x')"))
                        .isInstanceOf(IllegalStateException.class);
            });
            other.rollback();
            SQLException deadlock = original.get();
            assertThat((Object) deadlock).isNotNull();
            assertThat(deadlock.getErrorCode()).isEqualTo(1205);
            assertThat(failure).as("the Preview fails").isNotNull();
            assertThat(count("retry")).isZero();
        }
    }

    @Test
    void anErrorUnderXactAbortEndsThePreviewAndEveryFurtherStatementIsRefused() throws Exception {
        Exception failure = preview(connection -> {
            run(connection, "SET XACT_ABORT ON");
            // A duplicate key: under XACT_ABORT ON the server rolls the whole transaction back.
            assertThatThrownBy(() -> run(connection, "INSERT INTO items (id, name) VALUES ('a', 'dup')"))
                    .isInstanceOf(SQLException.class);
            assertThatThrownBy(() -> run(connection, "INSERT INTO items (id, name) VALUES ('after', 'x')"))
                    .isInstanceOf(IllegalStateException.class);
        });
        assertThat(failure).isNotNull();
        assertThat(count("after")).isZero();
    }

    @Test
    void anErrorThatKeepsTheTransactionLeavesThePreviewConfirmable() throws Exception {
        Exception failure = preview(connection -> {
            assertThatThrownBy(() -> run(connection, "INSERT INTO items (id, name) VALUES ('a', 'dup')"))
                    .isInstanceOf(SQLException.class);
            run(connection, "INSERT INTO items (id, name) VALUES ('fine', 'x')");
        });
        assertThat(failure).isNull();
        assertThat(count("fine")).isZero();
    }

    private interface Handler {
        void run(Connection connection) throws Exception;
    }

    /** Runs {@code handler} as a Preview's handler and returns the rollback's failure (the Preview's 500), if any. */
    private Exception preview(Handler handler) throws Exception {
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

    private static void run(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(SERVER + ";databaseName=" + database, USER, PASSWORD);
    }

    private long count(String id) throws SQLException {
        try (Connection connection = connect();
             var statement = connection.prepareStatement("SELECT COUNT(*) FROM items WHERE id = ?")) {
            statement.setString(1, id);
            try (ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1);
            }
        }
    }

    private static void admin(String sql) throws SQLException {
        try (Connection connection = DriverManager.getConnection(SERVER, USER, PASSWORD);
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}

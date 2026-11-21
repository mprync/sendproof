package io.github.mprync.sendproof.jdbc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.mysql.cj.jdbc.MysqlDataSource;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.core.RequestCapture;
import java.io.PrintWriter;
import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The MySQL transaction escapes of spec/data-stores.md "Transaction-control statements from the handler", against the
 * compose MySQL ({@code docker compose -f tests/conformance/compose.yml up -d --wait mysql}, or {@code BENCH_MYSQL_URL}).
 * Tests skip, saying so, when it doesn't answer.
 */
class MySqlEscapeTest {
    private static final String URL = System.getenv().getOrDefault("BENCH_MYSQL_URL",
            "mysql://root:bench_local@127.0.0.1:53306/mysql");
    private static String jdbcBase;
    private static String user;
    private static String password;
    private static boolean available;

    private final String database = "sp_jdbc_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final AtomicReference<Connection> physical = new AtomicReference<>();
    private DataSource raw;
    private PreviewDataSource enrolled;
    private JdbcPreviewProvider provider;

    @BeforeAll
    static void probe() {
        URI uri = URI.create(URL);
        String[] credentials = uri.getUserInfo().split(":", 2);
        user = credentials[0];
        password = credentials.length > 1 ? credentials[1] : "";
        jdbcBase = "jdbc:mysql://" + uri.getHost() + ":" + uri.getPort() + "/";
        try (Connection probe = DriverManager.getConnection(jdbcBase + "?connectTimeout=2000", user, password)) {
            available = probe.isValid(2);
        } catch (SQLException unreachable) {
            available = false;
        }
    }

    @BeforeEach
    void create() throws SQLException {
        assumeTrue(available, "MySQL isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mysql");
        admin("CREATE DATABASE " + database);
        var mysql = new MysqlDataSource();
        mysql.setUrl(jdbcBase + database + "?allowMultiQueries=true");
        mysql.setUser(user);
        mysql.setPassword(password);
        raw = recording(mysql);
        try (Connection connection = mysql.getConnection(); Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE items (id VARCHAR(40) PRIMARY KEY, name VARCHAR(100))");
            statement.execute("CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END");
            statement.execute("CREATE PROCEDURE audit_touch() BEGIN SELECT 1; END");
        }
        enrolled = new PreviewDataSource(raw, () -> true);
        provider = new JdbcPreviewProvider(enrolled, () -> "Test");
    }

    @AfterEach
    void drop() throws SQLException {
        if (available) {
            admin("DROP DATABASE IF EXISTS " + database);
        }
    }

    @Test
    void theProviderKnowsItIsMySql() {
        assertThat(provider.databaseSystem()).isEqualTo("mysql");
    }

    @Test
    void aCallIsRefusedBeforeSendingAndTheDeclaredProcedureRuns() throws Exception {
        Outcome refused = preview(provider, connection -> {
            insert(connection, "called");
            assertThatThrownBy(() -> run(connection, "CALL sendproof_commit_probe()"))
                    .hasMessageContaining("CALL");
        });
        assertThat(refused.failure()).as("a refused statement fails the Preview").isNotNull();
        assertThat(count("called")).as("the procedure's COMMIT never ran").isZero();

        Outcome declared = preview(provider.safeProcedures("audit_touch"), connection -> {
            insert(connection, "declared");
            run(connection, "CALL audit_touch()");
            assertThatThrownBy(() -> run(connection, "CALL sendproof_commit_probe()")).hasMessageContaining("CALL");
        });
        assertThat(declared.failure()).as("the undeclared CALL still fails the Preview").isNotNull();
        assertThat(count("declared")).isZero();

        Outcome safe = preview(provider, connection -> {
            insert(connection, "safe");
            run(connection, "CALL audit_touch()");
        });
        assertThat(safe.failure()).isNull();
        assertThat(count("safe")).isZero();
    }

    @Test
    void anImplicitlyCommittingStatementIsRefusedBeforeSending() throws Exception {
        Outcome outcome = preview(provider, connection -> {
            insert(connection, "ddl");
            assertThatThrownBy(() -> run(connection, "/*!50001 CREATE TABLE sendproof_escape_ddl (n INT) */"))
                    .hasMessageContaining("CREATE");
        });
        assertThat(outcome.failure()).isNotNull();
        assertThat(count("ddl")).isZero();
        assertThat(tableExists("sendproof_escape_ddl")).isFalse();
    }

    @Test
    void aCommitTheGuardsMissFailsThePreviewEvenAfterANewTransactionStarts() throws Exception {
        Outcome outcome = preview(provider, connection -> {
            insert(connection, "escaped");
            // Something the guards don't see commits: here, the driver's own connection, past every Sendproof wrapper.
            physical.get().commit();
            // With auto-commit off MySQL opens a new transaction implicitly, so a check made only at the end (a fresh
            // SAVEPOINT then RELEASE) would succeed and wrongly report the Preview transaction as still open.
            insert(connection, "after");
            try (Statement probe = physical.get().createStatement()) {
                probe.execute("SAVEPOINT end_only_probe");
                probe.execute("RELEASE SAVEPOINT end_only_probe");
            }
        });
        assertThat(outcome.failure()).as("the backstop fails the Preview").isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("committed");
        assertThat(count("after")).as("writes after the commit are still rolled back").isZero();
        assertThat(outcome.sql()).as("the probe stays out of the captured SQL").doesNotContain("sendproof_preview");
    }

    @Test
    void aHandlerRollbackKeepsThePreviewConfirmable() throws Exception {
        Outcome outcome = preview(provider, connection -> {
            insert(connection, "undone");
            connection.rollback();
            insert(connection, "kept");
        });
        assertThat(outcome.failure()).isNull();
        assertThat(count("kept")).isZero();
    }

    @Test
    void theHandlerCannotTouchTheBackstopSavepoint() throws Exception {
        for (String sql : new String[] {"RELEASE SAVEPOINT sendproof_preview", "ROLLBACK TO sendproof_preview",
                "SAVEPOINT sendproof_preview"}) {
            Outcome outcome = preview(provider, connection ->
                    assertThatThrownBy(() -> run(connection, sql)).as(sql).isInstanceOf(IllegalStateException.class));
            assertThat(outcome.failure()).as(sql).isNotNull();
        }
        Savepoint named = new Savepoint() {
            @Override
            public int getSavepointId() throws SQLException {
                throw new SQLException("named");
            }

            @Override
            public String getSavepointName() {
                return "SENDPROOF_PREVIEW";
            }
        };
        Outcome outcome = preview(provider, connection -> {
            assertThatThrownBy(() -> connection.releaseSavepoint(named)).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> connection.rollback(named)).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> connection.setSavepoint("sendproof_preview")).isInstanceOf(IllegalStateException.class);
        });
        assertThat(outcome.failure()).isNotNull();
    }

    private interface Handler {
        void run(Connection connection) throws Exception;
    }

    private record Outcome(Exception failure, String sql) {
    }

    /** Runs {@code handler} as a Preview's handler and returns the rollback's failure (the Preview's 500), if any. */
    private Outcome preview(JdbcPreviewProvider previews, Handler handler) throws Exception {
        var scope = new JdbcScope();
        var capture = new RequestCapture();
        Exception failure = null;
        try (var ignored = scope.enter(); var capturing = CaptureContext.enter(capture)) {
            capture.begin(true, System.nanoTime());
            PreviewSession session = previews.begin();
            try {
                try (Connection connection = enrolled.getConnection()) {
                    handler.run(connection);
                }
                try {
                    session.rollback();
                } catch (Exception rollbackFailure) {
                    failure = rollbackFailure;
                }
            } finally {
                session.close();
            }
        }
        var sql = new StringBuilder();
        capture.finish().logs().stream().filter(log -> log.sql() != null).forEach(log -> sql.append(log.sql().text()).append('\n'));
        return new Outcome(failure, sql.toString());
    }

    private static void insert(Connection connection, String id) throws SQLException {
        try (var statement = connection.prepareStatement("INSERT INTO items (id, name) VALUES (?, ?)")) {
            statement.setString(1, id);
            statement.setString(2, "Item");
            statement.executeUpdate();
        }
    }

    private static void run(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private long count(String id) throws SQLException {
        try (Connection connection = DriverManager.getConnection(jdbcBase + database, user, password);
             var statement = connection.prepareStatement("SELECT COUNT(*) FROM items WHERE id = ?")) {
            statement.setString(1, id);
            try (ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1);
            }
        }
    }

    private boolean tableExists(String table) throws SQLException {
        try (Connection connection = DriverManager.getConnection(jdbcBase + database, user, password);
             ResultSet tables = connection.getMetaData().getTables(database, null, table, null)) {
            return tables.next();
        }
    }

    private static void admin(String sql) throws SQLException {
        try (Connection connection = DriverManager.getConnection(jdbcBase, user, password);
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    /** Hands out the driver's connections and remembers the last one, so a test can commit past every wrapper. */
    private DataSource recording(MysqlDataSource target) {
        return new DataSource() {
            @Override
            public Connection getConnection() throws SQLException {
                Connection connection = target.getConnection();
                physical.set(connection);
                return connection;
            }

            @Override
            public Connection getConnection(String username, String secret) throws SQLException {
                Connection connection = target.getConnection(username, secret);
                physical.set(connection);
                return connection;
            }

            @Override
            public PrintWriter getLogWriter() throws SQLException {
                return target.getLogWriter();
            }

            @Override
            public void setLogWriter(PrintWriter out) throws SQLException {
                target.setLogWriter(out);
            }

            @Override
            public void setLoginTimeout(int seconds) throws SQLException {
                target.setLoginTimeout(seconds);
            }

            @Override
            public int getLoginTimeout() throws SQLException {
                return target.getLoginTimeout();
            }

            @Override
            public Logger getParentLogger() {
                return Logger.getGlobal();
            }

            @Override
            public <T> T unwrap(Class<T> type) throws SQLException {
                return target.unwrap(type);
            }

            @Override
            public boolean isWrapperFor(Class<?> type) throws SQLException {
                return target.isWrapperFor(type);
            }
        };
    }
}

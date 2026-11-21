package io.github.mprync.sendproof.jpa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.jpa.testapp.JpaTestApp;
import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.proxy.ProxyJdbcObject;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The MySQL transaction escapes of spec/data-stores.md "Transaction-control statements from the handler" through the
 * Spring-managed provider, against the compose MySQL ({@code docker compose -f tests/conformance/compose.yml up -d
 * --wait mysql}, or {@code BENCH_MYSQL_URL}). The class is skipped when MySQL doesn't answer.
 */
@SpringBootTest(classes = JpaTestApp.class, properties = {
        "spring.jpa.hibernate.ddl-auto=create-drop", "sendproof.enabled=true", "sendproof.environment=Development",
        "sendproof.sql.safe-procedures=audit_touch"})
@EnabledIf("mysqlAvailable")
class MySqlJpaEscapeTest {
    private static final URI URL = URI.create(System.getenv().getOrDefault("BENCH_MYSQL_URL",
            "mysql://root:bench_local@127.0.0.1:53306/mysql"));
    private static final String DATABASE = "sp_jpa_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);

    @Autowired
    JpaPreviewProvider provider;
    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    DataSource dataSource;

    static boolean mysqlAvailable() {
        try (Connection probe = DriverManager.getConnection(base() + "?connectTimeout=2000", user(), password())) {
            return probe.isValid(2);
        } catch (SQLException unreachable) {
            return false;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) throws SQLException {
        admin("CREATE DATABASE " + DATABASE);
        try (Connection connection = DriverManager.getConnection(base() + DATABASE, user(), password());
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE PROCEDURE sendproof_commit_probe() BEGIN COMMIT; END");
            statement.execute("CREATE PROCEDURE audit_touch() BEGIN SELECT 1; END");
        }
        registry.add("spring.datasource.url", () -> base() + DATABASE + "?allowMultiQueries=true");
        registry.add("spring.datasource.username", MySqlJpaEscapeTest::user);
        registry.add("spring.datasource.password", MySqlJpaEscapeTest::password);
    }

    @AfterAll
    static void drop() throws SQLException {
        if (mysqlAvailable()) {
            admin("DROP DATABASE IF EXISTS " + DATABASE);
        }
    }

    @Test
    void aCallIsRefusedBeforeSendingAndTheDeclaredProcedureRuns() {
        Exception refused = preview(() -> {
            insert("called");
            assertThatThrownBy(() -> jdbc.execute("CALL sendproof_commit_probe()")).hasStackTraceContaining("CALL");
        });
        assertThat(refused).as("a refused statement fails the Preview").isNotNull();
        assertThat(count("called")).as("the procedure's COMMIT never ran").isZero();

        Exception declared = preview(() -> {
            insert("declared");
            jdbc.execute("CALL audit_touch()");
        });
        assertThat(declared).as("sendproof.sql.safe-procedures declares audit_touch").isNull();
        assertThat(count("declared")).isZero();
    }

    @Test
    void anImplicitlyCommittingStatementIsRefusedBeforeSending() {
        Exception outcome = preview(() -> {
            insert("ddl");
            assertThatThrownBy(() -> jdbc.execute("/*!50001 CREATE TABLE sendproof_escape_ddl (n INT) */"))
                    .hasStackTraceContaining("CREATE");
        });
        assertThat(outcome).isNotNull();
        assertThat(count("ddl")).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ? "
                + "AND table_name = 'sendproof_escape_ddl'", Integer.class, DATABASE)).isZero();
    }

    @Test
    void aCommitTheGuardsMissFailsThePreviewEvenAfterANewTransactionStarts() {
        Exception outcome = preview(() -> {
            insert("escaped");
            // Something the guards don't see commits: here, the pool's connection, past every Sendproof wrapper.
            Connection physical = (Connection) ((ProxyJdbcObject) DataSourceUtils.getConnection(dataSource)).getTarget();
            try {
                physical.commit();
                // With auto-commit off MySQL opens a new transaction implicitly, so a check made only at the end (a fresh
                // SAVEPOINT then RELEASE) would succeed and wrongly report the Preview transaction as still open.
                insert("after");
                try (Statement probe = physical.createStatement()) {
                    probe.execute("SAVEPOINT end_only_probe");
                    probe.execute("RELEASE SAVEPOINT end_only_probe");
                }
            } catch (SQLException failure) {
                throw new IllegalStateException(failure);
            }
        });
        assertThat(outcome).as("the backstop fails the Preview").isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("committed");
        assertThat(count("after")).as("writes after the commit are still rolled back").isZero();
        jdbc.update("DELETE FROM widgets WHERE id = 'escaped'");
    }

    /**
     * A deadlock rolls the whole Preview transaction back. The Preview is made the victim (the other transaction wrote
     * more rows, and InnoDB rolls back the smaller one); the handler catches the error and retries the write.
     */
    @Test
    void afterADeadlockEveryFurtherStatementIsRefusedAndARetryNeverCommits() throws Exception {
        insertCommitted("a");
        insertCommitted("b");
        try (Connection other = DriverManager.getConnection(base() + DATABASE, user(), password())) {
            other.setAutoCommit(false);
            try (Statement statement = other.createStatement()) {
                statement.execute("INSERT INTO widgets (id, name) VALUES ('w1', 'w'), ('w2', 'w'), ('w3', 'w'), ('w4', 'w')");
                statement.execute("UPDATE widgets SET name = 'other' WHERE id = 'b'");
            }
            var original = new java.util.concurrent.atomic.AtomicReference<RuntimeException>();
            Exception outcome = preview(() -> {
                jdbc.update("UPDATE widgets SET name = 'preview' WHERE id = 'a'");
                var blocked = new Thread(() -> {
                    try (Statement statement = other.createStatement()) {
                        statement.execute("UPDATE widgets SET name = 'other' WHERE id = 'a'");
                    } catch (SQLException ignored) {
                        // The other side wins the deadlock.
                    }
                });
                blocked.start();
                try {
                    Thread.sleep(300);
                    jdbc.update("UPDATE widgets SET name = 'preview' WHERE id = 'b'");
                } catch (RuntimeException deadlock) {
                    original.set(deadlock);
                } catch (InterruptedException interrupted) {
                    throw new IllegalStateException(interrupted);
                }
                try {
                    blocked.join(10_000);
                } catch (InterruptedException interrupted) {
                    throw new IllegalStateException(interrupted);
                }
                // The handler's retry, as a retry policy would make it: refused before sending.
                assertThatThrownBy(() -> insert("retry")).hasStackTraceContaining("rolled the Preview transaction back");
            });
            other.rollback();
            assertThat(original.get()).as("the handler saw the database's own deadlock")
                    .hasStackTraceContaining("Deadlock");
            assertThat(outcome).as("the Preview fails").isNotNull();
            assertThat(count("retry")).isZero();
        } finally {
            jdbc.update("DELETE FROM widgets WHERE id IN ('a', 'b')");
        }
    }

    private void insertCommitted(String id) {
        try (Connection connection = DriverManager.getConnection(base() + DATABASE, user(), password());
             var statement = connection.prepareStatement("INSERT INTO widgets (id, name) VALUES (?, 'Widget')")) {
            statement.setString(1, id);
            statement.executeUpdate();
        } catch (SQLException failure) {
            throw new IllegalStateException(failure);
        }
    }

    @Test
    void aHandlerRollbackKeepsThePreviewConfirmable() {
        Exception outcome = preview(() -> {
            insert("undone");
            try {
                DataSourceUtils.getConnection(dataSource).rollback();
            } catch (SQLException failure) {
                throw new IllegalStateException(failure);
            }
            insert("kept");
        });
        assertThat(outcome).isNull();
        assertThat(count("kept")).isZero();
    }

    @Test
    void theHandlerCannotTouchTheBackstopSavepoint() {
        for (String sql : new String[] {"RELEASE SAVEPOINT sendproof_preview", "ROLLBACK TO sendproof_preview",
                "SAVEPOINT sendproof_preview"}) {
            Exception outcome = preview(() -> assertThatThrownBy(() -> jdbc.execute(sql)).as(sql).isNotNull());
            assertThat(outcome).as(sql).isNotNull();
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
        Exception outcome = preview(() -> {
            Connection connection = DataSourceUtils.getConnection(dataSource);
            assertThatThrownBy(() -> connection.releaseSavepoint(named)).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> connection.rollback(named)).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> connection.setSavepoint("sendproof_preview")).isInstanceOf(IllegalStateException.class);
        });
        assertThat(outcome).isNotNull();
    }

    /** Runs {@code handler} as a Preview's handler and returns the rollback's failure (the Preview's 500), if any. */
    private Exception preview(Runnable handler) {
        PreviewSession session = provider.begin();
        try {
            handler.run();
            session.rollback();
            return null;
        } catch (Exception failure) {
            return failure;
        } finally {
            try {
                session.close();
            } catch (Exception ignored) {
                // The rollback's outcome is the one under test.
            }
        }
    }

    private void insert(String id) {
        jdbc.update("INSERT INTO widgets (id, name) VALUES (?, ?)", id, "Widget");
    }

    private long count(String id) {
        try (Connection connection = DriverManager.getConnection(base() + DATABASE, user(), password());
             var statement = connection.prepareStatement("SELECT COUNT(*) FROM widgets WHERE id = ?")) {
            statement.setString(1, id);
            try (var rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException(failure);
        }
    }

    private static String base() {
        return "jdbc:mysql://" + URL.getHost() + ":" + URL.getPort() + "/";
    }

    private static String user() {
        return URL.getUserInfo().split(":", 2)[0];
    }

    private static String password() {
        String[] credentials = URL.getUserInfo().split(":", 2);
        return credentials.length > 1 ? credentials[1] : "";
    }

    private static void admin(String sql) throws SQLException {
        try (Connection connection = DriverManager.getConnection(base(), user(), password());
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}

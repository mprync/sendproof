package io.github.mprync.sendproof.jpa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.mprync.sendproof.core.PreviewSession;
import io.github.mprync.sendproof.jpa.testapp.JpaTestApp;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import net.ttddyy.dsproxy.proxy.ProxyJdbcObject;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The Spring-managed provider on SQL Server (compose service; the class is skipped when it doesn't answer): an error
 * under {@code XACT_ABORT ON} ends the Preview transaction, so every further statement is refused; and the start-savepoint
 * backstop fails a Preview whose transaction was committed by a route the guard can't see.
 */
@SpringBootTest(classes = JpaTestApp.class, properties = {
        "spring.jpa.hibernate.ddl-auto=create-drop", "sendproof.enabled=true", "sendproof.environment=Development"})
@EnabledIf("sqlServerAvailable")
class SqlServerJpaTest {
    private static final String SERVER = "jdbc:sqlserver://127.0.0.1:51433;encrypt=false;trustServerCertificate=true;"
            + "loginTimeout=3";
    private static final String PASSWORD = "BenchLocal_2026!";
    private static final String DATABASE = "sp_jpa_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);

    @Autowired
    JpaPreviewProvider provider;
    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    DataSource dataSource;

    static boolean sqlServerAvailable() {
        try (Connection probe = DriverManager.getConnection(SERVER, "sa", PASSWORD)) {
            return probe.isValid(3);
        } catch (SQLException unreachable) {
            return false;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) throws SQLException {
        admin("CREATE DATABASE " + DATABASE);
        registry.add("spring.datasource.url", () -> SERVER + ";databaseName=" + DATABASE);
        registry.add("spring.datasource.username", () -> "sa");
        registry.add("spring.datasource.password", () -> PASSWORD);
    }

    @AfterAll
    static void drop() throws SQLException {
        if (sqlServerAvailable()) {
            admin("ALTER DATABASE " + DATABASE + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + DATABASE);
        }
    }

    @BeforeEach
    void seed() {
        jdbc.update("DELETE FROM widgets");
        jdbc.update("INSERT INTO widgets (id, name) VALUES ('a', 'a')");
    }

    @Test
    void anErrorUnderXactAbortEndsThePreviewAndEveryFurtherStatementIsRefused() {
        Exception outcome = preview(() -> {
            jdbc.execute("SET XACT_ABORT ON");
            // A duplicate key: under XACT_ABORT ON the server rolls the whole transaction back.
            assertThatThrownBy(() -> jdbc.update("INSERT INTO widgets (id, name) VALUES ('a', 'dup')")).isNotNull();
            assertThatThrownBy(() -> jdbc.update("INSERT INTO widgets (id, name) VALUES ('after', 'x')"))
                    .hasStackTraceContaining("rolled the Preview transaction back");
        });
        assertThat(outcome).as("the Preview fails").isNotNull();
        assertThat(count("after")).isZero();
    }

    @Test
    void anErrorThatKeepsTheTransactionLeavesThePreviewConfirmable() {
        Exception outcome = preview(() -> {
            // A session setting: another test may have left it on for this pooled connection.
            jdbc.execute("SET XACT_ABORT OFF");
            assertThatThrownBy(() -> jdbc.update("INSERT INTO widgets (id, name) VALUES ('a', 'dup')")).isNotNull();
            jdbc.update("INSERT INTO widgets (id, name) VALUES ('fine', 'x')");
        });
        assertThat(outcome).isNull();
        assertThat(count("fine")).isZero();
    }

    @Test
    void aCommitTheGuardsMissFailsThePreview() {
        Exception outcome = preview(() -> {
            jdbc.update("INSERT INTO widgets (id, name) VALUES ('escaped', 'x')");
            // Past every Sendproof wrapper: the pool's own connection.
            Connection physical = (Connection) ((ProxyJdbcObject) DataSourceUtils.getConnection(dataSource)).getTarget();
            try {
                physical.commit();
            } catch (SQLException failure) {
                throw new IllegalStateException(failure);
            }
            jdbc.update("INSERT INTO widgets (id, name) VALUES ('after', 'x')");
        });
        assertThat(outcome).as("the backstop fails the Preview").hasMessageContaining("committed");
        assertThat(count("escaped")).as("the commit the guard couldn't see happened").isEqualTo(1);
        assertThat(count("after")).isZero();
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

    private long count(String id) {
        try (Connection connection = DriverManager.getConnection(SERVER + ";databaseName=" + DATABASE, "sa", PASSWORD);
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

    private static void admin(String sql) throws SQLException {
        try (Connection connection = DriverManager.getConnection(SERVER, "sa", PASSWORD);
             Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}

package dev.testbench.jdbc;

import static org.assertj.core.api.Assertions.assertThat;

import dev.testbench.core.CaptureContext;
import dev.testbench.core.PreviewChange;
import dev.testbench.core.RequestCapture;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class JdbcPreviewTest {
    private JdbcDataSource raw;
    private PreviewDataSource enrolled;
    private JdbcPreviewProvider provider;

    @BeforeEach
    void database() throws SQLException {
        raw = new JdbcDataSource();
        raw.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        try (Connection connection = raw.getConnection(); var statement = connection.createStatement()) {
            statement.execute("create table items (id varchar(40) primary key, name varchar(100))");
        }
        enrolled = new PreviewDataSource(raw, () -> true);
        provider = new JdbcPreviewProvider(enrolled, () -> "Test");
    }

    private int count() throws SQLException {
        try (Connection connection = raw.getConnection(); var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("select count(*) from items")) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private void execute(String sql, Object... values) throws SQLException {
        try (Connection connection = enrolled.getConnection(); PreparedStatement statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < values.length; i++) {
                statement.setObject(i + 1, values[i]);
            }
            statement.executeUpdate();
            connection.commit();
        }
    }

    @Test
    void everyBorrowerSharesOneTransactionThatIsRolledBack() throws Exception {
        var scope = new JdbcScope();
        var capture = new RequestCapture();
        try (var ignored = scope.enter(); var capturing = CaptureContext.enter(capture)) {
            capture.begin(true, System.nanoTime());
            var session = provider.begin();
            execute("insert into items (id, name) values (?, ?)", "a", "Alpha");
            execute("insert into items (id, name) values (?, ?)", "b", "Beta");
            // The second borrower sees the first's uncommitted row: it is the same connection.
            try (Connection connection = enrolled.getConnection(); var statement = connection.createStatement();
                 ResultSet rows = statement.executeQuery("select count(*) from items")) {
                rows.next();
                assertThat(rows.getInt(1)).isEqualTo(2);
                assertThat(connection.getAutoCommit()).isFalse();
                assertThat(connection.isClosed()).isFalse();
            }
            session.rollback();
            session.close();
        }
        assertThat(count()).isZero();
    }

    @Test
    void simpleWritesAreReportedAsRowChanges() throws Exception {
        try (Connection connection = raw.getConnection(); var statement = connection.createStatement()) {
            statement.execute("insert into items values ('k', 'Old')");
        }
        var scope = new JdbcScope();
        var capture = new RequestCapture();
        List<PreviewChange> changes;
        try (var ignored = scope.enter(); var capturing = CaptureContext.enter(capture)) {
            capture.begin(true, System.nanoTime());
            var session = provider.begin();
            execute("insert into items (id, name) values (?, ?)", "n", "New");
            execute("update items set name = ? where id = ?", "Renamed", "k");
            execute("delete from items where id = ?", "n");
            changes = session.changes();
            session.rollback();
            session.close();
        }
        assertThat(changes).extracting(PreviewChange::operation).containsExactly("insert", "update", "delete");
        assertThat(changes.get(0).key()).isEqualTo(Map.of("id", "n"));
        assertThat(changes.get(0).before()).isNull();
        assertThat(changes.get(0).after()).isEqualTo(Map.of("id", "n", "name", "New"));
        assertThat(changes.get(1).key()).isEqualTo(Map.of("id", "k"));
        assertThat(map(changes.get(1).before())).containsEntry("name", "Old");
        assertThat(map(changes.get(1).after())).containsEntry("name", "Renamed");
        assertThat(map(changes.get(2).before())).containsEntry("name", "New");
        assertThat(changes.get(2).after()).isNull();

        var logs = capture.finish().logs().stream().filter(log -> log.sql() != null).toList();
        assertThat(logs).extracting(log -> log.sql().text()).contains("insert into items (id, name) values (?, ?)");
        // The snapshot reads are not part of the application's SQL.
        assertThat(logs).extracting(log -> log.sql().text()).noneMatch(text -> text.startsWith("select * from"));
        assertThat(count()).isEqualTo(1);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @Test
    void unsupportedShapesAreLoggedButNotReportedAsChanges() throws Exception {
        var scope = new JdbcScope();
        var capture = new RequestCapture();
        try (var ignored = scope.enter(); var capturing = CaptureContext.enter(capture)) {
            capture.begin(true, System.nanoTime());
            var session = provider.begin();
            execute("insert into items (id, name) values (?, ?)", "a", "x");
            execute("update items set name = upper(name) where id like ?", "%");
            assertThat(session.changes()).hasSize(1);
            session.rollback();
            session.close();
        }
        assertThat(capture.finish().logs().stream().filter(log -> log.sql() != null)).hasSize(2);
    }

    @Test
    void outsideAPreviewTheBorrowerIsAnOrdinaryPooledConnection() throws Exception {
        execute("insert into items (id, name) values (?, ?)", "kept", "Persisted");
        assertThat(count()).isEqualTo(1);
    }

    @Test
    void beginningWithoutAScopeFails() {
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, () -> provider.begin());
    }

    /** Runs {@code escape} inside a preview, expecting it to be refused, and returns the rollback's failure. */
    private Exception refusedPreview(SqlAction escape) throws Exception {
        var scope = new JdbcScope();
        try (var ignored = scope.enter()) {
            var session = provider.begin();
            execute("insert into items (id, name) values (?, ?)", "x", "Escaping");
            try (Connection connection = enrolled.getConnection()) {
                org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, () -> escape.run(connection));
            }
            Exception failure = null;
            try {
                session.rollback();
            } catch (IllegalStateException error) {
                failure = error;
            } finally {
                session.close();
            }
            return failure;
        }
    }

    @FunctionalInterface
    private interface SqlAction {
        void run(Connection connection) throws Exception;
    }

    @Test
    void aCommitReachedThroughTheStatementIsRefusedAndFailsThePreview() throws Exception {
        Exception failure = refusedPreview(connection -> {
            try (var statement = connection.createStatement()) {
                statement.getConnection().commit();
            }
        });
        assertThat(failure).hasMessageContaining("Connection.commit()");
        assertThat(count()).isZero();
    }

    @Test
    void transactionControlAndDdlStatementsAreRefused() throws Exception {
        for (String sql : List.of("commit", "COMMIT WORK", "rollback", "create table other (id int)",
                "/* hidden */ start transaction", "select 1; commit", "set autocommit true")) {
            Exception failure = refusedPreview(connection -> {
                try (var statement = connection.createStatement()) {
                    statement.execute(sql);
                }
            });
            assertThat(failure).as(sql).isNotNull();
            assertThat(count()).as(sql).isZero();
        }
    }

    @Test
    void unwrappingToTheDriverConnectionIsRefused() throws Exception {
        Exception failure = refusedPreview(connection -> connection.unwrap(org.h2.jdbc.JdbcConnection.class).commit());
        assertThat(failure).isNotNull();
        assertThat(count()).isZero();
        assertThat(DmlStatement.parse("insert into items (id, name) values (?, ?)")).isNotNull();
    }

    @Test
    void savepointsStayAllowed() throws Exception {
        var scope = new JdbcScope();
        try (var ignored = scope.enter()) {
            var session = provider.begin();
            try (Connection connection = enrolled.getConnection(); var statement = connection.createStatement()) {
                var savepoint = connection.setSavepoint();
                statement.execute("insert into items (id, name) values ('s', 'Saved')");
                connection.rollback(savepoint);
                statement.execute("savepoint named");
                statement.execute("rollback to savepoint named");
            }
            session.rollback();
            session.close();
        }
        assertThat(count()).isZero();
    }

    @Test
    void secretColumnsAreHiddenInChangeSnapshots() throws Exception {
        try (Connection connection = raw.getConnection(); var statement = connection.createStatement()) {
            statement.execute("create table users (id varchar(40) primary key, password_hash varchar(100))");
            statement.execute("insert into users values ('u', 'old-hash')");
        }
        var scope = new JdbcScope();
        List<PreviewChange> changes;
        try (var ignored = scope.enter()) {
            var session = provider.begin();
            execute("update users set password_hash = ? where id = ?", "new-hash", "u");
            changes = session.changes();
            session.rollback();
            session.close();
        }
        var snapshot = dev.testbench.core.CaptureLimits.snapshotChanges(changes).changes().get(0);
        assertThat(snapshot.toString()).doesNotContain("old-hash").doesNotContain("new-hash");
        assertThat(((com.fasterxml.jackson.databind.JsonNode) snapshot.before()).get("password_hash").asText())
                .isEqualTo("[REDACTED]");
        assertThat(((com.fasterxml.jackson.databind.JsonNode) snapshot.key()).get("id").asText()).isEqualTo("u");
    }

    @Test
    void dmlShapesAreParsedConservatively() {
        // Quoted names that are not plain identifiers are never spliced into the change reader's own SQL.
        assertThat(DmlStatement.parse("update items set name = ? where \"id\" = ?")).isNotNull();
        assertThat(DmlStatement.parse("update items set name = ? where \"a b\" = ?")).isNull();
        assertThat(DmlStatement.parse("insert into items (\"x) or 1=1 --\", name) values (?, ?)")).isNull();
        assertThat(DmlStatement.parse("insert into items (id, name) values (?, ?)")).isNotNull();
        assertThat(DmlStatement.parse("update items set name = ?, n = ? where id = ? and k = ?")).isNotNull();
        assertThat(DmlStatement.parse("delete from items where id = ?")).isNotNull();
        assertThat(DmlStatement.parse("update items set n = n + 1 where id = ?")).isNull();
        assertThat(DmlStatement.parse("delete from items where id in (?, ?)")).isNull();
        assertThat(DmlStatement.parse("delete from items")).isNull();
        assertThat(DmlStatement.parse("insert into items select * from other")).isNull();
        assertThat(DmlStatement.parse("update items set name = ? where id = ? or x = ?")).isNull();
    }
}

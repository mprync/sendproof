package io.github.mprync.sendproof.jpa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.RequestCapture;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.support.JdbcTransactionManager;

@SuppressWarnings("try")
class SpringJdbcHeldPreviewTest {
    private static final String POSTGRES = "jdbc:postgresql://127.0.0.1:55432/postgres";

    @Test
    void sqlitePinsTheWriterLockAndRewindsTheCurrentStep(@TempDir Path directory) throws Exception {
        var source = new DriverManagerDataSource("jdbc:sqlite:" + directory.resolve("held.sqlite"));
        var store = store(source);
        store.jdbc.execute("create table widgets (id integer primary key)");
        try (var held = store.provider.beginHeld()) {
            assertThatThrownBy(store.provider::beginHeld).isInstanceOf(HeldPreview.StoreBusy.class);
            held.checkpoint();
            try (var first = held.begin(new RequestCapture())) {
                store.jdbc.update("insert into widgets values (1)");
                first.finish();
            }
            var second = held.checkpoint();
            try (var step = held.begin(new RequestCapture())) {
                store.jdbc.update("insert into widgets values (2)");
                step.finish();
            }
            second.rollback();
            second.discard();
            held.checkpoint();
            try (var step = held.begin(new RequestCapture())) {
                assertThat(store.jdbc.queryForList("select id from widgets", Integer.class)).containsExactly(1);
                step.finish();
            }
        }
        assertThat(store.jdbc.queryForList("select id from widgets", Integer.class)).isEmpty();
    }

    @Test
    void postgresClearsAnAbortedStepAndKeepsPriorWrites() throws Exception {
        assumeTrue(postgresAvailable(), "The conformance PostgreSQL service is unavailable.");
        var source = new DriverManagerDataSource(POSTGRES, "bench", "bench_local");
        var store = store(source);
        String table = "sp_jpa_" + UUID.randomUUID().toString().replace("-", "");
        store.jdbc.execute("create table " + table + " (id integer primary key)");
        try {
            try (var held = store.provider.beginHeld()) {
                held.checkpoint();
                try (var first = held.begin(new RequestCapture())) {
                    store.jdbc.update("insert into " + table + " values (1)");
                    first.finish();
                }
                var second = held.checkpoint();
                try (var step = held.begin(new RequestCapture())) {
                    store.jdbc.update("insert into " + table + " values (2)");
                    assertThatThrownBy(() -> store.jdbc.update("insert into " + table + " values (1)"))
                            .isInstanceOf(org.springframework.dao.DuplicateKeyException.class);
                    assertThatThrownBy(step::finish).isInstanceOf(SQLException.class);
                }
                second.rollback();
                second.discard();
                held.checkpoint();
                try (var third = held.begin(new RequestCapture())) {
                    assertThat(store.jdbc.queryForList("select id from " + table, Integer.class)).containsExactly(1);
                    third.finish();
                }
            }
            assertThat(store.jdbc.queryForList("select id from " + table, Integer.class)).isEmpty();
        } finally {
            store.jdbc.execute("drop table " + table);
        }
    }

    private static boolean postgresAvailable() {
        try (var connection = DriverManager.getConnection(POSTGRES + "?connectTimeout=2", "bench", "bench_local")) {
            return connection.isValid(2);
        } catch (SQLException unavailable) {
            return false;
        }
    }

    private static Store store(DriverManagerDataSource original) {
        var dataSource = new CaptureDataSource(original, new SqlCaptureListener(() -> false));
        var provider = new JpaPreviewProvider(new JdbcTransactionManager(dataSource), null, () -> "test");
        assertThat(provider.supportsHeldPreview()).isTrue();
        return new Store(provider, new JdbcTemplate(dataSource));
    }

    private record Store(JpaPreviewProvider provider, JdbcTemplate jdbc) {
    }
}

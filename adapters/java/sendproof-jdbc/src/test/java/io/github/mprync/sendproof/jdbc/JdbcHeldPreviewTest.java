package io.github.mprync.sendproof.jdbc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeout;

import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.RequestCapture;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.sqlite.SQLiteDataSource;

class JdbcHeldPreviewTest {
    @Test
    void sqliteReservesItsWriterAndRewindsWithoutCommitting(@TempDir Path directory) throws Exception {
        var source = new SQLiteDataSource();
        source.setUrl("jdbc:sqlite:" + directory.resolve("items.db"));
        source.setBusyTimeout(30000);
        try (var connection = source.getConnection(); var sql = connection.createStatement()) {
            sql.executeUpdate("CREATE TABLE items (id INTEGER PRIMARY KEY)");
        }
        var dataSource = new PreviewDataSource(source);
        var provider = new JdbcPreviewProvider(dataSource, () -> "items.db");
        assertThat(provider.supportsHeldPreview()).isTrue();
        try (HeldPreview held = provider.beginHeld()) {
            var busy = assertTimeout(Duration.ofSeconds(5),
                    () -> assertThrows(HeldPreview.StoreBusy.class, provider::beginHeld));
            assertThat(busy.getMessage()).isEqualTo("items.db");
            var secondProvider = new JdbcPreviewProvider(dataSource, () -> "items.db");
            assertTimeout(Duration.ofSeconds(5), () -> assertThrows(HeldPreview.StoreBusy.class, secondProvider::beginHeld));
            writeStep(held, dataSource, 1, false);
            var second = writeStep(held, dataSource, 2, false);
            second.rollback();
            second.discard();
            writeStep(held, dataSource, 3, true);
            held.checkpoint();
            try (var scope = new JdbcScope().enter(); var step = held.begin(new RequestCapture());
                 var connection = dataSource.getConnection()) {
                assertThat(count(connection)).isEqualTo(1);
                step.finish();
            }
            try (var outside = source.getConnection()) {
                assertThat(count(outside)).isZero();
            }
        }
        try (var outside = source.getConnection()) {
            assertThat(count(outside)).isZero();
        }
        try (var next = provider.beginHeld()) {
            assertThat(next).isNotNull();
        }
    }

    private static HeldPreview.Checkpoint writeStep(HeldPreview held, PreviewDataSource source, int id, boolean rollback)
            throws Exception {
        var point = held.checkpoint();
        try (var scope = new JdbcScope().enter(); var step = held.begin(new RequestCapture());
             var connection = source.getConnection(); var sql = connection.prepareStatement("INSERT INTO items VALUES (?)")) {
            sql.setInt(1, id);
            sql.executeUpdate();
            if (rollback) {
                connection.rollback();
                assertThat(step.changes()).isEmpty();
            } else {
                connection.commit();
            }
            step.finish();
        }
        return point;
    }

    private static int count(Connection connection) throws Exception {
        try (var sql = connection.createStatement(); var rows = sql.executeQuery("SELECT count(*) FROM items")) {
            rows.next();
            return rows.getInt(1);
        }
    }
}

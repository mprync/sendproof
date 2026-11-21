package io.github.mprync.sendproof.jpa;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Supplier;
import javax.sql.DataSource;

/**
 * Derives a short, non-secret label for the workbench from a {@link DataSource}. It never returns a URL, host,
 * path or credential; anything that is not a plain database name yields {@code null}.
 */
final class DatabaseLabel {
    private DatabaseLabel() {
    }

    /** Returns a supplier that resolves the label once, lazily. */
    static Supplier<String> lazy(DataSource dataSource) {
        return new Supplier<>() {
            private volatile boolean resolved;
            private volatile String label;

            @Override
            public String get() {
                if (!resolved) {
                    label = of(dataSource);
                    resolved = true;
                }
                return label;
            }
        };
    }

    /** Returns a supplier that resolves the SQL provider id ({@code postgresql}, {@code h2} ...) once, lazily. */
    static Supplier<String> lazySystem(DataSource dataSource) {
        return new Supplier<>() {
            private volatile boolean resolved;
            private volatile String system;

            @Override
            public String get() {
                if (!resolved) {
                    system = systemOf(dataSource);
                    resolved = true;
                }
                return system;
            }
        };
    }

    static String systemOf(DataSource dataSource) {
        if (dataSource == null) {
            return null;
        }
        try (Connection connection = dataSource.getConnection()) {
            return io.github.mprync.sendproof.core.DatabaseSystem.of(connection.getMetaData().getDatabaseProductName());
        } catch (SQLException | RuntimeException error) {
            return null;
        }
    }

    static String of(DataSource dataSource) {
        if (dataSource == null) {
            return null;
        }
        try (Connection connection = dataSource.getConnection()) {
            String url = connection.getMetaData().getURL();
            String product = connection.getMetaData().getDatabaseProductName();
            if (url != null && (url.contains(":mem:") || url.contains(":memory:") || url.contains("mode=memory"))) {
                String name = safe(product);
                return "In-memory " + (name == null ? "database" : name);
            }
            return safe(connection.getCatalog());
        } catch (SQLException | RuntimeException error) {
            return null;
        }
    }

    private static String safe(String value) {
        if (value == null || value.isBlank() || value.length() > 128) {
            return null;
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!Character.isLetterOrDigit(c) && c != ' ' && c != '.' && c != '_' && c != '-') {
                return null;
            }
        }
        return value;
    }
}

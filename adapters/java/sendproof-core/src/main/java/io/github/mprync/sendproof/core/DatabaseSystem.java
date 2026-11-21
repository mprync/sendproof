package io.github.mprync.sendproof.core;

import java.util.Locale;

/** Maps a JDBC product name to the SQL provider id that capabilities {@code database.system} carries. */
public final class DatabaseSystem {
    private DatabaseSystem() {
    }

    /**
     * Returns the provider id for {@code DatabaseMetaData.getDatabaseProductName()}: {@code postgresql}, {@code mysql},
     * {@code mariadb}, {@code mssql}, {@code sqlite}, {@code oracle} and {@code h2}; any other product is its name in
     * lower case with only letters and digits. Returns {@code null} for a blank name.
     */
    public static String of(String productName) {
        if (productName == null || productName.isBlank()) {
            return null;
        }
        String lower = productName.toLowerCase(Locale.ROOT);
        if (lower.contains("postgres")) {
            return "postgresql";
        }
        if (lower.contains("mariadb")) {
            return "mariadb";
        }
        if (lower.contains("mysql")) {
            return "mysql";
        }
        if (lower.contains("sql server")) {
            return "mssql";
        }
        if (lower.contains("sqlite")) {
            return "sqlite";
        }
        String id = lower.replaceAll("[^a-z0-9]", "");
        return id.isEmpty() ? null : id;
    }
}

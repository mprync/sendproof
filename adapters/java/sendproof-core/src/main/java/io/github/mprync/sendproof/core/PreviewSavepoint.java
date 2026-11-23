package io.github.mprync.sendproof.core;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Statement;

/**
 * The backstop of spec/data-stores.md "Transaction-control statements from the handler", for every SQL provider: proof,
 * just before the rollback, that nothing committed the Preview transaction by a route the pre-send guard couldn't see.
 *
 * <p>The provider makes savepoint {@value #NAME} right after it opens the Preview transaction. Before the final rollback:
 *
 * <p>the provider rolls back to the savepoint ({@code ROLLBACK TRANSACTION} on SQL Server, which makes it with
 * {@code SAVE TRANSACTION}), which fails once a commit has erased it. Rolling back to it rather than releasing it also
 * works in a PostgreSQL transaction a handled error left aborted, where any other statement would fail and wrongly
 * answer 500. {@code @@TRANCOUNT} alone isn't enough on SQL Server: with {@code IMPLICIT_TRANSACTIONS} on, the next
 * statement after a commit opens a new transaction.
 *
 * <p>A failed check answers 500 without confirmation. MySQL has no {@code @@in_transaction} and, with auto-commit off,
 * opens a new transaction after a commit, so only a savepoint made at the start tells the Preview's transaction from a
 * later one. Handler code can't release, roll back to or recreate the savepoint: {@link TransactionControl} refuses
 * statements that name it. Run it on the physical connection (not through the SQL capture) so the probe stays out of
 * the captured SQL log.
 */
public final class PreviewSavepoint {
    /** A name no ORM generates; Hibernate and Spring use unnamed JDBC savepoints. */
    public static final String NAME = "sendproof_preview";
    private static final java.util.regex.Pattern RESERVED = java.util.regex.Pattern.compile(NAME + "(_[0-9]+)?");

    private final Connection connection;
    private final boolean sqlServer;
    private final String name;
    private volatile Savepoint savepoint;
    private long transactionId;

    private PreviewSavepoint(Connection connection, boolean sqlServer, String name) {
        this.connection = connection;
        this.sqlServer = sqlServer;
        this.name = name;
    }

    /**
     * Makes the savepoint in the Preview transaction just opened on {@code connection}.
     *
     * @param system the SQL provider id ({@code mssql} uses {@code SAVE TRANSACTION}; others the JDBC savepoint API)
     */
    public static PreviewSavepoint open(Connection connection, String system) throws SQLException {
        return open(connection, system, NAME);
    }

    /** Makes a named checkpoint reserved for the adapter. */
    public static PreviewSavepoint open(Connection connection, String system, String name) throws SQLException {
        if (!RESERVED.matcher(name).matches()) {
            throw new IllegalArgumentException("Invalid Preview savepoint name.");
        }
        var made = new PreviewSavepoint(connection, TransactionControl.isSqlServer(system), name);
        made.reopen();
        return made;
    }

    public static boolean isReserved(String name) {
        String normalized = name.replace("`", "").replace("\"", "").replace("[", "").replace("]", "")
                .toLowerCase(java.util.Locale.ROOT);
        return RESERVED.matcher(normalized).matches();
    }

    /** The supported held transactions have a driver-specific way to check or release their savepoint. */
    public static boolean supportsHeld(String system) {
        return system != null && switch (system) {
            case "h2", "postgresql", "mysql", "mariadb", "mssql", "sqlite" -> true;
            default -> false;
        };
    }

    /** Starts a pinned SQL transaction, including its write reservation when the database is SQLite. */
    public static void beginHeld(Connection connection, String system) throws SQLException {
        if ("sqlite".equals(system)) {
            try (Statement statement = connection.createStatement()) {
                int timeout = sqlitePragma(statement, "busy_timeout");
                statement.execute("PRAGMA busy_timeout=1000");
                try {
                    connection.setAutoCommit(false);
                    // A deferred transaction only takes SQLite's writer lock on the first write.
                    int version = sqlitePragma(statement, "user_version");
                    statement.execute("PRAGMA user_version=" + version);
                } finally {
                    statement.execute("PRAGMA busy_timeout=" + timeout);
                }
            }
            return;
        }
        connection.setAutoCommit(false);
        if (PreviewTurns.needed(system)) {
            // InnoDB can otherwise ignore a savepoint taken before the first data statement.
            try (Statement statement = connection.createStatement()) {
                statement.execute("START TRANSACTION");
            }
        }
    }

    private static int sqlitePragma(Statement statement, String pragma) throws SQLException {
        try (var rows = statement.executeQuery("PRAGMA " + pragma)) {
            if (!rows.next()) {
                throw new SQLException("SQLite did not return its " + pragma + " value.");
            }
            return rows.getInt(1);
        }
    }

    public static boolean isStoreBusy(String system, SQLException error) {
        int code = error.getErrorCode();
        if ("sqlite".equals(system)) {
            int primary = code & 0xff;
            return primary == 5 || primary == 6;
        }
        return "55P03".equals(error.getSQLState()) || (TransactionControl.isSqlServer(system) && code == 1222)
                || (PreviewTurns.needed(system) && code == 1205);
    }

    /**
     * Makes the savepoint again after handler code rolled the whole transaction back (which erases savepoints but lets
     * nothing escape), so the check at the end still holds.
     */
    public void reopen() throws SQLException {
        if (sqlServer) {
            // The driver runs auto-commit off as IMPLICIT_TRANSACTIONS, which opens the transaction only at the first
            // data statement; SAVE TRANSACTION needs it open now. A table read opens it (BEGIN TRANSACTION would open
            // two, so a commit would leave one open); without implicit transactions BEGIN TRANSACTION does.
            try (Statement statement = connection.createStatement()) {
                statement.execute("IF @@TRANCOUNT = 0 AND (@@OPTIONS & 2) = 2 SELECT TOP 0 1 AS n FROM sys.objects; "
                        + "IF @@TRANCOUNT = 0 BEGIN TRANSACTION; SAVE TRANSACTION " + name);
                if (!NAME.equals(name)) {
                    try (var rows = statement.executeQuery("SELECT CURRENT_TRANSACTION_ID()")) {
                        if (!rows.next()) {
                            throw new SQLException("SQL Server did not return a transaction ID.");
                        }
                        transactionId = rows.getLong(1);
                    }
                }
            }
        } else {
            savepoint = connection.setSavepoint(name);
        }
    }

    /**
     * Proves the Preview transaction is still the one it opened.
     *
     * @throws IllegalStateException when something committed the Preview transaction, or the check couldn't run; either
     *                               way the Preview must not be confirmed
     */
    public void verify() {
        try {
            rollback();
        } catch (SQLException failure) {
            throw committed(failure);
        }
    }

    public void rollback() throws SQLException {
        if (sqlServer) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("ROLLBACK TRANSACTION " + name);
            }
        } else {
            connection.rollback(savepoint);
        }
    }

    /** SQL Server has no release operation. Subsequent steps can reuse the name after rewind. */
    public void release() throws SQLException {
        if (!sqlServer) {
            connection.releaseSavepoint(savepoint);
        }
    }

    /** Fails when the database left the transaction in an aborted state, without undoing successful writes. */
    public void check() throws SQLException {
        try (Statement statement = connection.createStatement();
             var rows = statement.executeQuery(sqlServer ? "SELECT XACT_STATE(), CURRENT_TRANSACTION_ID()" : "SELECT 1")) {
            if (!rows.next() || rows.getInt(1) != 1
                    || (sqlServer && !NAME.equals(name) && rows.getLong(2) != transactionId)) {
                throw new SQLException("The held Preview transaction is unusable.");
            }
        }
    }

    private static IllegalStateException committed(SQLException cause) {
        return new IllegalStateException("Something committed the Preview's SQL transaction while the handler ran (its "
                + "savepoint is gone), so its writes may have persisted and the Preview can't be confirmed.", cause);
    }
}

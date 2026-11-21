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

    private final Connection connection;
    private final boolean sqlServer;
    private volatile Savepoint savepoint;

    private PreviewSavepoint(Connection connection, boolean sqlServer) {
        this.connection = connection;
        this.sqlServer = sqlServer;
    }

    /**
     * Makes the savepoint in the Preview transaction just opened on {@code connection}.
     *
     * @param system the SQL provider id ({@code mssql} uses {@code SAVE TRANSACTION}; others the JDBC savepoint API)
     */
    public static PreviewSavepoint open(Connection connection, String system) throws SQLException {
        var made = new PreviewSavepoint(connection, TransactionControl.isSqlServer(system));
        made.reopen();
        return made;
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
                        + "IF @@TRANCOUNT = 0 BEGIN TRANSACTION; SAVE TRANSACTION " + NAME);
            }
        } else {
            savepoint = connection.setSavepoint(NAME);
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
            if (sqlServer) {
                // Not just @@TRANCOUNT: with IMPLICIT_TRANSACTIONS on (how drivers run auto-commit off) the next
                // statement after a commit opens a new transaction, so only the savepoint tells the Preview's apart.
                try (Statement statement = connection.createStatement()) {
                    statement.execute("ROLLBACK TRANSACTION " + NAME);
                }
            } else {
                connection.rollback(savepoint);
            }
        } catch (SQLException failure) {
            throw committed(failure);
        }
    }

    private static IllegalStateException committed(SQLException cause) {
        return new IllegalStateException("Something committed the Preview's SQL transaction while the handler ran (its "
                + "savepoint is gone), so its writes may have persisted and the Preview can't be confirmed.", cause);
    }
}

package io.github.mprync.sendproof.core;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * The MySQL and MariaDB backstop of spec/data-stores.md "Transaction-control statements from the handler": proof, just
 * before the rollback, that nothing committed the Preview transaction.
 *
 * <p>MySQL has no {@code @@in_transaction}, and with auto-commit off (as JDBC and Hibernate run transactions) it starts a
 * new transaction implicitly after any commit, so "is a transaction open" can't tell the Preview's from a later one.
 * Instead the provider makes savepoint {@value #NAME} right after it opens the Preview transaction, and rolls back to it
 * before the final rollback. Every commit, explicit or implicit, erases every savepoint, so a missing savepoint (MySQL
 * error 1305) means the Preview's writes were committed: the Preview answers 500 without confirmation. Handler code can't
 * release, roll back to or recreate the savepoint: {@link TransactionControl} refuses statements that name it.
 *
 * <p>Run it on the physical connection (not through the SQL capture) so the probe stays out of the captured SQL log.
 */
public final class PreviewSavepoint {
    /** A name no ORM generates; Hibernate and Spring use unnamed JDBC savepoints. */
    public static final String NAME = "sendproof_preview";

    private final Connection connection;

    private PreviewSavepoint(Connection connection) {
        this.connection = connection;
    }

    /** Makes the savepoint in the Preview transaction just opened on {@code connection}. */
    public static PreviewSavepoint open(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("SAVEPOINT " + NAME);
        }
        return new PreviewSavepoint(connection);
    }

    /**
     * Makes the savepoint again after handler code rolled the whole transaction back (which erases savepoints but lets
     * nothing escape), so the check at the end still holds.
     */
    public void reopen() throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("SAVEPOINT " + NAME);
        }
    }

    /**
     * Rolls back to the savepoint, proving the Preview transaction is still the one it opened.
     *
     * @throws IllegalStateException when the savepoint is gone (something committed the Preview transaction) or the
     *                               check couldn't run; either way the Preview must not be confirmed
     */
    public void verify() {
        try (Statement statement = connection.createStatement()) {
            statement.execute("ROLLBACK TO SAVEPOINT " + NAME);
        } catch (SQLException failure) {
            String reason = failure.getErrorCode() == 1305
                    ? "Something committed the Preview's MySQL transaction while the handler ran (its savepoint is gone), "
                    + "so its writes may have persisted and the Preview can't be confirmed."
                    : "Sendproof couldn't confirm the Preview's MySQL transaction was still open, so the Preview can't be "
                    + "confirmed.";
            throw new IllegalStateException(reason, failure);
        }
    }
}

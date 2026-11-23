package io.github.mprync.sendproof.jpa;

import io.github.mprync.sendproof.core.DatabaseSystem;
import io.github.mprync.sendproof.core.TransactionControl;
import io.github.mprync.sendproof.jdbc.SqlLogListener;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BooleanSupplier;
import net.ttddyy.dsproxy.ExecutionInfo;
import net.ttddyy.dsproxy.QueryInfo;

/**
 * Logs every JDBC command (see {@link SqlLogListener}) and, during a preview, refuses data-changing statements on a
 * connection that is not in a transaction, because such a statement would persist immediately and escape the rollback.
 * While the handler runs it also refuses statements that end or implicitly commit the transaction ({@code COMMIT},
 * {@code ROLLBACK}, DDL; on MySQL and MariaDB also {@code CALL} and the rest of the implicit-commit list; see
 * {@link TransactionControl}).
 */
final class SqlCaptureListener extends SqlLogListener {
    private static final Set<String> WRITES = Set.of("insert", "update", "delete", "merge", "truncate", "create",
            "alter", "drop");

    SqlCaptureListener(BooleanSupplier showValues) {
        super(showValues);
    }

    @Override
    public void beforeQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        if (!PreviewTransactionGuard.isActive()) {
            return;
        }
        boolean handling = PreviewTransactionGuard.isHandling();
        if (handling && PreviewTransactionGuard.isLost()) {
            throw PreviewTransactionGuard.refuseWhileHandling("A statement after the database rolled the Preview transaction back");
        }
        String system = handling ? system(execution) : null;
        boolean held = PinnedConnection.current() != null;
        Set<String> safeProcedures = PreviewTransactionGuard.safeProcedures();
        for (QueryInfo query : queries) {
            if (handling) {
                String control = held ? TransactionControl.findHeld(query.getQuery(), system, safeProcedures)
                        : TransactionControl.find(query.getQuery(), system, safeProcedures);
                if (control != null) {
                    throw PreviewTransactionGuard.refuseWhileHandling(
                            "The SQL statement " + control.toUpperCase(Locale.ROOT));
                }
            }
            if (isWrite(query.getQuery()) && autoCommit(execution)) {
                throw PreviewTransactionGuard.violation(new PreviewTransactionGuard.EnrollmentException(
                        "A data-changing statement ran outside a transaction during a Sendproof preview and would "
                                + "have persisted. The operation is not previewable."));
            }
        }
    }

    /**
     * Records a failed statement while the handler runs: a deadlock or lock wait timeout, or on SQL Server any error that
     * leaves {@code @@TRANCOUNT} at 0, means the database rolled the Preview transaction back
     * ({@link PreviewTransactionGuard#transactionLost()}).
     */
    @Override
    public void afterQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        super.afterQuery(execution, queries);
        if (execution.isSuccess() || !(execution.getThrowable() instanceof SQLException error)
                || !PreviewTransactionGuard.isHandling()) {
            return;
        }
        String system = system(execution);
        String state = error.getSQLState();
        boolean lostHeld = PinnedConnection.current() != null && state != null
                && (state.startsWith("08") || "h2".equals(system) && "40001".equals(state));
        if (lostHeld || TransactionControl.rollsBackTransaction(system, error)
                || (TransactionControl.isSqlServer(system) && sqlServerTransactionGone(execution))) {
            PreviewTransactionGuard.transactionLost();
        }
    }

    /** Asks SQL Server, on the pool's connection past the SQL capture, whether a transaction is still open. */
    private static boolean sqlServerTransactionGone(ExecutionInfo execution) {
        try {
            java.sql.Connection connection = execution.getStatement().getConnection();
            java.sql.Connection physical = connection instanceof net.ttddyy.dsproxy.proxy.ProxyJdbcObject proxy
                    && proxy.getTarget() instanceof java.sql.Connection target ? target : connection;
            try (Statement probe = physical.createStatement(); var rows = probe.executeQuery("SELECT @@TRANCOUNT")) {
                return !rows.next() || rows.getInt(1) == 0;
            }
        } catch (SQLException | RuntimeException unknown) {
            return true;
        }
    }

    private static boolean isWrite(String sql) {
        String trimmed = sql.stripLeading();
        int end = 0;
        while (end < trimmed.length() && Character.isLetter(trimmed.charAt(end))) {
            end++;
        }
        return WRITES.contains(trimmed.substring(0, end).toLowerCase(Locale.ROOT));
    }

    /**
     * The SQL provider id whose refusals apply: the preview's when known, otherwise the statement's own database, so a
     * provider built without one still gets the MySQL rules on MySQL.
     */
    private static String system(ExecutionInfo execution) {
        String known = PreviewTransactionGuard.system();
        if (known != null) {
            return known;
        }
        try {
            Statement statement = execution.getStatement();
            return statement == null ? null
                    : DatabaseSystem.of(statement.getConnection().getMetaData().getDatabaseProductName());
        } catch (SQLException | RuntimeException error) {
            return null;
        }
    }

    private static boolean autoCommit(ExecutionInfo execution) {
        try {
            Statement statement = execution.getStatement();
            return statement != null && statement.getConnection().getAutoCommit();
        } catch (SQLException | RuntimeException error) {
            return false;
        }
    }
}

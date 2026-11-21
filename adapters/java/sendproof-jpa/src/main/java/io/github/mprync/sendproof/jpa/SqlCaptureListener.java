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
        String system = handling ? system(execution) : null;
        for (QueryInfo query : queries) {
            String control = handling
                    ? TransactionControl.find(query.getQuery(), system, PreviewTransactionGuard.safeProcedures()) : null;
            if (control != null) {
                throw PreviewTransactionGuard.refuseWhileHandling("The SQL statement " + control.toUpperCase(Locale.ROOT));
            }
            if (isWrite(query.getQuery()) && autoCommit(execution)) {
                throw PreviewTransactionGuard.violation(new PreviewTransactionGuard.EnrollmentException(
                        "A data-changing statement ran outside a transaction during a Sendproof preview and would "
                                + "have persisted. The operation is not previewable."));
            }
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

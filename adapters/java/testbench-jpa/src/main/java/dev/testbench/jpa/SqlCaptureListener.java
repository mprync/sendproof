package dev.testbench.jpa;

import dev.testbench.jdbc.SqlLogListener;
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
        for (QueryInfo query : queries) {
            if (isWrite(query.getQuery()) && autoCommit(execution)) {
                throw PreviewTransactionGuard.violation(new PreviewTransactionGuard.EnrollmentException(
                        "A data-changing statement ran outside a transaction during a Test Bench preview and would "
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

    private static boolean autoCommit(ExecutionInfo execution) {
        try {
            Statement statement = execution.getStatement();
            return statement != null && statement.getConnection().getAutoCommit();
        } catch (SQLException | RuntimeException error) {
            return false;
        }
    }
}

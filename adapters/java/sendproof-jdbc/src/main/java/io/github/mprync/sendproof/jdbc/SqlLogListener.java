package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.SqlCapture;
import io.github.mprync.sendproof.core.SqlCapture.Binding;
import java.lang.reflect.Method;
import java.sql.JDBCType;
import java.sql.SQLType;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;
import net.ttddyy.dsproxy.ExecutionInfo;
import net.ttddyy.dsproxy.QueryInfo;
import net.ttddyy.dsproxy.listener.QueryExecutionListener;
import net.ttddyy.dsproxy.proxy.ParameterSetOperation;

/**
 * Records every JDBC command the current request issues, with duration, rows affected and bound values (redacted by
 * name). Subclasses can add behavior before a statement runs, for example to refuse it.
 */
public class SqlLogListener implements QueryExecutionListener {
    private final BooleanSupplier showValues;

    /** Creates a listener; {@code showValues} says whether non-secret bound values may be shown. */
    public SqlLogListener(BooleanSupplier showValues) {
        this.showValues = showValues;
    }

    @Override
    public void beforeQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        // Nothing by default.
    }

    @Override
    public void afterQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        RequestCapture capture = CaptureContext.current();
        if (capture == null || !capture.isActive()) {
            return;
        }
        for (QueryInfo query : queries) {
            var sets = query.getParametersList();
            int entries = Math.max(1, sets.size());
            double perEntryMs = (double) execution.getElapsedTime() / entries;
            for (int i = 0; i < entries; i++) {
                List<Binding> bindings = sets.isEmpty() ? List.of() : bindings(sets.get(i));
                Integer rows = rowsAffected(execution.getResult(), i, entries);
                capture.recordSql(perEntryMs, SqlCapture.CATEGORY,
                        () -> SqlCapture.snapshot(query.getQuery(), bindings, rows, showValues.getAsBoolean()));
            }
        }
    }

    private static Integer rowsAffected(Object result, int index, int entries) {
        if (result instanceof Integer count && entries == 1 && count >= 0) {
            return count;
        }
        if (result instanceof int[] counts && counts.length == entries && counts[index] >= 0) {
            return counts[index];
        }
        return null;
    }

    /** Converts one parameter set into positional bindings with JDBC type names. */
    protected static List<Binding> bindings(List<ParameterSetOperation> operations) {
        var byIndex = new TreeMap<Integer, Binding>();
        for (ParameterSetOperation operation : operations) {
            Object[] args = operation.getArgs();
            if (args.length == 0 || !(args[0] instanceof Integer index)) {
                continue;
            }
            Method method = operation.getMethod();
            if (method.getName().equals("setNull")) {
                byIndex.put(index, new Binding(null, args.length > 1 ? typeName(args[1]) : "NULL"));
            } else {
                Object value = args.length > 1 ? args[1] : null;
                byIndex.put(index, new Binding(value, dbType(method.getName(), value, args)));
            }
        }
        return new ArrayList<>(byIndex.values());
    }

    private static String dbType(String setter, Object value, Object[] args) {
        if (setter.equals("setObject") && args.length > 2) {
            return typeName(args[2]);
        }
        return switch (setter) {
            case "setString", "setNString" -> "VARCHAR";
            case "setInt" -> "INTEGER";
            case "setLong" -> "BIGINT";
            case "setShort" -> "SMALLINT";
            case "setByte" -> "TINYINT";
            case "setBoolean" -> "BOOLEAN";
            case "setDouble" -> "DOUBLE";
            case "setFloat" -> "REAL";
            case "setBigDecimal" -> "DECIMAL";
            case "setDate" -> "DATE";
            case "setTime" -> "TIME";
            case "setTimestamp" -> "TIMESTAMP";
            case "setBytes" -> "VARBINARY";
            default -> inferred(value);
        };
    }

    private static String inferred(Object value) {
        if (value instanceof CharSequence || value instanceof Character) {
            return "VARCHAR";
        }
        if (value instanceof Integer) {
            return "INTEGER";
        }
        if (value instanceof Long) {
            return "BIGINT";
        }
        if (value instanceof Boolean) {
            return "BOOLEAN";
        }
        if (value instanceof java.math.BigDecimal) {
            return "DECIMAL";
        }
        if (value instanceof Number) {
            return "DOUBLE";
        }
        if (value instanceof java.time.temporal.Temporal || value instanceof java.util.Date) {
            return "TIMESTAMP";
        }
        if (value instanceof byte[]) {
            return "VARBINARY";
        }
        return "OTHER";
    }

    private static String typeName(Object type) {
        if (type instanceof Integer code) {
            try {
                return JDBCType.valueOf(code).getName();
            } catch (IllegalArgumentException error) {
                return "OTHER";
            }
        }
        return type instanceof SQLType sqlType ? sqlType.getName() : "OTHER";
    }
}

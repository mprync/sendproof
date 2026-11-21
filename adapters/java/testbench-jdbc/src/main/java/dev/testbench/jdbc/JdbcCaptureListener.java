package dev.testbench.jdbc;

import dev.testbench.core.PreviewChange;
import dev.testbench.core.SqlCapture.Binding;
import dev.testbench.core.TransactionControl;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import net.ttddyy.dsproxy.ExecutionInfo;
import net.ttddyy.dsproxy.QueryInfo;

/**
 * Logs SQL and reports simple single-row writes as row changes. Because JDBC has no change events, it reads the row
 * before an {@code UPDATE} or {@code DELETE} runs, and again after an {@code UPDATE}, on the same connection; an
 * {@code INSERT}'s after-image is its bound values. Statements it does not understand (see {@link DmlStatement}),
 * batches and bulk predicates are logged as SQL but not reported as changes.
 */
final class JdbcCaptureListener extends SqlLogListener {
    private static final ThreadLocal<Boolean> READING = ThreadLocal.withInitial(() -> false);
    private static final ThreadLocal<Deque<Pending>> PENDING = ThreadLocal.withInitial(ArrayDeque::new);

    private final Map<String, List<String>> primaryKeys = new ConcurrentHashMap<>();

    JdbcCaptureListener(BooleanSupplier showValues) {
        super(showValues);
    }

    private record Pending(DmlStatement statement, List<Binding> bindings, List<Map<String, Object>> before) {
    }

    @Override
    public void beforeQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        super.beforeQuery(execution, queries);
        refuseTransactionControl(execution, queries);
        Deque<Pending> pending = PENDING.get();
        pending.push(new Pending(null, List.of(), List.of()));
        if (!tracking() || queries.size() != 1) {
            return;
        }
        QueryInfo query = queries.get(0);
        var sets = query.getParametersList();
        DmlStatement dml = sets.size() == 1 ? DmlStatement.parse(query.getQuery()) : null;
        if (dml == null) {
            return;
        }
        List<Binding> bindings = bindings(sets.get(0));
        List<Map<String, Object>> before = List.of();
        if (dml.kind() != DmlStatement.Kind.INSERT) {
            before = read(execution, dml.table(), dml.where(), bindings);
        }
        pending.pop();
        pending.push(new Pending(dml, bindings, before));
    }

    @Override
    public void afterQuery(ExecutionInfo execution, List<QueryInfo> queries) {
        super.afterQuery(execution, queries);
        Pending pending = PENDING.get().pop();
        if (pending.statement() == null || !execution.isSuccess() || !tracking()) {
            return;
        }
        DmlStatement dml = pending.statement();
        ChangeLog log = JdbcScope.current().changes();
        try {
            switch (dml.kind()) {
                case INSERT -> {
                    Map<String, Object> after = new LinkedHashMap<>();
                    for (DmlStatement.Term term : dml.columns()) {
                        after.put(name(term.column()), term.ordinal() < 0 ? null : value(pending.bindings(), term.ordinal()));
                    }
                    log.add(new PreviewChange("insert", dml.table(), key(execution, dml.table(), after), null, after), false);
                }
                case UPDATE -> {
                    for (Map<String, Object> before : pending.before()) {
                        Map<String, Object> key = key(execution, dml.table(), before);
                        List<Map<String, Object>> after = readByKey(execution, dml.table(), key);
                        log.add(new PreviewChange("update", dml.table(), key, before,
                                after.isEmpty() ? null : after.get(0)), false);
                    }
                }
                case DELETE -> {
                    for (Map<String, Object> before : pending.before()) {
                        log.add(new PreviewChange("delete", dml.table(), key(execution, dml.table(), before), before, null),
                                false);
                    }
                }
            }
        } catch (RuntimeException | SQLException error) {
            // Capture never interrupts the application; the statement still ran and is in the SQL log.
        }
    }

    /**
     * Refuses {@code COMMIT}, {@code ROLLBACK}, DDL and similar statements on a preview's connection: they would commit
     * or end the transaction the preview must roll back. Runs before anything is pushed for {@link #afterQuery}, which
     * is not called for a refused statement.
     */
    private static void refuseTransactionControl(ExecutionInfo execution, List<QueryInfo> queries) {
        JdbcPreviewSession session;
        try {
            Statement statement = execution.getStatement();
            session = statement == null ? null : JdbcPreviewSession.owning(statement.getConnection());
        } catch (SQLException | RuntimeException error) {
            return;
        }
        if (session == null) {
            return;
        }
        for (QueryInfo query : queries) {
            String keyword = TransactionControl.find(query.getQuery());
            if (keyword != null) {
                throw session.refuse("The SQL statement " + keyword.toUpperCase(Locale.ROOT));
            }
        }
    }

    private static boolean tracking() {
        return !READING.get() && JdbcScope.current() != null;
    }

    private static Object value(List<Binding> bindings, int ordinal) {
        return ordinal >= 1 && ordinal <= bindings.size() ? bindings.get(ordinal - 1).value() : null;
    }

    private List<Map<String, Object>> read(ExecutionInfo execution, String table, List<DmlStatement.Term> where,
                                           List<Binding> bindings) {
        if (!DmlStatement.isTable(table) || where.stream().anyMatch(term -> !DmlStatement.isIdentifier(term.column()))) {
            return List.of();
        }
        var sql = new StringBuilder("select * from ").append(table).append(" where ");
        var values = new ArrayList<Object>();
        for (int i = 0; i < where.size(); i++) {
            sql.append(i == 0 ? "" : " and ").append(where.get(i).column()).append(" = ?");
            values.add(value(bindings, where.get(i).ordinal()));
        }
        return select(execution, sql.toString(), values);
    }

    private List<Map<String, Object>> readByKey(ExecutionInfo execution, String table, Map<String, Object> key)
            throws SQLException {
        // Column names come from database metadata; anything that is not a plain identifier is not spliced into SQL.
        if (key.isEmpty() || !DmlStatement.isTable(table) || key.keySet().stream().anyMatch(name -> !DmlStatement.isIdentifier(name))) {
            return List.of();
        }
        var sql = new StringBuilder("select * from ").append(table).append(" where ");
        var values = new ArrayList<Object>();
        for (var entry : key.entrySet()) {
            sql.append(values.isEmpty() ? "" : " and ").append(entry.getKey()).append(" = ?");
            values.add(entry.getValue());
        }
        return select(execution, sql.toString(), values);
    }

    private List<Map<String, Object>> select(ExecutionInfo execution, String sql, List<Object> values) {
        READING.set(true);
        try {
            Connection connection = execution.getStatement().getConnection();
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                for (int i = 0; i < values.size(); i++) {
                    statement.setObject(i + 1, values.get(i));
                }
                try (ResultSet rows = statement.executeQuery()) {
                    return rows(rows);
                }
            }
        } catch (SQLException | RuntimeException error) {
            return List.of();
        } finally {
            READING.set(false);
        }
    }

    private static List<Map<String, Object>> rows(ResultSet rows) throws SQLException {
        ResultSetMetaData meta = rows.getMetaData();
        var result = new ArrayList<Map<String, Object>>();
        while (rows.next() && result.size() < 200) {
            var row = new LinkedHashMap<String, Object>();
            for (int i = 1; i <= meta.getColumnCount(); i++) {
                row.put(name(meta.getColumnLabel(i)), rows.getObject(i));
            }
            result.add(row);
        }
        return result;
    }

    /** The key of a row: its primary-key columns, or every column when the table declares none. */
    private Map<String, Object> key(ExecutionInfo execution, String table, Map<String, Object> row) {
        List<String> columns = primaryKeys.computeIfAbsent(table, name -> primaryKey(execution, name));
        var key = new LinkedHashMap<String, Object>();
        for (String column : columns) {
            if (row.containsKey(column)) {
                key.put(column, row.get(column));
            }
        }
        return key.isEmpty() ? new LinkedHashMap<>(row) : key;
    }

    private static List<String> primaryKey(ExecutionInfo execution, String table) {
        READING.set(true);
        try {
            Statement statement = execution.getStatement();
            DatabaseMetaData meta = statement.getConnection().getMetaData();
            String bare = table.contains(".") ? table.substring(table.lastIndexOf('.') + 1) : table;
            for (String candidate : new String[]{bare, bare.toUpperCase(Locale.ROOT), bare.toLowerCase(Locale.ROOT)}) {
                try (ResultSet keys = meta.getPrimaryKeys(null, null, candidate)) {
                    var ordered = new java.util.TreeMap<Short, String>();
                    while (keys.next()) {
                        ordered.put(keys.getShort("KEY_SEQ"), name(keys.getString("COLUMN_NAME")));
                    }
                    if (!ordered.isEmpty()) {
                        return List.copyOf(ordered.values());
                    }
                }
            }
        } catch (SQLException | RuntimeException error) {
            // Fall through: the whole row identifies the change.
        } finally {
            READING.set(false);
        }
        return List.of();
    }

    /** Lower-cases names that a database folded to upper case, so keys read like the SQL that wrote them. */
    private static String name(String column) {
        return column.equals(column.toUpperCase(Locale.ROOT)) ? column.toLowerCase(Locale.ROOT) : column;
    }
}

package io.github.mprync.sendproof.jdbc;

import io.github.mprync.sendproof.core.SqlParameterNames;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * A single-table {@code INSERT}, {@code UPDATE} or {@code DELETE} in the simple shapes Sendproof can report as row
 * changes: {@code insert into t (a, b) values (?, ?)}, {@code update t set a = ? where k = ?} and
 * {@code delete from t where k = ?}, where each {@code WHERE} term is {@code column = ?} joined by {@code AND}.
 * Anything else (expressions, subqueries, joins, bulk predicates) is not understood and is logged as SQL only.
 */
record DmlStatement(Kind kind, String table, List<Term> columns, List<Term> where) {

    /** The statement kind. */
    enum Kind { INSERT, UPDATE, DELETE }

    /**
     * A column bound to a placeholder.
     *
     * @param column  the column name as written
     * @param ordinal the 1-based placeholder position, or {@code -1} for a literal
     */
    record Term(String column, int ordinal) {
    }

    private static final Pattern TABLE = Pattern.compile("[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)?");
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_][A-Za-z0-9_$]*");

    /** Returns whether {@code name} is a plain, unquoted column identifier that is safe to place in SQL. */
    static boolean isIdentifier(String name) {
        return name != null && IDENTIFIER.matcher(name).matches();
    }

    /** Returns whether {@code name} is a plain, optionally schema-qualified table identifier. */
    static boolean isTable(String name) {
        return name != null && TABLE.matcher(name).matches();
    }

    /** Parses {@code sql}, returning {@code null} when it is not one of the supported shapes. */
    static DmlStatement parse(String sql) {
        List<String> t = SqlParameterNames.tokenize(sql);
        if (t.size() < 4) {
            return null;
        }
        DmlStatement statement = switch (t.get(0).toLowerCase(Locale.ROOT)) {
            case "insert" -> insert(t);
            case "update" -> update(t);
            case "delete" -> delete(t);
            default -> null;
        };
        // The change reader builds its own SELECT from these names, so only plain identifiers are accepted; a quoted
        // name with spaces or quote characters is logged as SQL only.
        if (statement == null || statement.columns().stream().anyMatch(term -> !isIdentifier(term.column()))
                || statement.where().stream().anyMatch(term -> !isIdentifier(term.column()))) {
            return null;
        }
        return statement;
    }

    private static DmlStatement insert(List<String> t) {
        // INSERT INTO table ( c1 , c2 ) VALUES ( ? , ? )
        if (!is(t, 1, "into") || !table(t, 2) || !t.get(3).equals("(")) {
            return null;
        }
        List<String> names = new ArrayList<>();
        int i = 4;
        while (i < t.size() && !t.get(i).equals(")")) {
            if (!t.get(i).equals(",")) {
                names.add(unquote(t.get(i)));
            }
            i++;
        }
        if (i + 2 >= t.size() || !is(t, i + 1, "values") || !t.get(i + 2).equals("(")) {
            return null;
        }
        List<Term> terms = new ArrayList<>();
        int ordinal = 0;
        int position = 0;
        for (int j = i + 3; j < t.size() && !t.get(j).equals(")"); j++) {
            String token = t.get(j);
            if (token.equals(",")) {
                continue;
            }
            if (position >= names.size()) {
                return null;
            }
            terms.add(new Term(names.get(position++), token.equals("?") ? ++ordinal : -1));
        }
        return position == names.size() ? new DmlStatement(Kind.INSERT, t.get(2), terms, List.of()) : null;
    }

    private static DmlStatement update(List<String> t) {
        // UPDATE table SET a = ? , b = ? WHERE k = ? AND j = ?
        if (!table(t, 1) || !is(t, 2, "set")) {
            return null;
        }
        List<Term> assignments = new ArrayList<>();
        int ordinal = 0;
        int i = 3;
        while (i + 2 < t.size() && t.get(i + 1).equals("=") && !is(t, i, "where")) {
            assignments.add(new Term(unquote(t.get(i)), t.get(i + 2).equals("?") ? ++ordinal : -1));
            i += 3;
            if (i < t.size() && t.get(i).equals(",")) {
                i++;
            }
        }
        if (assignments.isEmpty() || i >= t.size() || !is(t, i, "where")) {
            return null;
        }
        List<Term> where = where(t, i + 1, ordinal);
        return where == null ? null : new DmlStatement(Kind.UPDATE, t.get(1), assignments, where);
    }

    private static DmlStatement delete(List<String> t) {
        // DELETE FROM table WHERE k = ?
        if (!is(t, 1, "from") || !table(t, 2) || !is(t, 3, "where")) {
            return null;
        }
        List<Term> where = where(t, 4, 0);
        return where == null ? null : new DmlStatement(Kind.DELETE, t.get(2), List.of(), where);
    }

    private static List<Term> where(List<String> t, int start, int ordinal) {
        List<Term> terms = new ArrayList<>();
        int i = start;
        while (i + 2 < t.size() + 0 && t.get(i + 1).equals("=") && t.get(i + 2).equals("?")) {
            terms.add(new Term(unquote(t.get(i)), ++ordinal));
            i += 3;
            if (i < t.size() && is(t, i, "and")) {
                i++;
            } else {
                break;
            }
        }
        return i == t.size() && !terms.isEmpty() ? terms : null;
    }

    private static boolean is(List<String> t, int index, String word) {
        return index < t.size() && t.get(index).equalsIgnoreCase(word);
    }

    private static boolean table(List<String> t, int index) {
        return index < t.size() && TABLE.matcher(t.get(index)).matches();
    }

    private static String unquote(String name) {
        int dot = name.lastIndexOf('.');
        String bare = dot >= 0 && !name.startsWith("\"") ? name.substring(dot + 1) : name;
        return bare.length() >= 2 && (bare.startsWith("\"") || bare.startsWith("`")) ? bare.substring(1, bare.length() - 1)
                : bare;
    }
}

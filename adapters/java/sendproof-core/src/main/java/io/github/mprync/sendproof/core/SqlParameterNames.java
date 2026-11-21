package io.github.mprync.sendproof.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Infers a name for each positional {@code ?} placeholder in a SQL statement, because JDBC drivers do not report
 * parameter names. The name is the column the value is compared with or inserted into, or the alias it is selected
 * as; {@code p<n>} when nothing fits. Names let redaction hide {@code password_hash = ?} on its own and make logs
 * readable.
 */
public final class SqlParameterNames {
    private SqlParameterNames() {
    }

    /** Returns one name per placeholder, in order. */
    public static List<String> infer(String sql) {
        List<String> tokens = tokenize(sql);
        var names = new ArrayList<String>();
        int[] insertColumn = insertColumns(tokens);
        int ordinal = 0;
        for (int i = 0; i < tokens.size(); i++) {
            if (!tokens.get(i).equals("?")) {
                continue;
            }
            ordinal++;
            String name = compared(tokens, i);
            if (name == null) {
                name = inserted(tokens, i, insertColumn);
            }
            if (name == null) {
                name = alias(tokens, i);
            }
            names.add(name == null ? "p" + ordinal : name);
        }
        return names;
    }

    private static final List<String> COMPARISONS = Arrays.asList("=", "<>", "!=", "<", ">", "<=", ">=", "like", "ilike");

    private static String compared(List<String> t, int i) {
        // column op ?
        if (i >= 2 && COMPARISONS.contains(lower(t.get(i - 1))) && isIdentifier(t.get(i - 2))) {
            return column(t.get(i - 2));
        }
        // column NOT LIKE ?
        if (i >= 3 && lower(t.get(i - 1)).equals("like") && lower(t.get(i - 2)).equals("not") && isIdentifier(t.get(i - 3))) {
            return column(t.get(i - 3));
        }
        // ? op column
        if (i + 2 < t.size() && COMPARISONS.contains(lower(t.get(i + 1))) && isIdentifier(t.get(i + 2))) {
            return column(t.get(i + 2));
        }
        // column BETWEEN ? AND ?
        if (i >= 2 && lower(t.get(i - 1)).equals("between") && isIdentifier(t.get(i - 2))) {
            return column(t.get(i - 2));
        }
        if (i >= 4 && lower(t.get(i - 1)).equals("and") && lower(t.get(i - 3)).equals("between")
                && isIdentifier(t.get(i - 4)) && t.get(i - 2).equals("?")) {
            return column(t.get(i - 4));
        }
        // column IN ( ?, ?, ... )
        int depth = 0;
        for (int j = i - 1; j >= 0; j--) {
            String token = t.get(j);
            if (token.equals(")")) {
                depth++;
            } else if (token.equals("(")) {
                if (depth == 0) {
                    if (j >= 2 && lower(t.get(j - 1)).equals("in") && isIdentifier(t.get(j - 2))) {
                        return column(t.get(j - 2));
                    }
                    break;
                }
                depth--;
            }
        }
        return null;
    }

    /** Maps the first column list of {@code INSERT INTO t (a, b) VALUES (?, ?)}; null when not an insert. */
    private static int[] insertColumns(List<String> t) {
        if (t.size() < 4 || !lower(t.get(0)).equals("insert")) {
            return null;
        }
        // Layout: INSERT INTO table ( col, col ) VALUES ( ... )
        int open = t.indexOf("(");
        int close = t.indexOf(")");
        if (open < 0 || close < open) {
            return null;
        }
        return new int[]{open, close};
    }

    private static String inserted(List<String> t, int i, int[] columns) {
        if (columns == null) {
            return null;
        }
        List<String> names = new ArrayList<>();
        for (int j = columns[0] + 1; j < columns[1]; j++) {
            if (!t.get(j).equals(",")) {
                names.add(column(t.get(j)));
            }
        }
        int values = -1;
        for (int j = columns[1] + 1; j < t.size(); j++) {
            if (lower(t.get(j)).equals("values")) {
                values = j;
                break;
            }
        }
        if (values < 0 || i < values || names.isEmpty()) {
            return null;
        }
        int position = 0;
        int depth = 0;
        for (int j = values + 1; j < i; j++) {
            String token = t.get(j);
            if (token.equals("(")) {
                depth++;
                if (depth == 1) {
                    position = 0;
                }
            } else if (token.equals(")")) {
                depth--;
            } else if (token.equals(",") && depth == 1) {
                position++;
            }
        }
        boolean wholeElement = depth == 1 && previousIsSeparator(t, i) && nextIsSeparator(t, i);
        return wholeElement && position < names.size() ? names.get(position) : null;
    }

    private static boolean previousIsSeparator(List<String> t, int i) {
        return t.get(i - 1).equals("(") || t.get(i - 1).equals(",");
    }

    private static boolean nextIsSeparator(List<String> t, int i) {
        return i + 1 >= t.size() || t.get(i + 1).equals(")") || t.get(i + 1).equals(",");
    }

    /** {@code ? AS alias} or {@code CAST(? AS type) AS alias}. */
    private static String alias(List<String> t, int i) {
        int next = i + 1;
        if (next < t.size() && lower(t.get(next)).equals("as") && next + 1 < t.size()) {
            boolean cast = next >= 2 && lower(t.get(i - 1)).equals("(") && i >= 2 && lower(t.get(i - 2)).equals("cast");
            if (!cast) {
                return column(t.get(next + 1));
            }
            int depth = 1;
            int j = next + 1;
            while (j < t.size() && depth > 0) {
                if (t.get(j).equals("(")) {
                    depth++;
                } else if (t.get(j).equals(")")) {
                    depth--;
                }
                j++;
            }
            if (j + 1 < t.size() && lower(t.get(j)).equals("as")) {
                return column(t.get(j + 1));
            }
        }
        return null;
    }

    private static String lower(String token) {
        return token.toLowerCase(Locale.ROOT);
    }

    private static boolean isIdentifier(String token) {
        if (token.isEmpty()) {
            return false;
        }
        char first = token.charAt(0);
        if (first == '"' || first == '`' || first == '[') {
            return true;
        }
        if (!(Character.isLetter(first) || first == '_')) {
            return false;
        }
        return !List.of("and", "or", "not", "where", "set", "on", "when", "then", "else", "select", "from", "values",
                "null", "is", "in", "like", "between", "as").contains(lower(token));
    }

    private static String column(String token) {
        String value = token;
        int dot = value.lastIndexOf('.');
        if (dot >= 0 && !value.startsWith("\"")) {
            value = value.substring(dot + 1);
        }
        if (value.length() >= 2 && (value.startsWith("\"") || value.startsWith("`") || value.startsWith("["))) {
            value = value.substring(1, value.length() - 1);
        }
        return value;
    }

    /** Splits SQL into words, quoted names, operators and punctuation, skipping comments and string literals. */
    public static List<String> tokenize(String sql) {
        var tokens = new ArrayList<String>();
        int i = 0;
        while (i < sql.length()) {
            char c = sql.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
            } else if (sql.startsWith("--", i)) {
                int end = sql.indexOf('\n', i);
                i = end < 0 ? sql.length() : end + 1;
            } else if (sql.startsWith("/*", i)) {
                int end = sql.indexOf("*/", i + 2);
                i = end < 0 ? sql.length() : end + 2;
            } else if (c == '\'') {
                i++;
                while (i < sql.length()) {
                    if (sql.charAt(i) == '\'' && i + 1 < sql.length() && sql.charAt(i + 1) == '\'') {
                        i += 2;
                    } else if (sql.charAt(i) == '\'') {
                        i++;
                        break;
                    } else {
                        i++;
                    }
                }
                tokens.add("'");
            } else if (c == '"' || c == '`') {
                int end = sql.indexOf(c, i + 1);
                end = end < 0 ? sql.length() - 1 : end;
                tokens.add(sql.substring(i, end + 1));
                i = end + 1;
            } else if (Character.isLetterOrDigit(c) || c == '_' || c == '$' || c == '.') {
                int start = i;
                while (i < sql.length() && (Character.isLetterOrDigit(sql.charAt(i)) || sql.charAt(i) == '_'
                        || sql.charAt(i) == '$' || sql.charAt(i) == '.')) {
                    i++;
                }
                tokens.add(sql.substring(start, i));
            } else if ((c == '<' || c == '>' || c == '!') && i + 1 < sql.length()
                    && (sql.charAt(i + 1) == '=' || sql.charAt(i + 1) == '>')) {
                tokens.add(sql.substring(i, i + 2));
                i += 2;
            } else {
                tokens.add(String.valueOf(c));
                i++;
            }
        }
        return tokens;
    }
}

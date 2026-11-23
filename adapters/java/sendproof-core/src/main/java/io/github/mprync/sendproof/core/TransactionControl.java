package io.github.mprync.sendproof.core;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Recognises SQL that would end the current transaction, start a new one, or commit it implicitly. During a preview such
 * a statement would let the handler's writes escape the rollback, so data-layer integrations refuse it before it is sent
 * (fail closed). See spec/data-stores.md "Transaction-control statements from the handler".
 *
 * <p>Every database: {@code COMMIT}, {@code END}, {@code ABORT}, {@code BEGIN}, {@code START TRANSACTION},
 * {@code ROLLBACK} (but not {@code ROLLBACK TO SAVEPOINT}), {@code SET AUTOCOMMIT}, {@code SET IMPLICIT_TRANSACTIONS},
 * XA and two-phase commands, {@code LOCK TABLES}/{@code UNLOCK TABLES}, and DDL ({@code CREATE}, {@code ALTER},
 * {@code DROP}, {@code TRUNCATE}, {@code RENAME}, {@code GRANT}, {@code REVOKE}, {@code COMMENT}), which several
 * databases (H2, MySQL, Oracle) commit implicitly. Every statement of a multi-statement string is checked, with strings
 * read both with and without backslash escapes (PostgreSQL's {@code E''} strings) and a {@code $tag$} string read as one
 * literal.
 *
 * <p>MySQL and MariaDB ({@link #find(String, String, Set)}) add the rest of MySQL's implicit-commit list ({@code ANALYZE},
 * {@code OPTIMIZE}, {@code REPAIR}, {@code CHECK}, {@code FLUSH}, {@code RESET}, {@code LOAD}, {@code CACHE INDEX},
 * plugin, replication and account statements, {@code LOCK TABLE}), SQL-level {@code PREPARE}/{@code EXECUTE} (which can
 * run any of these from a string), and {@code CALL}, because a stored procedure can commit. A host may declare
 * procedures that never commit by exact name ({@link #safeProcedures(Collection)}). MySQL's own lexical rules are
 * applied so nothing can hide a statement from the check: the body of a {@code /*!...}{@code *}{@code /} executable
 * comment is SQL, {@code #} starts a comment, {@code --} starts one only before whitespace, and a string is read both
 * with and without backslash escapes ({@code NO_BACKSLASH_ESCAPES}), refusing if either reading finds a statement.
 */
public final class TransactionControl {
    private static final Set<String> ALWAYS = Set.of("commit", "end", "abort", "begin", "start", "xa", "unlock",
            "create", "alter", "drop", "truncate", "rename", "grant", "revoke", "comment");

    /**
     * Leading keywords that MySQL and MariaDB also refuse: the remaining statements MySQL lists under implicit commit
     * (https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html), and {@code PREPARE}/{@code EXECUTE}, which can run
     * a committing statement from a string. {@code START} (replication) and the DDL keywords are in {@link #ALWAYS}.
     */
    private static final Set<String> MYSQL = Set.of("lock", "analyze", "optimize", "repair", "check", "flush", "install",
            "uninstall", "load", "cache", "reset", "import", "change", "stop", "prepare", "execute");
    private static final Set<String> H2 = Set.of("set", "runscript", "shutdown", "call", "execute", "analyze");

    /** Stands for a doubled backtick inside a quoted identifier, which no declared procedure name can contain. */
    private static final char ESCAPED_BACKTICK = '\u0001';

    private TransactionControl() {
    }

    /**
     * Returns the leading keyword of the first statement in {@code sql} that controls or implicitly commits the
     * transaction, or {@code null} when there is none. Applies the rules every database shares; use
     * {@link #find(String, String, Set)} when the database is known.
     */
    public static String find(String sql) {
        return find(sql, null, Set.of());
    }

    /**
     * Returns the leading keyword of the first statement in {@code sql} that would end or escape the transaction on the
     * given database, or {@code null}. On MySQL and MariaDB this adds the implicit-commit list and {@code CALL} (see the
     * class description).
     *
     * @param system         the SQL provider id ({@code mysql}, {@code mariadb}, {@code postgresql} ...), or {@code null}
     * @param safeProcedures procedures the host declared never commit, from {@link #safeProcedures(Collection)}
     */
    public static String find(String sql, String system, Set<String> safeProcedures) {
        return find(sql, system, safeProcedures, false);
    }

    /** A held H2 transaction also refuses database settings and dynamic SQL that can implicitly commit. */
    public static String findHeld(String sql, String system, Set<String> safeProcedures) {
        return find(sql, system, safeProcedures, "h2".equals(system));
    }

    private static String find(String sql, String system, Set<String> safeProcedures, boolean h2Held) {
        if (sql == null) {
            return null;
        }
        boolean mysql = isMySql(system);
        for (boolean backslashEscapes : new boolean[] {true, false}) {
            for (List<String> statement : statements(SqlParameterNames.tokenize(text(sql, backslashEscapes, mysql)))) {
                String keyword = mysql ? checkMySql(statement, safeProcedures == null ? Set.of() : safeProcedures)
                        : check(statement, false);
                if (keyword == null && h2Held) {
                    List<String> tokens = jdbcCall(statement);
                    String first = tokens.isEmpty() ? "" : lower(tokens.get(0));
                    if (H2.contains(first) || (first.equals("prepare") && tokens.size() > 1
                            && lower(tokens.get(1)).equals("commit"))) {
                        keyword = first;
                    }
                }
                if (keyword != null) {
                    return keyword;
                }
            }
        }
        return null;
    }

    /**
     * Returns whether {@code error} means the database rolled the whole transaction back on its own: a MySQL or MariaDB
     * deadlock (1213) or lock wait timeout (1205; counted whether or not {@code innodb_rollback_on_timeout} is on, since
     * refusing can only fail a Preview), or a SQL Server deadlock victim (1205). Later statements would run outside the
     * Preview transaction, so the provider refuses them. A SQL Server error under {@code XACT_ABORT ON} also ends the
     * transaction; the provider checks {@code @@TRANCOUNT} for that ({@link #isSqlServer(String)}).
     */
    public static boolean rollsBackTransaction(String system, java.sql.SQLException error) {
        Throwable current = error;
        for (int depth = 0; current != null && depth < 16; depth++) {
            if (current instanceof java.sql.SQLException sql) {
                int code = sql.getErrorCode();
                if ((isMySql(system) && (code == 1213 || code == 1205)) || (isSqlServer(system) && code == 1205)) {
                    return true;
                }
                current = sql.getCause() != null ? sql.getCause() : sql.getNextException();
            } else {
                current = current.getCause();
            }
        }
        return false;
    }

    /** Returns whether {@code system} is SQL Server, where an error under {@code XACT_ABORT ON} ends the transaction. */
    public static boolean isSqlServer(String system) {
        return "mssql".equals(system);
    }

    /** Returns whether {@code system} is MySQL or MariaDB, which commit implicitly and run procedures with {@code CALL}. */
    public static boolean isMySql(String system) {
        return "mysql".equals(system) || "mariadb".equals(system);
    }

    /**
     * Normalises host-declared safe procedure names for {@link #find(String, String, Set)}: exact names only, optionally
     * schema-qualified ({@code reports.refresh_totals}), compared without backticks and case-insensitively as MySQL does.
     *
     * @throws IllegalArgumentException for a blank name, or one with a wildcard ({@code *}, {@code %}, {@code ?}),
     *                                  whitespace or a control character
     */
    public static Set<String> safeProcedures(Collection<String> names) {
        var normalised = new LinkedHashSet<String>();
        for (String name : names == null ? List.<String>of() : names) {
            String bare = name == null ? "" : name.replace("`", "").toLowerCase(Locale.ROOT);
            boolean invalid = bare.isEmpty();
            for (int i = 0; i < bare.length() && !invalid; i++) {
                char c = bare.charAt(i);
                invalid = c == '*' || c == '%' || c == '?' || c <= ' ' || Character.isWhitespace(c);
            }
            if (invalid) {
                throw new IllegalArgumentException("Safe procedures take exact names, without wildcards or spaces: '"
                        + name + "'.");
            }
            normalised.add(bare);
        }
        return Set.copyOf(normalised);
    }

    private static String checkMySql(List<String> tokens, Set<String> safeProcedures) {
        List<String> statement = jdbcCall(tokens);
        if (statement.isEmpty()) {
            return null;
        }
        String first = lower(statement.get(0));
        if (first.equals("call")) {
            return safeProcedures.contains(procedure(statement)) ? null : "call";
        }
        if (MYSQL.contains(first)) {
            return first;
        }
        return check(statement, true);
    }

    private static List<String> jdbcCall(List<String> statement) {
        // The JDBC call escape: {call p(?)} or {? = call p(?)}.
        if (!statement.isEmpty() && statement.get(0).equals("{")) {
            int start = statement.size() > 2 && statement.get(1).equals("?") && statement.get(2).equals("=") ? 3 : 1;
            return statement.subList(start, statement.size());
        }
        return statement;
    }

    /**
     * Whether the statement is {@code SAVEPOINT}, {@code RELEASE SAVEPOINT}, {@code ROLLBACK [WORK] TO [SAVEPOINT]} or SQL
     * Server's {@code SAVE TRANSACTION} / {@code ROLLBACK TRANSACTION} of the backstop's {@link PreviewSavepoint#NAME}, on
     * any database: releasing it or rolling back to it would let a later commit go unnoticed, and making it again would
     * bring it back after one.
     */
    private static boolean namesPreviewSavepoint(List<String> statement) {
        String first = lower(statement.get(0));
        if (!first.equals("savepoint") && !first.equals("release") && !first.equals("rollback") && !first.equals("save")) {
            return false;
        }
        // The name is the last token, quoted as `x`, "x" or [x].
        int end = statement.size() - 1;
        if (end > 0 && statement.get(end).equals("]")) {
            end--;
        }
        String last = lower(statement.get(end)).replace("`", "").replace("\"", "");
        return PreviewSavepoint.isReserved(last);
    }

    /** The procedure a {@code CALL} names, as {@link #safeProcedures(Collection)} normalises names. */
    private static String procedure(List<String> statement) {
        var name = new StringBuilder();
        for (int i = 1; i < statement.size() && !statement.get(i).equals("(") && !statement.get(i).equals("}"); i++) {
            name.append(statement.get(i));
        }
        return name.toString().replace("`", "").toLowerCase(Locale.ROOT);
    }

    private static String check(List<String> tokens, boolean mysql) {
        if (tokens.isEmpty()) {
            return null;
        }
        if (namesPreviewSavepoint(tokens)) {
            return "savepoint " + PreviewSavepoint.NAME;
        }
        String first = lower(tokens.get(0));
        String second = tokens.size() > 1 ? lower(tokens.get(1)) : "";
        if (ALWAYS.contains(first)) {
            return first;
        }
        if (first.equals("rollback")) {
            // ROLLBACK TO [SAVEPOINT] x stays inside the transaction; a bare ROLLBACK ends it.
            return second.equals("to") || (second.equals("work") && tokens.size() > 2 && lower(tokens.get(2)).equals("to"))
                    ? null : first;
        }
        if (first.equals("lock") && second.equals("tables")) {
            return "lock tables";
        }
        if (first.equals("prepare") && second.equals("transaction")) {
            return "prepare transaction";
        }
        if (first.equals("set")) {
            return setControl(tokens, mysql);
        }
        return null;
    }

    /**
     * Finds a transaction-ending setting anywhere in a {@code SET} statement, in every spelling: {@code autocommit},
     * {@code SESSION autocommit}, {@code @@session.autocommit}, or a later assignment in a list. A user variable
     * ({@code @autocommit}) is not a setting. On MySQL, {@code SET PASSWORD} commits implicitly.
     */
    private static String setControl(List<String> tokens, boolean mysql) {
        for (int i = 1; i < tokens.size(); i++) {
            String token = lower(tokens.get(i));
            String bare = token.substring(token.lastIndexOf('.') + 1);
            boolean userVariable = tokens.get(i - 1).equals("@") && !(i >= 2 && tokens.get(i - 2).equals("@"));
            // SQL Server's SET IMPLICIT_TRANSACTIONS OFF leaves an open transaction open (EF Core starts batches with it).
            boolean turnedOff = i + 1 < tokens.size() && lower(tokens.get(i + 1)).equals("off");
            if (!userVariable && (bare.equals("autocommit") || (bare.equals("implicit_transactions") && !turnedOff))) {
                return "set " + bare;
            }
            if (mysql && i == 1 && token.equals("password")) {
                return "set password";
            }
        }
        return null;
    }

    /**
     * Rewrites SQL text so {@link SqlParameterNames#tokenize} reads it as the server does: comments become spaces
     * (except a MySQL executable comment's body, which is kept), every string literal becomes {@code 's'}, a doubled
     * quote in a quoted identifier becomes {@link #ESCAPED_BACKTICK}, and a minus sign is followed by a space so two of
     * them never read as a comment. On MySQL {@code #} starts a comment, {@code --} starts one only before whitespace and
     * {@code "} quotes a string; elsewhere {@code "} quotes an identifier and a PostgreSQL {@code $tag$} string is one
     * literal.
     *
     * @param backslashEscapes whether a backslash escapes the next character in a string (MySQL's default, off under
     *                         {@code NO_BACKSLASH_ESCAPES}; PostgreSQL's {@code E''} strings)
     * @param mysql            whether to apply MySQL's comment and quoting rules
     */
    static String text(String sql, boolean backslashEscapes, boolean mysql) {
        var out = new StringBuilder(sql.length() + 16);
        int length = sql.length();
        boolean executable = false;
        int i = 0;
        while (i < length) {
            char c = sql.charAt(i);
            char next = i + 1 < length ? sql.charAt(i + 1) : '\0';
            if (executable && c == '*' && next == '/') {
                executable = false;
                i += 2;
                out.append(' ');
            } else if (c == '/' && next == '*') {
                int body = i + 2;
                boolean mysqlOnly = body < length && sql.charAt(body) == '!';
                boolean mariadbOnly = body + 1 < length && sql.charAt(body) == 'M' && sql.charAt(body + 1) == '!';
                if (mysql && !executable && (mysqlOnly || mariadbOnly)) {
                    // /*!50001 ... */ and /*M!100100 ... */ run on the server: keep the body, whatever the version.
                    body += mysqlOnly ? 1 : 2;
                    while (body < length && Character.isDigit(sql.charAt(body))) {
                        body++;
                    }
                    executable = true;
                    i = body;
                } else {
                    int end = sql.indexOf("*/", i + 2);
                    i = end < 0 ? length : end + 2;
                }
                out.append(' ');
            } else if ((mysql && c == '#')
                    || (c == '-' && next == '-' && (!mysql || i + 2 >= length || sql.charAt(i + 2) <= ' '))) {
                int end = sql.indexOf('\n', i);
                end = end < 0 ? length : end;
                if (executable) {
                    // Assume the comment stops at the executable comment's end, so text after it is still checked.
                    int close = sql.indexOf("*/", i);
                    end = close >= 0 && close < end ? close : end;
                }
                i = end;
                out.append(' ');
            } else if (c == '-') {
                out.append("- ");
                i++;
            } else if (c == '\'' || (mysql && c == '"')) {
                i = afterString(sql, i, c, backslashEscapes);
                out.append(" 's' ");
            } else if (c == '`' || c == '"') {
                // A quoted identifier: no backslash escapes, a doubled quote is an escaped quote.
                int end = i + 1;
                var identifier = new StringBuilder().append(c);
                while (end < length) {
                    if (sql.charAt(end) == c && end + 1 < length && sql.charAt(end + 1) == c) {
                        identifier.append(ESCAPED_BACKTICK);
                        end += 2;
                    } else if (sql.charAt(end) == c) {
                        end++;
                        break;
                    } else {
                        identifier.append(sql.charAt(end++));
                    }
                }
                out.append(identifier).append(c);
                i = end;
            } else if (!mysql && c == '$' && dollarTag(sql, i) != null) {
                String tag = dollarTag(sql, i);
                int close = sql.indexOf(tag, i + tag.length());
                i = close < 0 ? length : close + tag.length();
                out.append(" 's' ");
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    /**
     * Returns the PostgreSQL dollar-quote tag ({@code $$} or {@code $name$}) opening at {@code start}, or {@code null}
     * when there is none there (a {@code $} inside an identifier, or a positional parameter such as {@code $1}).
     */
    private static String dollarTag(String sql, int start) {
        if (start > 0) {
            char before = sql.charAt(start - 1);
            if (Character.isLetterOrDigit(before) || before == '_' || before == '$') {
                return null;
            }
        }
        int i = start + 1;
        while (i < sql.length() && (Character.isLetter(sql.charAt(i)) || sql.charAt(i) == '_')) {
            i++;
        }
        return i < sql.length() && sql.charAt(i) == '$' ? sql.substring(start, i + 1) : null;
    }

    /** Returns the index after the string literal opened at {@code start}, or the end of the text if it never closes. */
    private static int afterString(String sql, int start, char quote, boolean backslashEscapes) {
        int i = start + 1;
        while (i < sql.length()) {
            char c = sql.charAt(i);
            if (backslashEscapes && c == '\\') {
                i += 2;
            } else if (c == quote && i + 1 < sql.length() && sql.charAt(i + 1) == quote) {
                i += 2;
            } else if (c == quote) {
                return i + 1;
            } else {
                i++;
            }
        }
        return sql.length();
    }

    private static List<List<String>> statements(List<String> tokens) {
        var statements = new ArrayList<List<String>>();
        var current = new ArrayList<String>();
        for (String token : tokens) {
            if (token.equals(";")) {
                statements.add(current);
                current = new ArrayList<>();
            } else if (!(current.isEmpty() && token.equals("("))) {
                current.add(token);
            }
        }
        statements.add(current);
        return statements;
    }

    private static String lower(String token) {
        return token.toLowerCase(Locale.ROOT);
    }
}

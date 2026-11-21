package dev.testbench.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Recognises SQL that would end the current transaction, start a new one, or commit it implicitly. During a preview such
 * a statement would let the handler's writes escape the rollback, so data-layer integrations refuse it (fail closed).
 *
 * <p>Covered: {@code COMMIT}, {@code END}, {@code BEGIN}, {@code START TRANSACTION}, {@code ROLLBACK} (but not
 * {@code ROLLBACK TO SAVEPOINT}), {@code SET AUTOCOMMIT}, {@code SET IMPLICIT_TRANSACTIONS}, XA and two-phase commands,
 * MySQL {@code LOCK TABLES}/{@code UNLOCK TABLES}, and DDL ({@code CREATE}, {@code ALTER}, {@code DROP},
 * {@code TRUNCATE}, {@code RENAME}, {@code GRANT}, {@code REVOKE}, {@code COMMENT}), which several databases (H2,
 * MySQL, Oracle) commit implicitly. Every statement of a multi-statement string is checked. Stored procedures are not
 * inspected.
 */
public final class TransactionControl {
    private static final Set<String> ALWAYS = Set.of("commit", "end", "begin", "start", "xa", "unlock", "create",
            "alter", "drop", "truncate", "rename", "grant", "revoke", "comment");

    private TransactionControl() {
    }

    /**
     * Returns the leading keyword of the first statement in {@code sql} that controls or implicitly commits the
     * transaction, or {@code null} when there is none.
     */
    public static String find(String sql) {
        if (sql == null) {
            return null;
        }
        for (List<String> statement : statements(SqlParameterNames.tokenize(sql))) {
            String keyword = check(statement);
            if (keyword != null) {
                return keyword;
            }
        }
        return null;
    }

    private static String check(List<String> tokens) {
        if (tokens.isEmpty()) {
            return null;
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
            for (int i = 1; i < Math.min(tokens.size(), 5); i++) {
                String token = lower(tokens.get(i));
                if (token.equals("autocommit") || token.equals("@@autocommit") || token.equals("implicit_transactions")) {
                    return "set " + token;
                }
            }
        }
        return null;
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

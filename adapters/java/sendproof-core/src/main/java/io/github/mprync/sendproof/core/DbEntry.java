package io.github.mprync.sendproof.core;

/**
 * One command sent to a non-SQL store, as a {@code Db} log entry. Fields follow the OpenTelemetry database conventions
 * (see {@code spec/data-stores.md}). A {@code statement} never carries a value.
 *
 * @param system       the store id: {@code mongodb}, {@code redis} or {@code dynamodb}
 * @param operation    the command or action name
 * @param target       the collection, table or first key, or {@code null}
 * @param namespace    the MongoDB database or Redis database number, or {@code null}
 * @param statement    the sanitized command text, or {@code null}
 * @param rowsAffected documents or items matched, modified or returned, or {@code null}
 * @param blocked      whether the guard refused the command
 * @param error        the store's error name, or {@code null}
 * @param elapsedMs    how long the command took, or {@code null}
 */
public record DbEntry(String system, String operation, String target, String namespace, String statement,
                      Integer rowsAffected, boolean blocked, String error, Double elapsedMs) {

    /** Starts an entry for one command. */
    public static DbEntry of(String system, String operation) {
        return new DbEntry(system, operation, null, null, null, null, false, null, null);
    }

    /** The entry the guard logs for a refused command. */
    public static DbEntry blocked(String system, String operation) {
        return new DbEntry(system, operation, null, null, null, null, true, null, null);
    }

    /** Returns a copy with the target (collection, table or first key). */
    public DbEntry withTarget(String value) {
        return new DbEntry(system, operation, value, namespace, statement, rowsAffected, blocked, error, elapsedMs);
    }

    /** Returns a copy with the namespace (database). */
    public DbEntry withNamespace(String value) {
        return new DbEntry(system, operation, target, value, statement, rowsAffected, blocked, error, elapsedMs);
    }

    /** Returns a copy with the sanitized statement. */
    public DbEntry withStatement(String value) {
        return new DbEntry(system, operation, target, namespace, value, rowsAffected, blocked, error, elapsedMs);
    }

    /** Returns a copy with the row count. */
    public DbEntry withRows(Integer value) {
        return new DbEntry(system, operation, target, namespace, statement, value, blocked, error, elapsedMs);
    }

    /** Returns a copy with the error name. */
    public DbEntry withError(String value) {
        return new DbEntry(system, operation, target, namespace, statement, rowsAffected, blocked, value, elapsedMs);
    }

    /** Returns a copy with the elapsed time in milliseconds. */
    public DbEntry withElapsed(double value) {
        return new DbEntry(system, operation, target, namespace, statement, rowsAffected, blocked, error, value);
    }
}

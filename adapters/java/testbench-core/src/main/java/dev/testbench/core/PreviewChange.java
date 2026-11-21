package dev.testbench.core;

/**
 * One captured row change, expressed with JSON-serializable keys and values.
 *
 * @param operation the kind of change: {@code insert}, {@code update} or {@code delete}
 * @param table     the affected table
 * @param key       the changed row's key or composite key
 * @param before    the previous row values, or {@code null} for an insert
 * @param after     the new row values, or {@code null} for a delete
 */
public record PreviewChange(String operation, String table, Object key, Object before, Object after) {
}

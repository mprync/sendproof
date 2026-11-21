package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One captured change, expressed with JSON-serializable keys and values. A row of the SQL database, or (with
 * {@code store} set) a document, item or key of a data store.
 *
 * @param operation the kind of change: {@code insert}, {@code update} or {@code delete}
 * @param table     the affected table, or the MongoDB collection, DynamoDB table or Redis key prefix
 * @param key       the changed row's key or composite key; {@code {"_id": ...}} for MongoDB
 * @param before    the previous values, or {@code null} for an insert
 * @param after     the new values, or {@code null} for a delete
 * @param store     the store id such as {@code mongodb}; {@code null} for the SQL database
 * @param namespace the data store's database, or {@code null}
 * @param via       {@code upsert} or {@code replace} when the operation alone hides how the change was made, or {@code null}
 */
public record PreviewChange(String operation, String table, Object key, Object before, Object after,
                            @JsonInclude(JsonInclude.Include.NON_NULL) String store,
                            @JsonInclude(JsonInclude.Include.NON_NULL) String namespace,
                            @JsonInclude(JsonInclude.Include.NON_NULL) String via) {

    /** Creates a change to a row of the SQL database. */
    public PreviewChange(String operation, String table, Object key, Object before, Object after) {
        this(operation, table, key, before, after, null, null, null);
    }
}

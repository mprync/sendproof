package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * A non-SQL data store the binding has hooked: MongoDB, Redis or DynamoDB. A store reports itself in discovery and, if
 * it can roll back, takes part in each Preview through a {@link DataStoreSession}.
 *
 * <p>The hook itself (a guarded handle, an interceptor, a connection decorator) calls
 * {@link io.github.mprync.sendproof.core.stores.StoreGuard#guard} before it sends a command. A store that only guards
 * returns {@code null} from {@link #begin} and has nothing else to do.
 */
public interface DataStore {

    /** The store id: {@code mongodb}, {@code redis} or {@code dynamodb}. */
    String system();

    /**
     * Describes the store for capabilities {@code dataStores}. It may contact the server once to detect its mode (MongoDB
     * asks {@code hello}); a failure must answer {@code guard} mode rather than throw.
     */
    Description describe();

    /**
     * Prepares one Preview. Called after the SQL provider's transaction began and before the handler runs, on the
     * request thread, with the Preview's capture already current.
     *
     * @return the Preview's session for this store, or {@code null} when the store only guards
     * @throws Exception when the store cannot join the Preview; the Preview is then not confirmed
     */
    default DataStoreSession begin(RequestCapture capture) throws Exception {
        return null;
    }

    /** Guard stores need no held transaction. A rollback-capable store must explicitly support it. */
    default boolean supportsHeldStore() {
        return !"preview".equals(describe().mode());
    }

    /** Returns the held transaction, or null for a guard-only store. */
    default HeldPreview beginHeldStore() throws Exception {
        if ("preview".equals(describe().mode())) {
            throw new UnsupportedOperationException("This store cannot hold transactions.");
        }
        return null;
    }

    /**
     * How a store appears in capabilities.
     *
     * @param system the store id
     * @param name   a host-chosen display label, or {@code null}; never a connection string, host, user or password
     * @param mode   {@code preview} (writes roll back) or {@code guard} (the first write blocks the Preview)
     * @param reason why a store runs in {@code guard} mode when it could have run in {@code preview}, or {@code null}
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Description(String system, String name, String mode, String reason) {
    }
}

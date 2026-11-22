package io.github.mprync.sendproof.cosmosdb;

import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.CosmosDatabase;
import com.azure.cosmos.CosmosScripts;
import com.azure.cosmos.CosmosStoredProcedure;
import com.azure.cosmos.models.CosmosBatch;
import com.azure.cosmos.models.CosmosBatchRequestOptions;
import com.azure.cosmos.models.CosmosBatchResponse;
import com.azure.cosmos.models.CosmosBulkExecutionOptions;
import com.azure.cosmos.models.CosmosBulkOperationResponse;
import com.azure.cosmos.models.CosmosChangeFeedRequestOptions;
import com.azure.cosmos.models.CosmosContainerProperties;
import com.azure.cosmos.models.CosmosContainerRequestOptions;
import com.azure.cosmos.models.CosmosContainerResponse;
import com.azure.cosmos.models.CosmosItemIdentity;
import com.azure.cosmos.models.CosmosItemOperation;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosPatchItemRequestOptions;
import com.azure.cosmos.models.CosmosPatchOperations;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.CosmosReadManyRequestOptions;
import com.azure.cosmos.models.CosmosStoredProcedureProperties;
import com.azure.cosmos.models.CosmosStoredProcedureRequestOptions;
import com.azure.cosmos.models.CosmosStoredProcedureResponse;
import com.azure.cosmos.models.FeedRange;
import com.azure.cosmos.models.FeedResponse;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlQuerySpec;
import com.azure.cosmos.models.ThroughputProperties;
import com.azure.cosmos.models.ThroughputResponse;
import com.azure.cosmos.util.CosmosPagedIterable;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import java.util.List;
import java.util.function.Supplier;

/**
 * Guarded handles over the synchronous {@code azure-cosmos} client, made by {@link CosmosStore#client}. Each handle checks
 * the operation with the store before it calls the SDK, so a write during a Preview is refused and nothing is sent. A
 * handle that returns another handle ({@code getDatabase}, {@code getContainer}, {@code getScripts},
 * {@code getStoredProcedure}) returns a guarded one.
 */
public final class GuardedCosmos {
    private GuardedCosmos() {
    }

    /** Runs {@code send} after the guard; the entry is completed with how it ended. */
    private static <T> T run(CosmosStore store, String operation, boolean triggers, String database, String container,
                             String statement, Supplier<T> send) {
        Observation call = store.guard(operation, triggers, database, container, statement);
        try {
            T result = send.get();
            call.complete(null, null);
            return result;
        } catch (RuntimeException failure) {
            call.complete(null, failure);
            throw failure;
        }
    }

    /** A guarded client. */
    public static final class Client {
        private final CosmosStore store;
        private final CosmosClient raw;

        Client(CosmosStore store, CosmosClient raw) {
            this.store = store;
            this.raw = raw;
        }

        /** A guarded handle on a database. */
        public Database getDatabase(String id) {
            return new Database(store, raw.getDatabase(id));
        }

        /** Closes the underlying client. */
        public void close() {
            raw.close();
        }
    }

    /** A guarded database. */
    public static final class Database {
        private final CosmosStore store;
        private final CosmosDatabase raw;

        Database(CosmosStore store, CosmosDatabase raw) {
            this.store = store;
            this.raw = raw;
        }

        /** The database id. */
        public String getId() {
            return raw.getId();
        }

        /** A guarded handle on a container. */
        public Container getContainer(String id) {
            return new Container(store, raw.getId(), raw.getContainer(id));
        }
    }

    /** A guarded container: reads run, writes are refused during a Preview. */
    public static final class Container {
        private final CosmosStore store;
        private final String database;
        private final CosmosContainer raw;

        Container(CosmosStore store, String database, CosmosContainer raw) {
            this.store = store;
            this.database = database;
            this.raw = raw;
        }

        private <T> T run(String operation, boolean triggers, String statement, Supplier<T> send) {
            return GuardedCosmos.run(store, operation, triggers, database, raw.getId(), statement, send);
        }

        /** The container id. */
        public String getId() {
            return raw.getId();
        }

        // ---- Reads ----

        /** Reads the container's properties. */
        public CosmosContainerResponse read() {
            return run("Read", false, null, raw::read);
        }

        /** Reads the container's properties. */
        public CosmosContainerResponse read(CosmosContainerRequestOptions options) {
            return run("Read", false, null, () -> raw.read(options));
        }

        /** Reads one item; a trigger named in {@code options} makes it a write. */
        public <T> CosmosItemResponse<T> readItem(String id, PartitionKey key, Class<T> type) {
            return run("Read", false, null, () -> raw.readItem(id, key, type));
        }

        /** Reads one item; a trigger named in {@code options} makes it a write. */
        public <T> CosmosItemResponse<T> readItem(String id, PartitionKey key, CosmosItemRequestOptions options, Class<T> type) {
            return run("Read", CosmosStore.triggers(options), null, () -> raw.readItem(id, key, options, type));
        }

        /** Reads every item of a partition. */
        public <T> CosmosPagedIterable<T> readAllItems(PartitionKey key, Class<T> type) {
            return run("ReadFeed", false, null, () -> raw.readAllItems(key, type));
        }

        /** Reads every item of a partition. */
        public <T> CosmosPagedIterable<T> readAllItems(PartitionKey key, CosmosQueryRequestOptions options, Class<T> type) {
            return run("ReadFeed", false, null, () -> raw.readAllItems(key, options, type));
        }

        /** Runs a query. */
        public <T> CosmosPagedIterable<T> queryItems(String query, CosmosQueryRequestOptions options, Class<T> type) {
            return run("Query", false, query, () -> raw.queryItems(query, options, type));
        }

        /** Runs a query. */
        public <T> CosmosPagedIterable<T> queryItems(SqlQuerySpec query, CosmosQueryRequestOptions options, Class<T> type) {
            return run("Query", false, CosmosStore.text(query), () -> raw.queryItems(query, options, type));
        }

        /** Reads the change feed. */
        public <T> CosmosPagedIterable<T> queryChangeFeed(CosmosChangeFeedRequestOptions options, Class<T> type) {
            return run("ReadFeed", false, null, () -> raw.queryChangeFeed(options, type));
        }

        /** Reads several items by id and partition key. */
        public <T> FeedResponse<T> readMany(List<CosmosItemIdentity> identities, Class<T> type) {
            return run("Query", false, null, () -> raw.readMany(identities, type));
        }

        /** Reads several items by id and partition key. */
        public <T> FeedResponse<T> readMany(List<CosmosItemIdentity> identities, CosmosReadManyRequestOptions options, Class<T> type) {
            return run("Query", false, null, () -> raw.readMany(identities, options, type));
        }

        /** Reads the container's throughput. */
        public ThroughputResponse readThroughput() {
            return run("Read", false, null, raw::readThroughput);
        }

        /** The container's feed ranges. */
        public List<FeedRange> getFeedRanges() {
            return run("ReadFeed", false, null, raw::getFeedRanges);
        }

        /** Guarded stored procedure access. */
        public Scripts getScripts() {
            return new Scripts(store, database, raw.getId(), raw.getScripts());
        }

        // ---- Writes ----

        /** Creates an item. */
        public <T> CosmosItemResponse<T> createItem(T item) {
            return run("Create", false, null, () -> raw.createItem(item));
        }

        /** Creates an item. */
        public <T> CosmosItemResponse<T> createItem(T item, CosmosItemRequestOptions options) {
            return run("Create", CosmosStore.triggers(options), null, () -> raw.createItem(item, options));
        }

        /** Creates an item. */
        public <T> CosmosItemResponse<T> createItem(T item, PartitionKey key, CosmosItemRequestOptions options) {
            return run("Create", CosmosStore.triggers(options), null, () -> raw.createItem(item, key, options));
        }

        /** Creates or replaces an item. */
        public <T> CosmosItemResponse<T> upsertItem(T item) {
            return run("Upsert", false, null, () -> raw.upsertItem(item));
        }

        /** Creates or replaces an item. */
        public <T> CosmosItemResponse<T> upsertItem(T item, CosmosItemRequestOptions options) {
            return run("Upsert", CosmosStore.triggers(options), null, () -> raw.upsertItem(item, options));
        }

        /** Creates or replaces an item. */
        public <T> CosmosItemResponse<T> upsertItem(T item, PartitionKey key, CosmosItemRequestOptions options) {
            return run("Upsert", CosmosStore.triggers(options), null, () -> raw.upsertItem(item, key, options));
        }

        /** Replaces an item. */
        public <T> CosmosItemResponse<T> replaceItem(T item, String id, PartitionKey key, CosmosItemRequestOptions options) {
            return run("Replace", CosmosStore.triggers(options), null, () -> raw.replaceItem(item, id, key, options));
        }

        /** Patches an item, including a patch whose filter predicate fails. */
        public <T> CosmosItemResponse<T> patchItem(String id, PartitionKey key, CosmosPatchOperations operations, Class<T> type) {
            return run("Patch", false, null, () -> raw.patchItem(id, key, operations, type));
        }

        /** Patches an item, including a patch whose filter predicate fails. */
        public <T> CosmosItemResponse<T> patchItem(String id, PartitionKey key, CosmosPatchOperations operations,
                                                   CosmosPatchItemRequestOptions options, Class<T> type) {
            return run("Patch", CosmosStore.triggers(options), null, () -> raw.patchItem(id, key, operations, options, type));
        }

        /** Deletes an item. */
        public CosmosItemResponse<Object> deleteItem(String id, PartitionKey key, CosmosItemRequestOptions options) {
            return run("Delete", CosmosStore.triggers(options), null, () -> raw.deleteItem(id, key, options));
        }

        /** Deletes an item. */
        public <T> CosmosItemResponse<Object> deleteItem(T item, CosmosItemRequestOptions options) {
            return run("Delete", CosmosStore.triggers(options), null, () -> raw.deleteItem(item, options));
        }

        /** Deletes every item of a partition. */
        public CosmosItemResponse<Object> deleteAllItemsByPartitionKey(PartitionKey key, CosmosItemRequestOptions options) {
            return run("Delete", CosmosStore.triggers(options), null, () -> raw.deleteAllItemsByPartitionKey(key, options));
        }

        /** Runs a transactional batch: a write even when every operation in it reads. */
        public CosmosBatchResponse executeCosmosBatch(CosmosBatch batch) {
            return run("Batch", false, null, () -> raw.executeCosmosBatch(batch));
        }

        /** Runs a transactional batch: a write even when every operation in it reads. */
        public CosmosBatchResponse executeCosmosBatch(CosmosBatch batch, CosmosBatchRequestOptions options) {
            return run("Batch", false, null, () -> raw.executeCosmosBatch(batch, options));
        }

        /** Runs bulk operations, which the SDK sends as non-atomic batches. */
        public <C> Iterable<CosmosBulkOperationResponse<C>> executeBulkOperations(Iterable<CosmosItemOperation> operations) {
            return run("Batch", false, null, () -> raw.executeBulkOperations(operations));
        }

        /** Runs bulk operations, which the SDK sends as non-atomic batches. */
        public <C> Iterable<CosmosBulkOperationResponse<C>> executeBulkOperations(Iterable<CosmosItemOperation> operations,
                                                                                  CosmosBulkExecutionOptions options) {
            return run("Batch", false, null, () -> raw.executeBulkOperations(operations, options));
        }

        /** Replaces the container's properties. */
        public CosmosContainerResponse replace(CosmosContainerProperties properties) {
            return run("Replace", false, null, () -> raw.replace(properties));
        }

        /** Deletes the container. */
        public CosmosContainerResponse delete() {
            return run("Delete", false, null, raw::delete);
        }

        /** Replaces the container's throughput. */
        public ThroughputResponse replaceThroughput(ThroughputProperties properties) {
            return run("Replace", false, null, () -> raw.replaceThroughput(properties));
        }
    }

    /** Guarded stored procedure access. */
    public static final class Scripts {
        private final CosmosStore store;
        private final String database;
        private final String container;
        private final CosmosScripts raw;

        Scripts(CosmosStore store, String database, String container, CosmosScripts raw) {
            this.store = store;
            this.database = database;
            this.container = container;
            this.raw = raw;
        }

        /** Lists the stored procedures. */
        public CosmosPagedIterable<CosmosStoredProcedureProperties> readAllStoredProcedures() {
            return GuardedCosmos.run(store, "ReadFeed", false, database, container, null, raw::readAllStoredProcedures);
        }

        /** Creates a stored procedure. */
        public CosmosStoredProcedureResponse createStoredProcedure(CosmosStoredProcedureProperties properties) {
            return GuardedCosmos.run(store, "Create", false, database, container, null, () -> raw.createStoredProcedure(properties));
        }

        /** A guarded handle on a stored procedure. */
        public StoredProcedure getStoredProcedure(String id) {
            return new StoredProcedure(store, database, container, raw.getStoredProcedure(id));
        }
    }

    /** A guarded stored procedure: running one is a write, even one that only reads. */
    public static final class StoredProcedure {
        private final CosmosStore store;
        private final String database;
        private final String container;
        private final CosmosStoredProcedure raw;

        StoredProcedure(CosmosStore store, String database, String container, CosmosStoredProcedure raw) {
            this.store = store;
            this.database = database;
            this.container = container;
            this.raw = raw;
        }

        /** Reads the procedure's definition. */
        public CosmosStoredProcedureResponse read() {
            return GuardedCosmos.run(store, "Read", false, database, container, null, raw::read);
        }

        /** Runs the procedure; the guard can't see its code, so this is always a write. */
        public CosmosStoredProcedureResponse execute(List<Object> arguments, CosmosStoredProcedureRequestOptions options) {
            return GuardedCosmos.run(store, "ExecuteJavaScript", false, database, container, null, () -> raw.execute(arguments, options));
        }

        /** Replaces the procedure. */
        public CosmosStoredProcedureResponse replace(CosmosStoredProcedureProperties properties) {
            return GuardedCosmos.run(store, "Replace", false, database, container, null, () -> raw.replace(properties));
        }

        /** Deletes the procedure. */
        public CosmosStoredProcedureResponse delete() {
            return GuardedCosmos.run(store, "Delete", false, database, container, null, raw::delete);
        }
    }
}

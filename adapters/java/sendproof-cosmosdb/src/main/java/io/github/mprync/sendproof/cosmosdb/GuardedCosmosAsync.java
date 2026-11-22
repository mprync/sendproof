package io.github.mprync.sendproof.cosmosdb;

import com.azure.cosmos.CosmosAsyncClient;
import com.azure.cosmos.CosmosAsyncContainer;
import com.azure.cosmos.CosmosAsyncDatabase;
import com.azure.cosmos.CosmosAsyncScripts;
import com.azure.cosmos.CosmosAsyncStoredProcedure;
import com.azure.cosmos.models.CosmosBatch;
import com.azure.cosmos.models.CosmosBatchRequestOptions;
import com.azure.cosmos.models.CosmosBatchResponse;
import com.azure.cosmos.models.CosmosBulkExecutionOptions;
import com.azure.cosmos.models.CosmosBulkOperationResponse;
import com.azure.cosmos.models.CosmosChangeFeedRequestOptions;
import com.azure.cosmos.models.CosmosContainerResponse;
import com.azure.cosmos.models.CosmosItemIdentity;
import com.azure.cosmos.models.CosmosItemOperation;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosPatchItemRequestOptions;
import com.azure.cosmos.models.CosmosPatchOperations;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.CosmosReadManyRequestOptions;
import com.azure.cosmos.models.CosmosStoredProcedureRequestOptions;
import com.azure.cosmos.models.CosmosStoredProcedureResponse;
import com.azure.cosmos.models.FeedResponse;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlQuerySpec;
import com.azure.cosmos.util.CosmosPagedFlux;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import java.util.List;
import java.util.function.Supplier;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Guarded handles over the asynchronous {@code azure-cosmos} client, made by {@link CosmosStore#asyncClient}. The check
 * runs when the operation is <em>called</em>, on the calling thread, so it sees the request and the Preview that made the
 * call whichever thread later subscribes. A refused write is a {@code Mono.error} (or {@code Flux.error}) carrying the
 * Preview exception, and nothing is sent. Reads (point reads, feeds, queries) return the SDK's own publisher.
 */
public final class GuardedCosmosAsync {
    private GuardedCosmosAsync() {
    }

    private static <T> Mono<T> mono(CosmosStore store, String operation, boolean triggers, String database, String container,
                                    String statement, Supplier<Mono<T>> send) {
        Observation call;
        try {
            call = store.guard(operation, triggers, database, container, statement);
        } catch (RuntimeException refused) {
            return Mono.error(refused);
        }
        return send.get().doOnSuccess(result -> call.complete(null, null)).doOnError(failure -> call.complete(null, failure));
    }

    private static <T> Flux<T> flux(CosmosStore store, String operation, String database, String container, Supplier<Flux<T>> send) {
        Observation call;
        try {
            call = store.guard(operation, false, database, container, null);
        } catch (RuntimeException refused) {
            return Flux.error(refused);
        }
        return send.get().doOnComplete(() -> call.complete(null, null)).doOnError(failure -> call.complete(null, failure));
    }

    /** A guarded read: the publisher is the SDK's own and the entry is completed at once, as nothing is sent until subscription. */
    private static <T> T read(CosmosStore store, String operation, String database, String container, String statement, Supplier<T> send) {
        store.guard(operation, false, database, container, statement).complete(null, null);
        return send.get();
    }

    /** A guarded asynchronous client. */
    public static final class Client {
        private final CosmosStore store;
        private final CosmosAsyncClient raw;

        Client(CosmosStore store, CosmosAsyncClient raw) {
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
        private final CosmosAsyncDatabase raw;

        Database(CosmosStore store, CosmosAsyncDatabase raw) {
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
        private final CosmosAsyncContainer raw;

        Container(CosmosStore store, String database, CosmosAsyncContainer raw) {
            this.store = store;
            this.database = database;
            this.raw = raw;
        }

        private <T> Mono<T> mono(String operation, boolean triggers, Supplier<Mono<T>> send) {
            return GuardedCosmosAsync.mono(store, operation, triggers, database, raw.getId(), null, send);
        }

        private <T> T read(String operation, String statement, Supplier<T> send) {
            return GuardedCosmosAsync.read(store, operation, database, raw.getId(), statement, send);
        }

        /** The container id. */
        public String getId() {
            return raw.getId();
        }

        // ---- Reads ----

        /** Reads the container's properties. */
        public Mono<CosmosContainerResponse> read() {
            return mono("Read", false, raw::read);
        }

        /** Reads one item; a trigger named in {@code options} makes it a write. */
        public <T> Mono<CosmosItemResponse<T>> readItem(String id, PartitionKey key, Class<T> type) {
            return mono("Read", false, () -> raw.readItem(id, key, type));
        }

        /** Reads one item; a trigger named in {@code options} makes it a write. */
        public <T> Mono<CosmosItemResponse<T>> readItem(String id, PartitionKey key, CosmosItemRequestOptions options, Class<T> type) {
            return mono("Read", CosmosStore.triggers(options), () -> raw.readItem(id, key, options, type));
        }

        /** Reads every item of a partition. */
        public <T> CosmosPagedFlux<T> readAllItems(PartitionKey key, CosmosQueryRequestOptions options, Class<T> type) {
            return read("ReadFeed", null, () -> raw.readAllItems(key, options, type));
        }

        /** Runs a query. */
        public <T> CosmosPagedFlux<T> queryItems(String query, CosmosQueryRequestOptions options, Class<T> type) {
            return read("Query", query, () -> raw.queryItems(query, options, type));
        }

        /** Runs a query. */
        public <T> CosmosPagedFlux<T> queryItems(SqlQuerySpec query, CosmosQueryRequestOptions options, Class<T> type) {
            return read("Query", CosmosStore.text(query), () -> raw.queryItems(query, options, type));
        }

        /** Reads the change feed. */
        public <T> CosmosPagedFlux<T> queryChangeFeed(CosmosChangeFeedRequestOptions options, Class<T> type) {
            return read("ReadFeed", null, () -> raw.queryChangeFeed(options, type));
        }

        /** Reads several items by id and partition key. */
        public <T> Mono<FeedResponse<T>> readMany(List<CosmosItemIdentity> identities, CosmosReadManyRequestOptions options, Class<T> type) {
            return mono("Query", false, () -> raw.readMany(identities, options, type));
        }

        /** Guarded stored procedure access. */
        public Scripts getScripts() {
            return new Scripts(store, database, raw.getId(), raw.getScripts());
        }

        // ---- Writes ----

        /** Creates an item. */
        public <T> Mono<CosmosItemResponse<T>> createItem(T item) {
            return mono("Create", false, () -> raw.createItem(item));
        }

        /** Creates an item. */
        public <T> Mono<CosmosItemResponse<T>> createItem(T item, PartitionKey key, CosmosItemRequestOptions options) {
            return mono("Create", CosmosStore.triggers(options), () -> raw.createItem(item, key, options));
        }

        /** Creates or replaces an item. */
        public <T> Mono<CosmosItemResponse<T>> upsertItem(T item) {
            return mono("Upsert", false, () -> raw.upsertItem(item));
        }

        /** Creates or replaces an item. */
        public <T> Mono<CosmosItemResponse<T>> upsertItem(T item, PartitionKey key, CosmosItemRequestOptions options) {
            return mono("Upsert", CosmosStore.triggers(options), () -> raw.upsertItem(item, key, options));
        }

        /** Replaces an item. */
        public <T> Mono<CosmosItemResponse<T>> replaceItem(T item, String id, PartitionKey key, CosmosItemRequestOptions options) {
            return mono("Replace", CosmosStore.triggers(options), () -> raw.replaceItem(item, id, key, options));
        }

        /** Patches an item, including a patch whose filter predicate fails. */
        public <T> Mono<CosmosItemResponse<T>> patchItem(String id, PartitionKey key, CosmosPatchOperations operations,
                                                         CosmosPatchItemRequestOptions options, Class<T> type) {
            return mono("Patch", CosmosStore.triggers(options), () -> raw.patchItem(id, key, operations, options, type));
        }

        /** Deletes an item. */
        public Mono<CosmosItemResponse<Object>> deleteItem(String id, PartitionKey key, CosmosItemRequestOptions options) {
            return mono("Delete", CosmosStore.triggers(options), () -> raw.deleteItem(id, key, options));
        }

        /** Deletes every item of a partition. */
        public Mono<CosmosItemResponse<Object>> deleteAllItemsByPartitionKey(PartitionKey key, CosmosItemRequestOptions options) {
            return mono("Delete", CosmosStore.triggers(options), () -> raw.deleteAllItemsByPartitionKey(key, options));
        }

        /** Runs a transactional batch: a write even when every operation in it reads. */
        public Mono<CosmosBatchResponse> executeCosmosBatch(CosmosBatch batch, CosmosBatchRequestOptions options) {
            return mono("Batch", false, () -> raw.executeCosmosBatch(batch, options));
        }

        /** Runs bulk operations, which the SDK sends as non-atomic batches. */
        public <C> Flux<CosmosBulkOperationResponse<C>> executeBulkOperations(Flux<CosmosItemOperation> operations,
                                                                              CosmosBulkExecutionOptions options) {
            return flux(store, "Batch", database, raw.getId(), () -> raw.executeBulkOperations(operations, options));
        }

        /** Deletes the container. */
        public Mono<CosmosContainerResponse> delete() {
            return mono("Delete", false, raw::delete);
        }
    }

    /** Guarded stored procedure access. */
    public static final class Scripts {
        private final CosmosStore store;
        private final String database;
        private final String container;
        private final CosmosAsyncScripts raw;

        Scripts(CosmosStore store, String database, String container, CosmosAsyncScripts raw) {
            this.store = store;
            this.database = database;
            this.container = container;
            this.raw = raw;
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
        private final CosmosAsyncStoredProcedure raw;

        StoredProcedure(CosmosStore store, String database, String container, CosmosAsyncStoredProcedure raw) {
            this.store = store;
            this.database = database;
            this.container = container;
            this.raw = raw;
        }

        /** Reads the procedure's definition. */
        public Mono<CosmosStoredProcedureResponse> read() {
            return GuardedCosmosAsync.mono(store, "Read", false, database, container, null, raw::read);
        }

        /** Runs the procedure; the guard can't see its code, so this is always a write. */
        public Mono<CosmosStoredProcedureResponse> execute(List<Object> arguments, CosmosStoredProcedureRequestOptions options) {
            return GuardedCosmosAsync.mono(store, "ExecuteJavaScript", false, database, container, null, () -> raw.execute(arguments, options));
        }

        /** Deletes the procedure. */
        public Mono<CosmosStoredProcedureResponse> delete() {
            return GuardedCosmosAsync.mono(store, "Delete", false, database, container, null, raw::delete);
        }
    }
}

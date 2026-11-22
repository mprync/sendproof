package io.github.mprync.sendproof.cosmosdb;

import com.azure.cosmos.CosmosAsyncClient;
import com.azure.cosmos.CosmosAsyncContainer;
import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.SqlQuerySpec;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore;
import io.github.mprync.sendproof.core.stores.Partiql;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.Arrays;
import java.util.Collection;
import java.util.Set;

/**
 * Sendproof write guard for Azure Cosmos DB for NoSQL ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p><b>How it hooks.</b> The {@code azure-cosmos} client has no public hook that runs before a request is sent. Its
 * diagnostics handlers run after, and {@code CosmosOperationPolicy} only overrides request options: it exposes neither a
 * request's trigger options nor its headers, so it can't tell a read from a read that names a trigger. The client classes
 * are final or have package-private constructors, so they can't be subclassed or proxied either. The hook is therefore a
 * set of wrappers: {@link #client} (or {@link #asyncClient}) returns a guarded client whose
 * {@code getDatabase(id).getContainer(id)} chain, container operations and stored procedures all check the operation first.
 * Handlers must use the guarded handles.
 *
 * <pre>{@code
 * CosmosStore orders = CosmosStore.builder().name("orders").build();
 * GuardedCosmos.Client client = orders.client(new CosmosClientBuilder().endpoint(url).key(key).buildClient());
 * GuardedCosmos.Container container = client.getDatabase("shop").getContainer("orders");
 * }</pre>
 *
 * <p>Reads run: point reads, {@code readAllItems}, queries, {@code readMany}, the change feed and container and stored
 * procedure reads. During a Preview the first write is refused before the SDK sends it
 * ({@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}) and the Preview answers 409: create,
 * upsert, replace, patch, delete, transactional batches and bulk operations, stored procedure execution, anything that
 * names a pre-trigger or post-trigger (even a read), and container or stored procedure management.
 * Classification follows {@code spec/data-stores/cosmosdb.json}. The wrappers expose only the operations they guard:
 * database, container and user management, conflicts and throughput control aren't offered (use the raw client for setup
 * code that runs outside a request). Spring Data Cosmos isn't hooked: its template is built on the SDK's final client
 * classes, which can't be wrapped. Only a guarded handle is covered: the raw client it was made from is not.
 */
public final class CosmosStore extends GuardOnlyStore {
    private CosmosStore(Builder builder) {
        super("cosmosdb", builder.name, builder.reads);
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Configures a {@link CosmosStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code orders}; never an endpoint or key. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Operation types (such as {@code Execute}) the host states never write, matched exactly. This is the host's
         * statement: an operation wrongly listed here is not blocked. A request that names a trigger is still refused.
         */
        public Builder treatAsRead(String... operations) {
            this.reads = StoreGuard.readSet(Arrays.asList(operations), operation -> operation);
            return this;
        }

        /** Builds the store. */
        public CosmosStore build() {
            return new CosmosStore(this);
        }
    }

    /** A guarded synchronous client: every container it hands out checks each operation before it is sent. */
    public GuardedCosmos.Client client(CosmosClient raw) {
        return new GuardedCosmos.Client(this, raw);
    }

    /** A guarded asynchronous client. */
    public GuardedCosmosAsync.Client asyncClient(CosmosAsyncClient raw) {
        return new GuardedCosmosAsync.Client(this, raw);
    }

    /** A guarded handle on one container, for code that already has the raw one and its database id. */
    public GuardedCosmos.Container container(String database, CosmosContainer raw) {
        return new GuardedCosmos.Container(this, database, raw);
    }

    /** A guarded asynchronous handle on one container. */
    public GuardedCosmosAsync.Container asyncContainer(String database, CosmosAsyncContainer raw) {
        return new GuardedCosmosAsync.Container(this, database, raw);
    }

    /**
     * Guards one operation: the decision every wrapper (and the recordings replay) goes through before anything is sent.
     *
     * @param operationType the SDK's operation type: {@code Read}, {@code ReadFeed}, {@code Query}, {@code Create},
     *                      {@code Upsert}, {@code Replace}, {@code Patch}, {@code Delete}, {@code Batch},
     *                      {@code ExecuteJavaScript}; compared case-insensitively
     * @param triggers      whether the request names a pre-trigger or post-trigger
     * @param database      the database id, or {@code null}
     * @param container     the container id, or {@code null}
     * @param statement     the query text, or {@code null}; inline literals are replaced in the log
     * @return what to complete when the operation ends
     * @throws io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException when a write is refused during a Preview
     */
    public Observation guard(String operationType, boolean triggers, String database, String container, String statement) {
        StoreClassifier.Classified classified = StoreClassifier.cosmos(operationType, triggers, reads());
        return observe(classified, container, database, statement == null ? null : Partiql.sanitize(statement));
    }

    /** Whether a request's item options name a pre-trigger or post-trigger. */
    static boolean triggers(CosmosItemRequestOptions options) {
        return options != null && (present(options.getPreTriggerInclude()) || present(options.getPostTriggerInclude()));
    }

    private static boolean present(Collection<String> names) {
        return names != null && !names.isEmpty();
    }

    /** The text of a query given as a string or a spec. */
    static String text(Object query) {
        return query instanceof SqlQuerySpec spec ? spec.getQueryText() : query instanceof String text ? text : null;
    }
}

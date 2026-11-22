package io.github.mprync.sendproof.firestore;

import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.FirestoreOptions;
import com.google.cloud.firestore.spi.v1.FirestoreRpc;
import com.google.cloud.firestore.spi.v1.GrpcFirestoreRpc;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore;
import io.github.mprync.sendproof.core.stores.StoreClassifier.Classified;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Arrays;
import java.util.Set;

/**
 * Sendproof write guard for Google Cloud Firestore ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>The hook is the client's {@code FirestoreRpc}, the layer that owns every call's callable: {@link #options} builds
 * {@code FirestoreOptions} whose RPC layer is wrapped, so each call is checked on the thread that made it, before the
 * library schedules it, retries it or opens a gRPC stream. That covers unary and streaming calls alike, including
 * {@code RunQuery}, {@code BatchGetDocuments} and {@code Listen}, and the {@code Write} stream, which is refused before it
 * is opened.
 *
 * <pre>{@code
 * FirestoreStore orders = FirestoreStore.builder().name("orders").build();
 * Firestore db = orders.firestore(FirestoreOptions.newBuilder().setProjectId("my-project"));
 * }</pre>
 *
 * <p>Reads run. During a Preview the first write is refused before anything is sent
 * ({@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}, thrown from the call) and the Preview
 * answers 409. Classification follows {@code spec/data-stores/firestore.json}: {@code BatchGetDocuments},
 * {@code RunQuery}, {@code RunAggregationQuery}, {@code PartitionQuery}, {@code ListDocuments}, {@code ListCollectionIds}
 * and {@code Listen} read; {@code BeginTransaction} and {@code Rollback} are allowed; {@code Commit} is a write when it
 * carries at least one write; {@code BatchWrite}, the {@code Write} stream, {@code ExecutePipeline} and any call the table
 * doesn't know are writes.
 *
 * <p>A client derived from a hooked one ({@code getOptions().toBuilder().build().getService()}) keeps the wrapped RPC
 * layer, so it stays guarded, and so does an emulator endpoint. Only a client built through this store is covered: a
 * {@code Firestore} from {@code FirestoreOptions.getDefaultInstance()} is not.
 *
 * <p>The gRPC channel interceptor the plan names as the hook can't attribute a call to its request: the library runs every
 * attempt on its own scheduler thread, so an interceptor sees the call on a thread with no request behind it.
 */
public final class FirestoreStore extends GuardOnlyStore {
    private FirestoreStore(Builder builder) {
        super("firestore", builder.name, builder.reads);
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Configures a {@link FirestoreStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code orders}; never a project id URL, host or credential. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * RPC method names (such as {@code RunQuery}) the host states never write, matched exactly. This is the host's
         * statement: a method wrongly listed here is not blocked. A {@code Commit} that carries writes is not affected.
         */
        public Builder treatAsRead(String... methods) {
            this.reads = StoreGuard.readSet(Arrays.asList(methods), method -> method);
            return this;
        }

        /** Builds the store. */
        public FirestoreStore build() {
            return new FirestoreStore(this);
        }
    }

    /** Builds the options so the client's RPC layer is wrapped; every {@code Firestore} made from them is guarded. */
    public FirestoreOptions options(FirestoreOptions.Builder options) {
        return options.setServiceRpcFactory(settings -> {
            try {
                return rpc(new GrpcFirestoreRpc(settings));
            } catch (IOException failure) {
                throw new UncheckedIOException(failure);
            }
        }).build();
    }

    /** A Firestore client whose every call is checked: {@code options(builder).getService()}. */
    public Firestore firestore(FirestoreOptions.Builder options) {
        return options(options).getService();
    }

    /**
     * Wraps an RPC layer so every callable it hands out is checked. Wrapping a layer this store already wrapped returns it
     * unchanged.
     */
    public FirestoreRpc rpc(FirestoreRpc raw) {
        if (raw instanceof GuardedRpc guarded && guarded.sendproofStore() == this) {
            return raw;
        }
        return RpcGuard.wrap(this, raw);
    }

    /** Whether {@code rpc} is an RPC layer this library guards, by any store. */
    public static boolean isGuarded(Object rpc) {
        return rpc instanceof GuardedRpc;
    }

    /** Marks an RPC layer returned by {@link #rpc}. */
    public interface GuardedRpc {
        /** The store that guards this layer. */
        FirestoreStore sendproofStore();
    }

    /**
     * A bulk writer that refuses a write when it is queued. The real {@code BulkWriter} sends later, in batches, and retries
     * on its own, so a refusal at send time can loop until {@code flush} never returns: refuse before it is queued.
     *
     * @param db a client made by this store
     */
    public GuardedBulkWriter bulkWriter(Firestore db) {
        return new GuardedBulkWriter(this, db.bulkWriter());
    }

    /** Guards a write that is being queued on the calling thread. */
    Observation queued(String operation) {
        return observe(new Classified(io.github.mprync.sendproof.core.stores.CommandKind.WRITE, operation), null, null, null);
    }

    Observation start(Classified classified) {
        return observe(classified, null, null, null);
    }

    Set<String> hostReads() {
        return reads();
    }
}

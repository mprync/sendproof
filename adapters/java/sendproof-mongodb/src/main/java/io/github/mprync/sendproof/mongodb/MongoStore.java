package io.github.mprync.sendproof.mongodb;

import com.mongodb.ContextProvider;
import com.mongodb.event.CommandListener;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DataStoreSession;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.time.Duration;
import java.util.Arrays;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * A hooked MongoDB deployment, ready for {@code dataStores}: during a Preview its writes join a transaction that is
 * always aborted ({@code preview} mode, on a replica set or sharded cluster) or are refused before they are sent
 * ({@code guard} mode, on a standalone server).
 *
 * <p>No MongoDB driver offers a pre-send hook, so the store hands the application guarded handles and watches the
 * driver's command monitoring as a tripwire:
 *
 * <pre>{@code
 * MongoStore store = MongoStore.builder().name("catalog").build();
 * MongoClient raw = MongoClients.create(MongoClientSettings.builder()
 *         .applyConnectionString(new ConnectionString(url))
 *         .addCommandListener(store.commandListener())   // the tripwire: required
 *         .build());
 * MongoClient client = store.sync(raw);                    // the application uses this one
 * }</pre>
 *
 * <p>With Spring Data MongoDB, {@code sendproof-spring-boot} hooks the {@code MongoDatabaseFactory} and registers the
 * listener for you. A client the store never saw, such as a second client for the same cluster, is not covered: its
 * writes are not blocked and not rolled back.
 */
public final class MongoStore implements DataStore {
    private final String name;
    private final Set<String> reads;
    private final long timeoutMs;
    private volatile MongoEngine engine;
    private volatile SessionBinder binder = SessionBinder.NONE;
    private volatile GuardedMongo guarded;
    private final CommandListener listener;
    private final MongoEngine.Deferred deferred;

    private MongoStore(Builder builder) {
        this.name = builder.name;
        this.reads = builder.reads;
        this.timeoutMs = builder.timeout.toMillis();
        this.deferred = new MongoEngine.Deferred();
        this.listener = deferred.listener();
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Starts a store configuration for Spring Data MongoDB, whose database factory Spring Boot attaches. */
    public static Builder springData() {
        return new Builder();
    }

    /** Configures a {@link MongoStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;
        private Duration timeout = Duration.ofMillis(MongoEngine.DEFAULT_TIMEOUT_MS);

        private Builder() {
        }

        /** A display label for discovery such as {@code catalog}; never a connection string, host or credentials. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Commands the host states never write, matched by exact name without wildcards. This is the host's statement:
         * a command wrongly listed here is not blocked.
         */
        public Builder treatAsRead(String... commands) {
            this.reads = StoreGuard.readSet(Arrays.asList(commands), command -> command.toLowerCase(java.util.Locale.ROOT));
            return this;
        }

        /**
         * How long a Preview may run before its transaction is aborted and the Preview answers 500. The default is 50
         * seconds, below the server's 60-second transaction lifetime.
         */
        public Builder previewTimeout(Duration limit) {
            if (limit == null || limit.isNegative() || limit.isZero()) {
                throw new IllegalArgumentException("The Preview time limit must be positive.");
            }
            this.timeout = limit;
            return this;
        }

        /** Builds the store. */
        public MongoStore build() {
            return new MongoStore(this);
        }
    }

    @Override
    public String system() {
        return "mongodb";
    }

    @Override
    public Description describe() {
        MongoEngine current = engine;
        if (current == null) {
            return new Description("mongodb", name, "guard", "Preview unavailable: no MongoDB client is attached to Sendproof");
        }
        return current.detect();
    }

    @Override
    public DataStoreSession begin(RequestCapture capture) {
        MongoEngine current = engine;
        if (current == null) {
            return null;
        }
        MongoEngine.PreviewState state = current.begin(capture, binder);
        if (state == null) {
            return null;
        }
        return new DataStoreSession() {
            @Override
            public void finish(RequestCapture finishing) {
                current.finish(finishing);
            }

            @Override
            public void close() {
                current.release(capture);
            }
        };
    }

    // ---- Wiring ----

    /**
     * The command listener to register with {@code MongoClientSettings.Builder#addCommandListener}. It is the tripwire: a
     * write that reaches the server during a Preview without the Preview's session fails the Preview with 500.
     */
    public CommandListener commandListener() {
        return listener;
    }

    /**
     * The context provider a reactive streams client must be built with
     * ({@code MongoClientSettings.Builder#contextProvider}), so command events find their request's capture.
     */
    public ContextProvider reactiveContextProvider() {
        return ReactiveSupport.contextProvider();
    }

    /**
     * Attaches the synchronous driver and returns the guarded client to give the application.
     *
     * @param client a {@code com.mongodb.client.MongoClient} created with {@link #commandListener()}
     * @return a guarded {@code com.mongodb.client.MongoClient}
     */
    public <T> T sync(T client) {
        attach(SyncSupport.backend((com.mongodb.client.MongoClient) client), SessionBinder.NONE);
        return cast(guarded.wrap(client));
    }

    /**
     * Attaches the reactive streams driver and returns the guarded client to give the application.
     *
     * @param client a {@code com.mongodb.reactivestreams.client.MongoClient} created with {@link #commandListener()}
     *               and {@link #reactiveContextProvider()}
     * @return a guarded {@code com.mongodb.reactivestreams.client.MongoClient}
     */
    public <T> T reactive(T client) {
        attach(ReactiveSupport.backend((com.mongodb.reactivestreams.client.MongoClient) client), SessionBinder.NONE);
        return cast(guarded.wrap(client));
    }

    /**
     * Attaches a synchronous source of sessions and databases, as a Spring Data {@code MongoDatabaseFactory} offers
     * them, and a binder that makes the Preview's session ambient for the framework.
     *
     * @param sessions  starts a driver {@code ClientSession}
     * @param databases the unguarded {@code MongoDatabase} for a name
     */
    public void attachSync(Supplier<?> sessions, Function<String, ?> databases, SessionBinder sessionBinder) {
        attach(SyncSupport.backend(sessions, databases), sessionBinder);
    }

    /** Guards a synchronous driver handle (client, database or collection) with this store. */
    public <T> T guard(T handle) {
        if (guarded == null) {
            throw new IllegalStateException("Attach a MongoDB client to this store before guarding its handles.");
        }
        return cast(guarded.wrap(handle));
    }

    /** Whether a client is attached. */
    public boolean attached() {
        return engine != null;
    }

    /** The engine of the attached client, or {@code null}. */
    MongoEngine engine() {
        return engine;
    }

    synchronized void attach(MongoBackend backend, SessionBinder sessionBinder) {
        if (engine != null) {
            throw new IllegalStateException("This MongoStore is already attached to a MongoDB client.");
        }
        MongoEngine created = new MongoEngine(backend, reads, timeoutMs, name);
        deferred.bind(created);
        this.binder = sessionBinder;
        this.guarded = new GuardedMongo(created);
        this.engine = created;
    }

    @SuppressWarnings("unchecked")
    private static <T> T cast(Object value) {
        return (T) value;
    }
}

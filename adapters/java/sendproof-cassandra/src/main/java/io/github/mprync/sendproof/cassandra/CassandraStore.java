package io.github.mprync.sendproof.cassandra;

import com.datastax.oss.driver.api.core.CqlSession;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;

/**
 * Sendproof write guard for Apache Cassandra and ScyllaDB ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>Cassandra has no rollback, so a Preview can only refuse. {@link #session} wraps a DataStax Java driver 4
 * {@link CqlSession} in a {@link java.lang.reflect.Proxy} that sees every statement at the statement API, above the
 * driver's own prepare: simple, bound and batch statements, text and prepared, synchronous, asynchronous and reactive.
 * Reads run; during a Preview the first write is refused before the driver sends it
 * ({@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}) and the Preview answers 409.
 *
 * <pre>{@code
 * CassandraStore tickets = CassandraStore.builder().name("tickets").build();
 * CqlSession session = tickets.session(CqlSession.builder().build());   // handlers use this one
 * }</pre>
 *
 * <p>Classification follows {@code spec/data-stores/cassandra.json}: {@code SELECT}, {@code USE}, {@code DESCRIBE} and
 * {@code LIST} read; every {@code BATCH} is a write, as is a lightweight transaction ({@code IF NOT EXISTS}), DDL,
 * {@code GRANT} and anything unknown. A bound statement is classified by the text it was prepared from, and text that
 * holds a second statement, or can't be read, is a write. {@code PREPARE} only parses a statement and is allowed.
 *
 * <p>Spring Boot hooks every {@code CqlSession} bean on its own. Only a hooked session is covered: a session built
 * elsewhere (another {@code CqlSession.builder()}) is not.
 */
public final class CassandraStore extends GuardOnlyStore {
    private CassandraStore(Builder builder) {
        super("cassandra", builder.name, builder.reads);
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Configures a {@link CassandraStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code tickets}; never a contact point or URL. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Statement keywords the host states never write, matched exactly in upper case without wildcards. This is the
         * host's statement: a keyword wrongly listed here is not blocked. A {@code BATCH}, or text that holds more than
         * one statement, is still refused.
         */
        public Builder treatAsRead(String... keywords) {
            this.reads = StoreGuard.readSet(Arrays.asList(keywords), word -> word.toUpperCase(Locale.ROOT));
            return this;
        }

        /** Builds the store. */
        public CassandraStore build() {
            return new CassandraStore(this);
        }
    }

    /**
     * Wraps a session so every statement is checked before it is sent. Handlers must use the returned session. Wrapping a
     * session this store already wrapped returns it unchanged.
     *
     * @return a {@link CqlSession} that is also a {@link GuardedSession}
     */
    public CqlSession session(CqlSession raw) {
        if (raw instanceof GuardedSession guarded && guarded.sendproofStore() == this) {
            return raw;
        }
        return (CqlSession) Proxy.newProxyInstance(CassandraStore.class.getClassLoader(),
                new Class<?>[] {CqlSession.class, GuardedSession.class}, new GuardedSessionHandler(this, raw));
    }

    /** Whether {@code session} is a session this library guards, by any store. */
    public static boolean isGuarded(Object session) {
        return session instanceof GuardedSession;
    }

    /** Marks a session returned by {@link #session}. */
    public interface GuardedSession {
        /** The store that guards this session. */
        CassandraStore sendproofStore();
    }

    Set<String> hostReads() {
        return reads();
    }

    Observation start(io.github.mprync.sendproof.core.stores.StoreClassifier.Classified classified, String target,
                      String namespace, String statement) {
        return observe(classified, target, namespace, statement);
    }
}

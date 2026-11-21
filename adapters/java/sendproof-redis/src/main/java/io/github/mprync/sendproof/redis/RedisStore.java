package io.github.mprync.sendproof.redis;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.DataStore;
import io.github.mprync.sendproof.core.DbEntry;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Sendproof write guard for Redis ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>Reads run normally. During a Preview the first write is refused before any byte of it is sent, with
 * {@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}, and the Preview answers 409. Connection
 * commands ({@code AUTH}, {@code HELLO}, {@code SELECT}, {@code PING} ...) are never guarded or logged, so the password
 * never reaches a capture. Every other command becomes a {@code Db} log entry whose statement keeps the command name and
 * key arguments only.
 *
 * <p>Hooks, one per client:
 * <ul>
 *   <li>Spring Data Redis over Lettuce or Jedis: {@link #spring} decorates a {@code RedisConnectionFactory}, so
 *       {@code getConnection()} returns a guarded {@code RedisConnection};</li>
 *   <li>Jedis 5 on its own: {@link #jedis} builds a {@code JedisPooled} whose every connection is guarded, so commands,
 *       pipelines and {@code MULTI} are all checked before the first byte is written.</li>
 * </ul>
 *
 * <p>Coverage: only hooked clients are covered. A client created later, a second client for the same server, a raw
 * Lettuce connection, a Redis Cluster or Sentinel client, and reactive Spring Data access are not.
 */
public final class RedisStore implements DataStore {
    private final String name;
    private final Set<String> reads;

    private RedisStore(Builder builder) {
        this.name = builder.name;
        this.reads = builder.reads;
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Starts a store configuration for Spring Data Redis. */
    public static Builder spring() {
        return new Builder();
    }

    /** Configures a {@link RedisStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code cache}; never a URL or host name. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Commands the host states never write, such as a custom module read {@code MYMODULE.GET}. Exact names (or
         * {@code CONTAINER|SUB}), matched in upper case, without wildcards. This is the host's statement: a command
         * wrongly listed here is not blocked.
         */
        public Builder treatAsRead(String... commands) {
            this.reads = StoreGuard.readSet(Arrays.asList(commands), command -> command.toUpperCase(Locale.ROOT));
            return this;
        }

        /** Builds the store. */
        public RedisStore build() {
            return new RedisStore(this);
        }
    }

    @Override
    public String system() {
        return "redis";
    }

    @Override
    public Description describe() {
        return new Description("redis", name, "guard", null);
    }

    // ---- Hooks ----

    /**
     * Decorates a Spring Data Redis connection factory (Lettuce or Jedis). The result has the factory's own class, so it
     * replaces the bean; {@code getConnection()} returns a connection that checks every command before it is sent.
     */
    public <F> F spring(F factory) {
        return SpringRedis.guard(this, factory);
    }

    /**
     * Builds a Jedis 5 client whose every connection is guarded.
     *
     * @param address the server, as {@code redis.clients.jedis.HostAndPort}
     * @param config  the Jedis client configuration (credentials, database, timeouts)
     * @return a {@code redis.clients.jedis.JedisPooled}
     */
    public <J> J jedis(Object address, Object config) {
        return JedisRedis.pooled(this, address, config);
    }

    // ---- Shared by the hooks ----

    /** Classifies a command and, during a Preview, refuses a write. Returns the kind for sessions and transactions. */
    CommandKind check(String command, List<?> arguments) {
        CommandKind kind = StoreClassifier.redis(command, arguments, reads);
        StoreGuard.guard("redis", command.toUpperCase(Locale.ROOT), kind, null);
        return kind;
    }

    /** Records one finished command on the capture that was current when it was sent. */
    static void record(RequestCapture capture, String command, List<?> arguments, long startedNanos, Throwable failure) {
        if (capture == null) {
            return;
        }
        RedisStatements.Described described = RedisStatements.describe(command, arguments);
        DbEntry entry = DbEntry.of("redis", command.toUpperCase(Locale.ROOT)).withStatement(described.statement())
                .withElapsed((System.nanoTime() - startedNanos) / 1_000_000.0);
        if (described.target() != null) {
            entry = entry.withTarget(described.target());
        }
        if (failure != null) {
            String message = failure.getMessage();
            entry = entry.withError(message == null || message.isBlank() ? failure.getClass().getSimpleName()
                    : message.split(" ")[0]);
        }
        capture.db(entry);
    }

    /** The capture to log on, or {@code null}. */
    static RequestCapture capture() {
        return CaptureContext.current();
    }
}

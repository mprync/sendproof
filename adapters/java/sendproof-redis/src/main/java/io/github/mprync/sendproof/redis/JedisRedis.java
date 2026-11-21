package io.github.mprync.sendproof.redis;

import io.github.mprync.sendproof.core.stores.CommandKind;
import java.util.ArrayList;
import java.util.List;
import org.apache.commons.pool2.impl.GenericObjectPoolConfig;
import redis.clients.jedis.CommandArguments;
import redis.clients.jedis.Connection;
import redis.clients.jedis.ConnectionFactory;
import redis.clients.jedis.HostAndPort;
import redis.clients.jedis.JedisClientConfig;
import redis.clients.jedis.JedisPooled;
import redis.clients.jedis.providers.PooledConnectionProvider;
import redis.clients.jedis.args.Rawable;
import redis.clients.jedis.commands.ProtocolCommand;

/**
 * The Jedis 5 hook: a connection factory whose every {@code Connection} checks a command before it writes it. Single
 * commands, pipelines and {@code MULTI} transactions all go through {@code Connection.sendCommand}, so each queued
 * command is classified on its own, before the first byte of it is written.
 */
final class JedisRedis {
    private JedisRedis() {
    }

    @SuppressWarnings("unchecked")
    static <J> J pooled(RedisStore store, Object address, Object config) {
        var guardedFactory = new GuardedFactory(store, (HostAndPort) address, (JedisClientConfig) config);
        var pool = new GenericObjectPoolConfig<Connection>();
        return (J) new JedisPooled(new PooledConnectionProvider(guardedFactory, pool));
    }

    /** Creates connections that guard what they send. */
    private static final class GuardedFactory extends ConnectionFactory {
        private final RedisStore store;
        private final HostAndPort address;
        private final JedisClientConfig config;

        GuardedFactory(RedisStore store, HostAndPort address, JedisClientConfig config) {
            super(address, config);
            this.store = store;
            this.address = address;
            this.config = config;
        }

        @Override
        public org.apache.commons.pool2.PooledObject<Connection> makeObject() throws Exception {
            Connection connection = new GuardedConnection(store, address, config);
            connection.connect();
            return new org.apache.commons.pool2.impl.DefaultPooledObject<>(connection);
        }
    }

    /** A Jedis connection that refuses a write before writing any of it. */
    private static final class GuardedConnection extends Connection {
        private final RedisStore store;

        GuardedConnection(RedisStore store, HostAndPort address, JedisClientConfig config) {
            super(address, config);
            this.store = store;
        }

        @Override
        public void sendCommand(CommandArguments args) {
            if (store == null) {
                // Still inside the superclass constructor, which authenticates and selects the database.
                super.sendCommand(args);
                return;
            }
            ProtocolCommand protocol = args.getCommand();
            List<Object> arguments = new ArrayList<>();
            boolean first = true;
            for (Rawable raw : args) {
                if (first) {
                    first = false;
                    continue;
                }
                arguments.add(raw.getRaw());
            }
            String command = new String(protocol.getRaw(), java.nio.charset.StandardCharsets.UTF_8);
            CommandKind kind = store.check(command, arguments);
            if (kind == CommandKind.SESSION) {
                super.sendCommand(args);
                return;
            }
            var capture = RedisStore.capture();
            long started = System.nanoTime();
            try {
                super.sendCommand(args);
                RedisStore.record(capture, command, arguments, started, null);
            } catch (RuntimeException failure) {
                RedisStore.record(capture, command, arguments, started, failure);
                throw failure;
            }
        }
    }
}

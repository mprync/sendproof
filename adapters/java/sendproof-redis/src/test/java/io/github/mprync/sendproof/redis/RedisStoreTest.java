package io.github.mprync.sendproof.redis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import io.lettuce.core.ClientOptions;
import io.lettuce.core.SocketOptions;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisPassword;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.jedis.JedisConnectionFactory;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.SessionCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import redis.clients.jedis.DefaultJedisClientConfig;
import redis.clients.jedis.HostAndPort;
import redis.clients.jedis.JedisPooled;

/**
 * The Redis hooks against the compose server ({@code docker compose -f tests/conformance/compose.yml up -d --wait
 * redis}): Spring Data Redis over Lettuce and over Jedis, and Jedis on its own. Tests skip, saying so, when the
 * service doesn't answer a {@code PING}. Clients never reconnect and disconnect at once, so a dead port can't hang the build.
 */
class RedisStoreTest {
    private static final String HOST = "127.0.0.1";
    private static final int PORT = 56379;
    private static final String PASSWORD = "bench_redis_local";

    private final String prefix = "tb_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10) + ":";
    private RedisStore store;
    private JedisPooled checker;

    @BeforeEach
    void connect() {
        try {
            checker = new JedisPooled(new HostAndPort(HOST, PORT), DefaultJedisClientConfig.builder().password(PASSWORD)
                    .connectionTimeoutMillis(1000).socketTimeoutMillis(1000).build());
            checker.ping();
        } catch (RuntimeException unreachable) {
            assumeTrue(false, "Redis isn't running: docker compose -f tests/conformance/compose.yml up -d --wait redis");
        }
        checker.set(prefix + "seeded", "5");
        store = RedisStore.builder().name("cache").build();
    }

    @AfterEach
    void clean() {
        if (checker != null) {
            checker.keys(prefix + "*").forEach(checker::del);
            checker.close();
        }
    }

    private LettuceConnectionFactory lettuce() {
        var configuration = new RedisStandaloneConfiguration(HOST, PORT);
        configuration.setPassword(RedisPassword.of(PASSWORD));
        var client = LettuceClientConfiguration.builder().clientOptions(ClientOptions.builder().autoReconnect(false)
                .socketOptions(SocketOptions.builder().connectTimeout(Duration.ofSeconds(2)).build()).build())
                .commandTimeout(Duration.ofSeconds(2)).shutdownTimeout(Duration.ZERO).build();
        var factory = new LettuceConnectionFactory(configuration, client);
        factory.afterPropertiesSet();
        return factory;
    }

    private JedisConnectionFactory springJedis() {
        var configuration = new RedisStandaloneConfiguration(HOST, PORT);
        configuration.setPassword(RedisPassword.of(PASSWORD));
        var factory = new JedisConnectionFactory(configuration);
        factory.afterPropertiesSet();
        return factory;
    }

    /** Every hook under test, as a function from the template the handler uses. */
    private record Client(String name, StringRedisTemplate template, Runnable close) {
    }

    private List<Client> clients() {
        var lettuceFactory = store.spring(lettuce());
        var jedisFactory = store.spring(springJedis());
        var lettuceTemplate = new StringRedisTemplate(lettuceFactory);
        lettuceTemplate.afterPropertiesSet();
        var jedisTemplate = new StringRedisTemplate(jedisFactory);
        jedisTemplate.afterPropertiesSet();
        return List.of(new Client("spring-lettuce", lettuceTemplate, lettuceFactory::destroy),
                new Client("spring-jedis", jedisTemplate, jedisFactory::destroy));
    }

    @Test
    void aReadRunsAndIsLoggedWithKeysOnly() throws Exception {
        for (Client client : clients()) {
            try {
                PreviewOutcome outcome = Harness.preview(() -> assertThat(client.template().opsForValue().get(prefix + "seeded"))
                        .as(client.name()).isEqualTo("5"), store);
                JsonNode envelope = Harness.envelope(outcome);
                JsonNode entry = envelope.get("logs").get(0).get("db");
                assertThat(entry.get("system").asText()).as(client.name()).isEqualTo("redis");
                assertThat(entry.get("operation").asText()).isEqualTo("GET");
                assertThat(entry.get("statement").asText()).isEqualTo("GET " + prefix + "seeded");
                assertThat(entry.get("target").asText()).isEqualTo(prefix + "seeded");
                assertThat(envelope.toString()).doesNotContain(PASSWORD).doesNotContain("AUTH");
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void aWriteIsRefusedBeforeSendingAndTheHandlerCannotHideIt() throws Exception {
        for (Client client : clients()) {
            try {
                PreviewOutcome outcome = Harness.preview(() -> {
                    try {
                        client.template().opsForValue().increment(prefix + "blocked");
                    } catch (RuntimeException swallowed) {
                        // The handler catches the refusal and returns normally.
                    }
                }, store);
                assertThat(outcome.blocked()).as(client.name()).isTrue();
                assertThat(new String(outcome.problem())).contains("\"operation\":\"INCR\"").contains("\"store\":\"redis\"");
                assertThat(checker.get(prefix + "blocked")).as("INCR must not reach Redis").isNull();
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void getDelAndSetAreWritesEvenThoughGetIsARead() throws Exception {
        for (Client client : clients()) {
            try {
                for (String command : List.of("GETDEL", "SET", "EXPIRE", "DEL")) {
                    PreviewOutcome outcome = Harness.preview(() -> {
                        var ops = client.template().opsForValue();
                        try {
                            switch (command) {
                                case "GETDEL" -> ops.getAndDelete(prefix + "seeded");
                                case "SET" -> ops.set(prefix + "seeded", "9");
                                case "EXPIRE" -> client.template().expire(prefix + "seeded", Duration.ofSeconds(100));
                                default -> client.template().delete(prefix + "seeded");
                            }
                        } catch (RuntimeException swallowed) {
                            // Swallowed.
                        }
                    }, store);
                    assertThat(outcome.blocked()).as(client.name() + " " + command).isTrue();
                    assertThat(checker.get(prefix + "seeded")).as(client.name() + " " + command).isEqualTo("5");
                    assertThat(checker.ttl(prefix + "seeded")).isEqualTo(-1L);
                }
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void aPipelineWithAWriteIsRefusedBeforeAnyWriteIsSent() throws Exception {
        for (Client client : clients()) {
            try {
                PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> client.template().executePipelined(
                        (RedisCallback<Object>) connection -> {
                            connection.stringCommands().get((prefix + "seeded").getBytes());
                            connection.stringCommands().incr((prefix + "piped").getBytes());
                            return null;
                        })).isInstanceOf(PreviewWriteBlockedException.class), store);
                assertThat(outcome.blocked()).as(client.name()).isTrue();
                assertThat(checker.get(prefix + "piped")).isNull();
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void aMultiWithAQueuedWriteIsRefusedBeforeExec() throws Exception {
        for (Client client : clients()) {
            try {
                PreviewOutcome outcome = Harness.preview(() -> assertThatThrownBy(() -> client.template().execute(new SessionCallback<Object>() {
                    @Override
                    @SuppressWarnings({"unchecked", "rawtypes"})
                    public Object execute(org.springframework.data.redis.core.RedisOperations operations) {
                        operations.multi();
                        operations.opsForValue().get(prefix + "seeded");
                        operations.opsForValue().increment(prefix + "queued");
                        return operations.exec();
                    }
                })).isInstanceOf(PreviewWriteBlockedException.class), store);
                assertThat(outcome.blocked()).as(client.name()).isTrue();
                assertThat(checker.get(prefix + "queued")).isNull();
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void outsideAPreviewWritesRunAndObservedSendTracesThem() throws Exception {
        for (Client client : clients()) {
            try {
                var capture = Harness.observed(() -> client.template().opsForValue().increment(prefix + "sent"));
                assertThat(checker.get(prefix + "sent")).as(client.name()).isEqualTo("1");
                var logs = capture.finish().logs();
                assertThat(logs).anySatisfy(log -> {
                    assertThat(log.level()).isEqualTo("Db");
                    assertThat(log.db().operation()).isEqualTo("INCR");
                });
                checker.del(prefix + "sent");
            } finally {
                client.close().run();
            }
        }
    }

    @Test
    void hostDeclaredReadsAreAllowedByExactNameOnly() throws Exception {
        var custom = RedisStore.builder().treatAsRead("MYMODULE.GET").build();
        var factory = custom.spring(lettuce());
        var template = new StringRedisTemplate(factory);
        template.afterPropertiesSet();
        try {
            PreviewOutcome outcome = Harness.preview(() -> {
                assertThatThrownBy(() -> template.execute((RedisCallback<Object>) connection ->
                        connection.execute("MYMODULE.GET", (prefix + "k").getBytes()))).isNotInstanceOf(PreviewWriteBlockedException.class);
                assertThatThrownBy(() -> template.execute((RedisCallback<Object>) connection ->
                        connection.execute("MYMODULE.GETALL", (prefix + "k").getBytes()))).isInstanceOf(PreviewWriteBlockedException.class);
            }, custom);
            assertThat(outcome.blocked()).isTrue();
        } finally {
            factory.destroy();
        }
    }

    @Test
    void jedisOnItsOwnGuardsCommandsPipelinesAndTransactions() throws Exception {
        JedisPooled guarded = store.jedis(new HostAndPort(HOST, PORT), DefaultJedisClientConfig.builder().password(PASSWORD)
                .connectionTimeoutMillis(2000).socketTimeoutMillis(2000).build());
        try {
            JsonNode read = Harness.envelope(Harness.preview(() -> assertThat(guarded.get(prefix + "seeded")).isEqualTo("5"), store));
            assertThat(read.get("logs").get(0).get("db").get("statement").asText()).isEqualTo("GET " + prefix + "seeded");

            PreviewOutcome single = Harness.preview(() -> assertThatThrownBy(() -> guarded.incr(prefix + "j1"))
                    .isInstanceOf(PreviewWriteBlockedException.class), store);
            assertThat(single.blocked()).isTrue();
            assertThat(checker.get(prefix + "j1")).isNull();

            PreviewOutcome piped = Harness.preview(() -> {
                try (var pipeline = guarded.pipelined()) {
                    pipeline.get(prefix + "seeded");
                    assertThatThrownBy(() -> pipeline.incr(prefix + "j2")).isInstanceOf(PreviewWriteBlockedException.class);
                }
            }, store);
            assertThat(piped.blocked()).isTrue();
            assertThat(checker.get(prefix + "j2")).isNull();

            PreviewOutcome multi = Harness.preview(() -> {
                try (var transaction = guarded.multi()) {
                    transaction.get(prefix + "seeded");
                    assertThatThrownBy(() -> transaction.incr(prefix + "j3")).isInstanceOf(PreviewWriteBlockedException.class);
                    transaction.discard();
                }
            }, store);
            assertThat(multi.blocked()).isTrue();
            assertThat(checker.get(prefix + "j3")).isNull();

            // Outside a Preview writes run.
            assertThat(guarded.incr(prefix + "j4")).isEqualTo(1L);
        } finally {
            guarded.close();
        }
    }

    @Test
    void theChecksFailWhenTheHookIsRemoved() throws Exception {
        // An unhooked client writes during a Preview and the Preview confirms: the conformance checks catch exactly this.
        var factory = lettuce();
        var template = new StringRedisTemplate(factory);
        template.afterPropertiesSet();
        try {
            PreviewOutcome outcome = Harness.preview(() -> template.opsForValue().increment(prefix + "unhooked"), store);
            assertThat(outcome.blocked()).isFalse();
            assertThat(checker.get(prefix + "unhooked")).isEqualTo("1");
        } finally {
            factory.destroy();
        }
    }
}

package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.ConnectionString;
import com.mongodb.MongoClientSettings;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.bson.Document;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.mongodb.MongoDatabaseFactory;
import org.springframework.data.mongodb.MongoTransactionManager;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Spring Data MongoDB and Spring Data Redis, hooked automatically, against the compose services ({@code docker compose -f
 * tests/conformance/compose.yml up -d --wait mongodb redis}). The tests skip, saying so, when a service doesn't answer.
 * They prove the Spring path: {@code MongoTemplate} and the application's own transaction manager join the Preview
 * transaction, nothing commits, a second session is refused, and the Redis factory returns guarded connections.
 */
@SpringBootTest(classes = SpringDataStoresTest.App.class, properties = {"sendproof.enabled=true",
        "sendproof.environment=Development", "sendproof.trace.retention=5s", "sendproof.stores.mongodb.name=catalog",
        "sendproof.stores.redis.name=cache", "spring.autoconfigure.exclude="
        + "org.springframework.boot.autoconfigure.elasticsearch.ElasticsearchRestClientAutoConfiguration,"
        + "org.springframework.boot.autoconfigure.elasticsearch.ElasticsearchClientAutoConfiguration"})
@AutoConfigureMockMvc
class SpringDataStoresTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MONGO = System.getenv().getOrDefault("BENCH_MONGODB_SERVER_URL", "mongodb://127.0.0.1:57017/?directConnection=true");
    private static final String DATABASE = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private static final String PREFIX = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10) + ":";
    private static boolean mongoUp;
    private static boolean redisUp;
    private static MongoClient raw;

    @RestController
    @RequestMapping("/m")
    static class MongoRoutes {
        private final MongoTemplate mongo;
        private final MongoTransactionManager transactions;
        private final StringRedisTemplate redis;

        MongoRoutes(MongoTemplate mongo, MongoTransactionManager transactions, StringRedisTemplate redis) {
            this.mongo = mongo;
            this.transactions = transactions;
            this.redis = redis;
        }

        @SendproofPreview
        @PostMapping("/insert")
        Map<String, String> insert() {
            mongo.insert(new Document("_id", "template").append("name", "T").append("password_hash", "h"), "docs");
            return Map.of("ok", "true");
        }

        /** The application's own Mongo transaction, joining the Preview's. */
        @PostMapping("/insert-sent")
        Map<String, String> insertSent() {
            mongo.insert(new Document("_id", "sent"), "docs");
            return Map.of("ok", "true");
        }

        @SendproofPreview
        @PostMapping("/transactional")
        Map<String, String> transactional() {
            new TransactionTemplate(transactions).executeWithoutResult(status ->
                    mongo.insert(new Document("_id", "transactional"), "docs"));
            return Map.of("ok", "true");
        }

        @SendproofPreview
        @PostMapping("/requires-new")
        Map<String, String> requiresNew() {
            var template = new TransactionTemplate(transactions);
            template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            template.executeWithoutResult(status -> mongo.insert(new Document("_id", "requires-new"), "docs"));
            return Map.of("ok", "true");
        }

        /** Handler code reaches for the ambient session and tries to commit it. */
        @SendproofPreview
        @PostMapping("/commit-session")
        Map<String, String> commitSession() {
            mongo.insert(new Document("_id", "session-commit"), "docs");
            // The ambient session Spring Data hands to handler code, found where it keeps it.
            com.mongodb.client.ClientSession session;
            try {
                Object holder = org.springframework.transaction.support.TransactionSynchronizationManager
                        .getResource(mongo.getMongoDatabaseFactory());
                var getSession = holder.getClass().getDeclaredMethod("getRequiredSession");
                getSession.setAccessible(true);
                session = (com.mongodb.client.ClientSession) getSession.invoke(holder);
            } catch (ReflectiveOperationException | RuntimeException error) {
                throw new IllegalStateException("The test could not find the ambient session", error);
            }
            try {
                session.commitTransaction();
            } catch (RuntimeException swallowed) {
                // The handler carries on as a careless one would.
            }
            return Map.of("ok", "true");
        }

        @SendproofPreview
        @PostMapping("/out")
        Map<String, String> out() {
            mongo.getCollection("docs").aggregate(List.of(new Document("$out", "archive"))).toCollection();
            return Map.of("ok", "true");
        }

        @SendproofPreview
        @GetMapping("/redis")
        Map<String, String> redisRead() {
            return Map.of("value", String.valueOf(redis.opsForValue().get(PREFIX + "seeded")));
        }

        @SendproofPreview
        @PostMapping("/redis")
        Map<String, Long> redisWrite() {
            return Map.of("value", redis.opsForValue().increment(PREFIX + "written"));
        }
    }

    @Configuration
    @EnableAutoConfiguration
    static class App {
        @Bean
        MongoTransactionManager mongoTransactionManager(MongoDatabaseFactory factory) {
            return new MongoTransactionManager(factory);
        }

        @Bean
        MongoRoutes mongoRoutes(MongoTemplate mongo, MongoTransactionManager transactions, StringRedisTemplate redis) {
            return new MongoRoutes(mongo, transactions, redis);
        }
    }

    @DynamicPropertySource
    static void services(DynamicPropertyRegistry registry) {
        registry.add("spring.data.mongodb.uri", () -> MONGO.replace("/?", "/" + DATABASE + "?"));
        registry.add("spring.data.redis.url", () -> "redis://:bench_redis_local@127.0.0.1:56379");
        registry.add("spring.data.redis.timeout", () -> "2s");
        registry.add("spring.data.redis.lettuce.shutdown-timeout", () -> "0");
    }

    @BeforeAll
    static void probe() {
        try {
            raw = MongoClients.create(MongoClientSettings.builder().applyConnectionString(new ConnectionString(MONGO))
                    .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(2, java.util.concurrent.TimeUnit.SECONDS)).build());
            raw.getDatabase("admin").runCommand(new Document("hello", 1));
            mongoUp = true;
        } catch (RuntimeException unreachable) {
            mongoUp = false;
        }
        try (var socket = new java.net.Socket()) {
            socket.connect(new java.net.InetSocketAddress("127.0.0.1", 56379), 1000);
            redisUp = true;
        } catch (java.io.IOException unreachable) {
            redisUp = false;
        }
    }

    @AfterAll
    static void drop() {
        if (raw != null) {
            if (mongoUp) {
                raw.getDatabase(DATABASE).drop();
            }
            raw.close();
        }
    }

    @Autowired
    MockMvc mvc;

    private MvcResult preview(MockHttpServletRequestBuilder builder) throws Exception {
        return mvc.perform(builder.header("Prefer", "tx=rollback")).andReturn();
    }

    private static JsonNode body(MvcResult result) throws Exception {
        return JSON.readTree(result.getResponse().getContentAsByteArray());
    }

    private long committed(String collection, Object id) {
        return raw.getDatabase(DATABASE).getCollection(collection).countDocuments(new Document("_id", id));
    }

    @Test
    void mongoTemplateJoinsThePreviewTransactionAndNothingCommits() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        MvcResult result = preview(post("/sendproof/_preview/m/insert"));
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode change = body(result).get("changes").get(0);
        assertThat(change.get("store").asText()).isEqualTo("mongodb");
        assertThat(change.get("table").asText()).isEqualTo("docs");
        assertThat(change.get("after").get("password_hash").asText()).isEqualTo("[REDACTED]");
        assertThat(committed("docs", "template")).isZero();
    }

    @Test
    void theApplicationsOwnMongoTransactionParticipatesAndNeverCommits() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        MvcResult result = preview(post("/sendproof/_preview/m/transactional"));
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(result).get("changes").get(0).get("key").get("_id").asText()).isEqualTo("transactional");
        assertThat(committed("docs", "transactional")).isZero();
    }

    @Test
    void aNewTransactionDuringAPreviewIsRefusedAndFailsThePreview() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        MvcResult result = preview(post("/sendproof/_preview/m/requires-new"));
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(result.getResponse().getHeader("Preference-Applied")).isNull();
        assertThat(committed("docs", "requires-new")).isZero();
    }

    @Test
    void handlerCodeNeverHoldsASessionItCanCommit() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        MvcResult result = preview(post("/sendproof/_preview/m/commit-session"));
        assertThat(result.getResponse().getStatus()).isEqualTo(500);
        assertThat(committed("docs", "session-commit")).isZero();
    }

    @Test
    void anOutStageIsBlockedWithItsReason() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        MvcResult result = preview(post("/sendproof/_preview/m/out"));
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(result).get("detail").asText()).contains("$out");
    }

    @Test
    void sendCommitsThroughTheSameGuardedFactory() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        assertThat(mvc.perform(post("/m/insert-sent")).andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(committed("docs", "sent")).isEqualTo(1);
    }

    @Test
    void discoveryListsBothAutomaticStoresWithTheirModes() throws Exception {
        assumeTrue(mongoUp, "MongoDB isn't running: docker compose -f tests/conformance/compose.yml up -d --wait mongodb");
        JsonNode capabilities = JSON.readTree(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getContentAsByteArray());
        Map<String, String> modes = new java.util.HashMap<>();
        capabilities.get("dataStores").forEach(store -> modes.put(store.get("system").asText(), store.get("mode").asText()
                + ":" + store.get("name").asText()));
        assertThat(modes).containsEntry("mongodb", "preview:catalog").containsEntry("redis", "guard:cache");
    }

    @Test
    void theRedisFactoryReturnsGuardedConnections() throws Exception {
        assumeTrue(redisUp, "Redis isn't running: docker compose -f tests/conformance/compose.yml up -d --wait redis");
        MvcResult read = preview(get("/sendproof/_preview/m/redis"));
        assertThat(read.getResponse().getStatus()).isEqualTo(200);
        MvcResult write = preview(post("/sendproof/_preview/m/redis"));
        assertThat(write.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(write).get("operation").asText()).isEqualTo("INCR");
        assertThat(body(write).get("store").asText()).isEqualTo("redis");
    }
}

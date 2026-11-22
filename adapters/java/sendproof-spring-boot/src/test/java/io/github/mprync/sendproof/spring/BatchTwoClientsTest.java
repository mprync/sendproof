package io.github.mprync.sendproof.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.cloud.NoCredentials;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.FirestoreOptions;
import com.sun.net.httpserver.HttpServer;
import io.github.mprync.sendproof.firestore.FirestoreStore;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.elasticsearch.client.Request;
import org.elasticsearch.client.RestClient;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Lazy;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The batch-two client beans an application can inject: Spring Boot's low-level Elasticsearch {@code RestClient} (hooked),
 * a {@code Firestore} bean (replaced by a guarded client), and client beans Sendproof can't guard (Cosmos DB clients,
 * Spring Data Firestore's stub), which make every Preview refused, with the reason in discovery.
 */
class BatchTwoClientsTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MONGO_REDIS = "org.springframework.boot.autoconfigure.mongo.MongoAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.mongo.MongoDataAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.mongo.MongoRepositoriesAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration,"
            + "org.springframework.boot.autoconfigure.data.redis.RedisRepositoriesAutoConfiguration";
    private static final List<String> RECEIVED = Collections.synchronizedList(new ArrayList<>());
    private static HttpServer node;

    @BeforeAll
    static void startNode() throws Exception {
        node = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        node.createContext("/", exchange -> {
            RECEIVED.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            byte[] body = ("{\"took\":1,\"timed_out\":false,\"_shards\":{\"total\":1,\"successful\":1,\"skipped\":0,\"failed\":0},"
                    + "\"hits\":{\"total\":{\"value\":0,\"relation\":\"eq\"},\"hits\":[]}}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.getResponseHeaders().add("X-Elastic-Product", "Elasticsearch");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        node.start();
    }

    @AfterAll
    static void stopNode() {
        node.stop(0);
    }

    private static MvcResult preview(MockMvc mvc, String path) throws Exception {
        return mvc.perform(post("/sendproof/_preview" + path).header("Prefer", "tx=rollback")).andReturn();
    }

    private static JsonNode capabilities(MockMvc mvc) throws Exception {
        return JSON.readTree(mvc.perform(get("/sendproof/_api/capabilities")).andReturn().getResponse().getContentAsByteArray());
    }

    @Configuration
    @EnableAutoConfiguration
    @Import(ElasticsearchApp.Routes.class)
    static class ElasticsearchApp {
        @RestController
        static class Routes {
            private final RestClient rest;
            private final ElasticsearchClient client;

            Routes(RestClient rest, ElasticsearchClient client) {
                this.rest = rest;
                this.client = client;
            }

            @SendproofPreview
            @PostMapping("/raw-delete")
            Map<String, String> rawDelete() throws Exception {
                try {
                    rest.performRequest(new Request("DELETE", "/articles"));
                } catch (RuntimeException refused) {
                    // The handler hides the refusal; the Preview is still blocked.
                }
                return Map.of("ok", "true");
            }

            @SendproofPreview
            @PostMapping("/typed-search")
            Map<String, String> typedSearch() throws Exception {
                client.search(s -> s.index("articles"), Map.class);
                return Map.of("ok", "true");
            }
        }
    }

    @Nested
    @SpringBootTest(classes = ElasticsearchApp.class, properties = {"sendproof.enabled=true", "spring.autoconfigure.exclude=" + MONGO_REDIS})
    @AutoConfigureMockMvc
    class SpringBootsRestClientBean {
        @Autowired
        MockMvc mvc;

        @DynamicPropertySource
        static void node(DynamicPropertyRegistry registry) {
            registry.add("spring.elasticsearch.uris", () -> "http://127.0.0.1:" + node.getAddress().getPort());
        }

        @Test
        void aRawWriteThroughTheInjectedRestClientIsRefusedBeforeItIsSent() throws Exception {
            RECEIVED.clear();
            MvcResult result = preview(mvc, "/raw-delete");
            assertThat(result.getResponse().getStatus()).isEqualTo(409);
            assertThat(result.getResponse().getContentAsString()).contains("\"store\":\"elasticsearch\"");
            assertThat(RECEIVED).isEmpty();
        }

        @Test
        void theTypedClientOnTheSameRestClientStillReads() throws Exception {
            RECEIVED.clear();
            assertThat(preview(mvc, "/typed-search").getResponse().getStatus()).isEqualTo(200);
            assertThat(RECEIVED).containsExactly("POST /articles/_search");
        }
    }

    @Configuration
    @EnableAutoConfiguration
    static class FirestoreApp {
        @Bean(destroyMethod = "close")
        Firestore firestore() {
            return FirestoreOptions.newBuilder().setProjectId("bench").setCredentials(NoCredentials.getInstance())
                    .setHost("localhost:1").build().getService();
        }
    }

    @Nested
    @SpringBootTest(classes = FirestoreApp.class, properties = {"sendproof.enabled=true", "sendproof.stores.firestore.name=orders"})
    @AutoConfigureMockMvc
    class AFirestoreBean {
        @Autowired
        Firestore firestore;
        @Autowired
        MockMvc mvc;

        @Test
        void isReplacedByAGuardedClientAndListedInDiscovery() throws Exception {
            assertThat(FirestoreStore.isGuardedClient(firestore)).isTrue();
            JsonNode capabilities = capabilities(mvc);
            assertThat(capabilities.get("dataStores").toString()).contains("\"system\":\"firestore\"").contains("\"name\":\"orders\"");
            assertThat(capabilities.has("previewUnavailable")).isFalse();
        }
    }

    @Configuration
    @EnableAutoConfiguration
    @Import(Marked.class)
    static class UnguardedCosmosApp {
        @Bean
        io.github.mprync.sendproof.cosmosdb.CosmosStore orders() {
            return io.github.mprync.sendproof.cosmosdb.CosmosStore.builder().name("orders").build();
        }

        /** An unguarded client bean; never created here (it would connect), but any handler could inject it. */
        @Bean
        @Lazy
        com.azure.cosmos.CosmosAsyncClient cosmosAsyncClient() {
            throw new IllegalStateException("not created in this test");
        }
    }

    @RestController
    static class Marked {
        static volatile boolean ran;

        @SendproofPreview
        @PostMapping("/orders")
        Map<String, String> create() {
            ran = true;
            return Map.of("ok", "true");
        }
    }

    @Nested
    @SpringBootTest(classes = UnguardedCosmosApp.class, properties = "sendproof.enabled=true")
    @AutoConfigureMockMvc
    class AnUnguardedCosmosClientBean {
        @Autowired
        MockMvc mvc;

        @Test
        void refusesEveryPreviewWithTheReasonInDiscovery() throws Exception {
            Marked.ran = false;
            MvcResult result = preview(mvc, "/orders");
            assertThat(result.getResponse().getStatus()).isEqualTo(409);
            assertThat(Marked.ran).isFalse();
            JsonNode capabilities = capabilities(mvc);
            assertThat(capabilities.get("previewOperations")).isEmpty();
            JsonNode unavailable = capabilities.get("previewUnavailable").get(0);
            assertThat(unavailable.get("path").asText()).isEqualTo("/orders");
            assertThat(unavailable.get("reason").asText()).contains("Cosmos DB client Sendproof doesn't guard")
                    .contains("cosmosAsyncClient");
            assertThat(unavailable.get("stores").get(0).asText()).isEqualTo("cosmosdb");
            // Send still runs.
            assertThat(mvc.perform(post("/orders")).andReturn().getResponse().getStatus()).isEqualTo(200);
        }
    }

    /**
     * A registered Firestore store with the Firestore hook turned off, so the {@code Firestore} bean stays raw. (Spring Data
     * Firestore's {@code FirestoreGrpc.FirestoreStub} is found the same way, by type, as the Cosmos DB clients above; its
     * artifact isn't on this test class path.)
     */
    @Configuration
    @EnableAutoConfiguration
    @Import(Marked.class)
    static class UnhookedFirestoreApp {
        @Bean
        FirestoreStore orders() {
            return FirestoreStore.builder().name("orders").build();
        }

        @Bean(destroyMethod = "close")
        Firestore firestore() {
            return FirestoreOptions.newBuilder().setProjectId("bench").setCredentials(NoCredentials.getInstance())
                    .setHost("localhost:1").build().getService();
        }
    }

    @Nested
    @SpringBootTest(classes = UnhookedFirestoreApp.class, properties = {"sendproof.enabled=true", "sendproof.stores.firestore.enabled=false"})
    @AutoConfigureMockMvc
    class ARawFirestoreBeanWithTheHookOff {
        @Autowired
        MockMvc mvc;

        @Test
        void refusesEveryPreview() throws Exception {
            Marked.ran = false;
            assertThat(preview(mvc, "/orders").getResponse().getStatus()).isEqualTo(409);
            assertThat(Marked.ran).isFalse();
            assertThat(capabilities(mvc).get("previewUnavailable").get(0).get("reason").asText())
                    .contains("Firestore client Sendproof doesn't guard").contains("'firestore'");
        }
    }
}

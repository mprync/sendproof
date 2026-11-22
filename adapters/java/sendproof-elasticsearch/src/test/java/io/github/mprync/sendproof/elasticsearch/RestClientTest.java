package io.github.mprync.sendproof.elasticsearch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.json.jackson.JacksonJsonpMapper;
import co.elastic.clients.transport.rest_client.RestClientTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.apache.http.HttpHost;
import org.elasticsearch.client.Request;
import org.elasticsearch.client.RestClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The low-level {@code RestClient} (Spring Boot makes one a bean, and builds the typed client's transport on it). Hooked
 * with {@link ElasticsearchStore#hook}, a raw write through it is refused before it is sent, while the typed client's
 * requests, already checked by the guarded transport, pass it once and are logged once.
 */
class RestClientTest {
    private static final String REPLY = "{\"_index\":\"articles\",\"_id\":\"1\",\"_version\":1,\"result\":\"created\","
            + "\"_shards\":{\"total\":1,\"successful\":1,\"failed\":0},\"_seq_no\":0,\"_primary_term\":1,"
            + "\"took\":1,\"timed_out\":false,\"hits\":{\"total\":{\"value\":0,\"relation\":\"eq\"},\"hits\":[]}}";

    private final ElasticsearchStore store = ElasticsearchStore.builder().name("articles").build();
    private final List<String> received = Collections.synchronizedList(new ArrayList<>());
    private HttpServer server;
    private RestClient rest;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            received.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            byte[] body = REPLY.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.getResponseHeaders().add("X-Elastic-Product", "Elasticsearch");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        rest = RestClient.builder(new HttpHost("127.0.0.1", server.getAddress().getPort()))
                .setHttpClientConfigCallback(builder -> {
                    store.hook(builder);
                    return builder;
                }).build();
    }

    @AfterEach
    void stop() throws Exception {
        rest.close();
        server.stop(0);
    }

    @Test
    void aRawWriteThroughTheLowLevelClientIsRefusedBeforeItIsSentAndReadsRun() throws Exception {
        PreviewOutcome outcome = Harness.preview(store, () -> {
            rest.performRequest(new Request("GET", "/articles/_doc/1"));
            assertThatThrownBy(() -> rest.performRequest(new Request("DELETE", "/articles")))
                    .satisfiesAnyOf(error -> assertThat(error).isInstanceOf(PreviewWriteBlockedException.class),
                            error -> assertThat(error).hasRootCauseInstanceOf(PreviewWriteBlockedException.class));
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(new String(outcome.problem())).contains("\"store\":\"elasticsearch\"");
        assertThat(received).containsExactly("GET /articles/_doc/1");
        // Outside a Preview the raw client writes as usual.
        rest.performRequest(new Request("DELETE", "/articles"));
        assertThat(received).hasSize(2);
    }

    @Test
    void theTypedClientOnTheHookedRestClientIsCheckedAndLoggedOnce() throws Exception {
        ElasticsearchClient client = store.client(new RestClientTransport(rest, new JacksonJsonpMapper()));
        PreviewOutcome read = Harness.preview(store, () -> client.search(s -> s.index("articles"), Map.class));
        JsonNode envelope = Harness.envelope(read);
        assertThat(envelope.get("logs")).hasSize(1);
        PreviewOutcome write = Harness.preview(store, () -> assertThatThrownBy(() -> client.index(i -> i.index("articles").id("1")
                .document(Map.of("a", 1)))).isInstanceOf(PreviewWriteBlockedException.class));
        assertThat(write.blocked()).isTrue();
        assertThat(received).containsExactly("POST /articles/_search");
        // Outside a Preview the typed write passes the hook: the transport already checked it.
        client.index(i -> i.index("articles").id("1").document(Map.of("a", 1)));
        assertThat(received).hasSize(2);
    }
}

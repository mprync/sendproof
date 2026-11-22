package io.github.mprync.sendproof.elasticsearch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.hc.core5.http.HttpHost;
import org.junit.jupiter.api.Test;
import org.opensearch.client.json.jackson.JacksonJsonpMapper;
import org.opensearch.client.opensearch.OpenSearchClient;
import org.opensearch.client.transport.OpenSearchTransport;
import org.opensearch.client.transport.httpclient5.ApacheHttpClient5TransportBuilder;

/**
 * The refusal happens in the guarded transport, above the client's connection pool and retry logic, so a refused write is
 * never an HTTP failure the pool could count against a node. With two real nodes behind the real transport, a refused write
 * sends nothing to either, and the reads that follow are still served by both (neither was taken out of rotation).
 */
class TwoNodeTest {
    private static final String EMPTY_SEARCH = "{\"took\":1,\"timed_out\":false,\"_shards\":{\"total\":1,\"successful\":1,\"skipped\":0,"
            + "\"failed\":0},\"hits\":{\"total\":{\"value\":0,\"relation\":\"eq\"},\"hits\":[]}}";

    /** A node that answers every request with an empty search result and counts what it got. */
    private static HttpServer node(AtomicInteger requests) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            requests.incrementAndGet();
            byte[] body = EMPTY_SEARCH.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        return server;
    }

    @Test
    void aRefusedWriteNeverReachesEitherNodeAndTheNextReadsStillUseBoth() throws Exception {
        var first = new AtomicInteger();
        var second = new AtomicInteger();
        HttpServer a = node(first);
        HttpServer b = node(second);
        OpenSearchStore store = OpenSearchStore.builder().build();
        OpenSearchTransport transport = ApacheHttpClient5TransportBuilder.builder(
                new HttpHost("http", "127.0.0.1", a.getAddress().getPort()), new HttpHost("http", "127.0.0.1", b.getAddress().getPort()))
                .setMapper(new JacksonJsonpMapper()).build();
        try {
            OpenSearchClient client = store.client(transport);
            PreviewOutcome outcome = Harness.preview(store, () -> {
                for (int i = 0; i < 6; i++) {
                    assertThatThrownBy(() -> client.index(request -> request.index("articles").document(Map.of("a", 1))))
                            .isInstanceOf(PreviewWriteBlockedException.class);
                }
            });
            assertThat(outcome.blocked()).isTrue();
            assertThat(first.get() + second.get()).as("a refused write sends nothing to any node").isZero();

            for (int i = 0; i < 8; i++) {
                client.search(search -> search.index("articles"), Map.class);
            }
            assertThat(first.get()).as("node one is still in rotation").isPositive();
            assertThat(second.get()).as("node two is still in rotation").isPositive();
            assertThat(first.get() + second.get()).isEqualTo(8);
        } finally {
            transport.close();
            a.stop(0);
            b.stop(0);
        }
    }
}

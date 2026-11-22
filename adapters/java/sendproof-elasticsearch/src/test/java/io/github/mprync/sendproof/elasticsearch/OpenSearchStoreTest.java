package io.github.mprync.sendproof.elasticsearch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import org.apache.hc.core5.http.HttpHost;
import org.junit.jupiter.api.Test;
import org.opensearch.client.json.JsonpMapper;
import org.opensearch.client.json.jackson.JacksonJsonpMapper;
import org.opensearch.client.opensearch.OpenSearchAsyncClient;
import org.opensearch.client.opensearch.OpenSearchClient;
import org.opensearch.client.opensearch.core.bulk.BulkOperation;
import org.opensearch.client.opensearch.generic.Requests;
import org.opensearch.client.transport.Endpoint;
import org.opensearch.client.transport.OpenSearchTransport;
import org.opensearch.client.transport.TransportOptions;
import org.opensearch.client.transport.httpclient5.ApacheHttpClient5TransportBuilder;

/**
 * The OpenSearch guard through the typed {@code opensearch-java} client: over a recording transport for what would reach
 * the wire, and against the compose {@code opensearch} service ({@code docker compose -f tests/conformance/compose.yml
 * --profile heavy-stores up -d --wait opensearch}), which skips when it isn't up.
 */
class OpenSearchStoreTest {
    private static final String SERVER = System.getenv().getOrDefault("BENCH_OPENSEARCH_SERVER_URL", "http://127.0.0.1:59200");

    private final OpenSearchStore store = OpenSearchStore.builder().name("articles").build();
    private final List<String> sent = Collections.synchronizedList(new ArrayList<>());
    private final OpenSearchTransport raw = new Recording(sent);
    private final OpenSearchClient client = store.client(raw);

    /** A transport that records "METHOD path" and answers nothing. */
    private record Recording(List<String> sent) implements OpenSearchTransport {
        private static final JsonpMapper MAPPER = new JacksonJsonpMapper();

        @Override
        public <Q, S, E> S performRequest(Q request, Endpoint<Q, S, E> endpoint, TransportOptions options) {
            sent.add(endpoint.method(request) + " " + endpoint.requestUrl(request));
            return null;
        }

        @Override
        public <Q, S, E> CompletableFuture<S> performRequestAsync(Q request, Endpoint<Q, S, E> endpoint, TransportOptions options) {
            sent.add(endpoint.method(request) + " " + endpoint.requestUrl(request));
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public JsonpMapper jsonpMapper() {
            return MAPPER;
        }

        @Override
        public TransportOptions options() {
            return TransportOptions.builder().build();
        }

        @Override
        public void close() {
        }
    }

    private static void swallow(Harness.Handler work) {
        try {
            work.run();
        } catch (Exception refused) {
            // The handler catches the refusal and returns normally.
        }
    }

    @Test
    void aPostSearchRunsAndIsLoggedWithoutItsValues() throws Exception {
        JsonNode envelope = Harness.envelope(Harness.preview(store, () ->
                client.search(s -> s.index("articles").query(q -> q.term(t -> t.field("title").value(v -> v.stringValue("seeded-secret")))), Map.class)));
        JsonNode db = envelope.get("logs").get(0).get("db");
        assertThat(db.get("system").asText()).isEqualTo("opensearch");
        assertThat(db.get("operation").asText()).isEqualTo("search");
        assertThat(db.get("target").asText()).isEqualTo("articles");
        assertThat(db.get("statement").asText()).contains("title").doesNotContain("seeded-secret");
        assertThat(sent).containsExactly("POST /articles/_search");
    }

    @Test
    void everyWriteEndpointIsRefusedBeforeItIsSent() throws Exception {
        Map<String, Harness.Handler> writes = new java.util.LinkedHashMap<>();
        writes.put("index", () -> client.index(i -> i.index("articles").id("1").document(Map.of("title", "x"))));
        writes.put("update", () -> client.update(u -> u.index("articles").id("1").doc(Map.of("title", "y")), Map.class));
        writes.put("delete", () -> client.delete(d -> d.index("articles").id("1")));
        writes.put("bulk", () -> client.bulk(b -> b.operations(BulkOperation.of(o -> o.index(i -> i.index("articles").document(Map.of("a", 1)))))));
        writes.put("update_by_query", () -> client.updateByQuery(u -> u.index("articles").query(q -> q.matchNone(m -> m))));
        writes.put("delete_by_query", () -> client.deleteByQuery(d -> d.index("articles").query(q -> q.matchAll(m -> m))));
        writes.put("indices.create", () -> client.indices().create(c -> c.index("articles")));
        for (var write : writes.entrySet()) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(write.getValue()));
            assertThat(outcome.blocked()).as(write.getKey()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"store\":\"opensearch\"").contains("\"operation\":\"" + write.getKey() + "\"")
                    .contains("Preview unavailable: this operation writes to OpenSearch");
        }
        assertThat(sent).isEmpty();
    }

    @Test
    void theGenericClientsSqlEndpointIsAReadOnlyForOneSelect() throws Exception {
        var json = Requests.builder().method("POST").endpoint("/_plugins/_sql");
        assertThat(Harness.preview(store, () -> client.generic().execute(
                json.json("{\"query\":\"SELECT title FROM articles\"}").build())).confirmed()).isTrue();
        for (String body : List.of("{\"query\":\"DELETE FROM articles WHERE views = 0\"}", "{\"query\":\"SELECT 1; DELETE FROM articles\"}", "not json")) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> client.generic().execute(
                    Requests.builder().method("POST").endpoint("/_plugins/_sql").json(body).build())));
            assertThat(outcome.blocked()).as(body).isTrue();
            assertThat(new String(outcome.problem())).contains("\"operation\":\"sql.query\"");
        }
        assertThat(sent).containsExactly("POST /_plugins/_sql");
    }

    @Test
    void aDerivedClientAndAnAsyncWriteStayGuarded() throws Exception {
        OpenSearchClient derived = client.withTransportOptions(TransportOptions.builder().build());
        OpenSearchAsyncClient async = store.asyncClient(raw);
        PreviewOutcome outcome = Harness.preview(store, () -> {
            swallow(() -> derived.index(i -> i.index("articles").document(Map.of("a", 1))));
            assertThatThrownBy(() -> async.index(i -> i.index("articles").document(Map.of("a", 1))).get())
                    .isInstanceOf(ExecutionException.class).hasCauseInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(OpenSearchStore.isGuarded(derived._transport())).isTrue();
        assertThat(store.transport(derived._transport())).isSameAs(derived._transport());
        assertThat(sent).isEmpty();
    }

    @Test
    void writesRunOutsideAPreviewAndTheChecksFailWithoutTheHook() throws Exception {
        client.index(i -> i.index("articles").id("sent").document(Map.of("a", 1)));
        OpenSearchClient unhooked = new OpenSearchClient(raw);
        PreviewOutcome outcome = Harness.preview(store, () -> unhooked.index(i -> i.index("articles").id("x").document(Map.of("a", 1))));
        assertThat(outcome.blocked()).isFalse();
        assertThat(sent).hasSize(2);
    }

    @Test
    void againstARealOpenSearchAReadRunsAndABlockedWriteLeavesNothing() throws Exception {
        String index = "sp_" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        HttpHost host = HttpHost.create(SERVER);
        OpenSearchTransport transport = ApacheHttpClient5TransportBuilder.builder(host).setMapper(new JacksonJsonpMapper()).build();
        OpenSearchClient rawClient = new OpenSearchClient(transport);
        try {
            rawClient.indices().create(c -> c.index(index));
        } catch (Exception unreachable) {
            assumeTrue(false, "OpenSearch isn't running: docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait opensearch");
        }
        try {
            rawClient.index(i -> i.index(index).id("seeded").document(Map.of("title", "Seeded", "views", 3)).refresh(org.opensearch.client.opensearch._types.Refresh.True));
            OpenSearchClient guarded = store.client(transport);
            PreviewOutcome read = Harness.preview(store, () -> assertThat(guarded.search(s -> s.index(index)
                    .query(q -> q.ids(ids -> ids.values("seeded"))).size(1), Map.class).hits().hits()).hasSize(1));
            assertThat(read.confirmed()).isTrue();
            PreviewOutcome write = Harness.preview(store, () -> {
                swallow(() -> guarded.index(i -> i.index(index).id("blocked").document(Map.of("title", "x"))));
                swallow(() -> guarded.updateByQuery(u -> u.index(index).query(q -> q.ids(ids -> ids.values("seeded")))
                        .script(s -> s.inline(inline -> inline.source("ctx._source.hidden = true")))));
            });
            assertThat(write.blocked()).isTrue();
            assertThat(rawClient.exists(e -> e.index(index).id("blocked")).value()).isFalse();
            assertThat(rawClient.get(g -> g.index(index).id("seeded"), Map.class).source()).doesNotContainKey("hidden");
            guarded.index(i -> i.index(index).id("sent").document(Map.of("title", "Sent")).refresh(org.opensearch.client.opensearch._types.Refresh.True));
            assertThat(rawClient.exists(e -> e.index(index).id("sent")).value()).isTrue();
        } finally {
            try {
                rawClient.indices().delete(d -> d.index(index));
            } finally {
                transport.close();
            }
        }
    }
}

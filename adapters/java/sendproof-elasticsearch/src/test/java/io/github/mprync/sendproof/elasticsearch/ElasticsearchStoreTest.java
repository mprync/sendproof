package io.github.mprync.sendproof.elasticsearch;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import co.elastic.clients.elasticsearch.ElasticsearchAsyncClient;
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch.core.bulk.BulkOperation;
import co.elastic.clients.json.JsonpMapper;
import co.elastic.clients.json.jackson.JacksonJsonpMapper;
import co.elastic.clients.transport.ElasticsearchTransport;
import co.elastic.clients.transport.Endpoint;
import co.elastic.clients.transport.DefaultTransportOptions;
import co.elastic.clients.transport.TransportOptions;
import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.PreviewOutcome;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.Test;

/**
 * The Elasticsearch guard through the typed {@code elasticsearch-java} client over a recording transport, which says
 * exactly which requests would have reached the wire.
 */
class ElasticsearchStoreTest {
    private final ElasticsearchStore store = ElasticsearchStore.builder().name("articles").build();
    private final List<String> sent = Collections.synchronizedList(new ArrayList<>());
    private final ElasticsearchTransport raw = new Recording(sent);
    private final ElasticsearchClient client = store.client(raw);

    /** A transport that records "METHOD path" and answers nothing. */
    private record Recording(List<String> sent) implements ElasticsearchTransport {
        private final static JsonpMapper MAPPER = new JacksonJsonpMapper();

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
            return DefaultTransportOptions.EMPTY;
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
                client.search(s -> s.index("articles").query(q -> q.term(t -> t.field("title").value("seeded-secret"))), Map.class)));
        JsonNode db = envelope.get("logs").get(0).get("db");
        assertThat(db.get("system").asText()).isEqualTo("elasticsearch");
        assertThat(db.get("operation").asText()).isEqualTo("search");
        assertThat(db.get("target").asText()).isEqualTo("articles");
        assertThat(db.get("statement").asText()).contains("title").doesNotContain("seeded-secret");
        assertThat(envelope.toString()).doesNotContain("seeded-secret");
        assertThat(sent).containsExactly("POST /articles/_search");
    }

    @Test
    void aGetRunsAsARead() throws Exception {
        assertThat(Harness.preview(store, () -> client.get(g -> g.index("articles").id("1"), Map.class)).confirmed()).isTrue();
        assertThat(sent).containsExactly("GET /articles/_doc/1");
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
        writes.put("reindex", () -> client.reindex(r -> r.source(s -> s.index("a")).dest(d -> d.index("b"))));
        writes.put("indices.create", () -> client.indices().create(c -> c.index("articles")));
        writes.put("indices.delete", () -> client.indices().delete(d -> d.index("articles")));
        for (var write : writes.entrySet()) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(write.getValue()));
            assertThat(outcome.blocked()).as(write.getKey()).isTrue();
            assertThat(new String(outcome.problem())).contains("\"store\":\"elasticsearch\"").contains("\"operation\":\"" + write.getKey() + "\"")
                    .contains("Preview unavailable: this operation writes to Elasticsearch");
        }
        assertThat(sent).isEmpty();
    }

    @Test
    void theRefusalReachesTheHandlerAsThePreviewException() throws Exception {
        Harness.preview(store, () -> assertThatThrownBy(() -> client.delete(d -> d.index("articles").id("1")))
                .isInstanceOf(PreviewWriteBlockedException.class));
    }

    @Test
    void sqlIsAReadOnlyForOneSelectStatement() throws Exception {
        assertThat(Harness.preview(store, () -> client.sql().query(q -> q.query("SELECT title FROM articles"))).confirmed()).isTrue();
        for (String text : List.of("DELETE FROM articles", "SELECT 1; DELETE FROM articles")) {
            PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> client.sql().query(q -> q.query(text))));
            assertThat(outcome.blocked()).as(text).isTrue();
        }
        assertThat(sent).containsExactly("POST /_sql");
    }

    @Test
    void aDerivedClientStaysGuarded() throws Exception {
        ElasticsearchClient derived = client.withTransportOptions(DefaultTransportOptions.EMPTY);
        PreviewOutcome outcome = Harness.preview(store, () -> swallow(() -> derived.index(i -> i.index("articles").document(Map.of("a", 1)))));
        assertThat(outcome.blocked()).isTrue();
        assertThat(store.transport(derived._transport())).isSameAs(derived._transport());
        assertThat(ElasticsearchStore.isGuarded(derived._transport())).isTrue();
        assertThat(sent).isEmpty();
    }

    @Test
    void anAsyncWriteIsAFailedFutureAndStillMarksThePreview() throws Exception {
        ElasticsearchAsyncClient async = store.asyncClient(raw);
        PreviewOutcome outcome = Harness.preview(store, () -> {
            assertThat(async.get(g -> g.index("articles").id("1"), Map.class).get()).isNull();
            assertThatThrownBy(() -> async.index(i -> i.index("articles").document(Map.of("a", 1))).get())
                    .isInstanceOf(ExecutionException.class).hasCauseInstanceOf(PreviewWriteBlockedException.class);
        });
        assertThat(outcome.blocked()).isTrue();
        assertThat(sent).containsExactly("GET /articles/_doc/1");
    }

    @Test
    void writesRunOutsideAPreviewAndTheChecksFailWithoutTheHook() throws Exception {
        client.index(i -> i.index("articles").id("sent").document(Map.of("a", 1)));
        ElasticsearchClient unhooked = new ElasticsearchClient(raw);
        PreviewOutcome outcome = Harness.preview(store, () -> unhooked.index(i -> i.index("articles").id("x").document(Map.of("a", 1))));
        assertThat(outcome.blocked()).isFalse();
        assertThat(sent).hasSize(2);
    }

    @Test
    void hostDeclaredReadsPassAndDescribeReportsGuardMode() throws Exception {
        ElasticsearchStore lenient = ElasticsearchStore.builder().treatAsRead("index").build();
        ElasticsearchClient mine = lenient.client(raw);
        assertThat(Harness.preview(lenient, () -> mine.index(i -> i.index("articles").document(Map.of("a", 1)))).confirmed()).isTrue();
        assertThat(store.describe().mode()).isEqualTo("guard");
        assertThat(store.describe().system()).isEqualTo("elasticsearch");
        assertThat(store.describe().name()).isEqualTo("articles");
    }
}

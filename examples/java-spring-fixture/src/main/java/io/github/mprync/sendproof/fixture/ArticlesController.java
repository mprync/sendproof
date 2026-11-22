package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.LinkedHashMap;
import java.util.Map;
import org.opensearch.client.json.JsonData;
import org.opensearch.client.opensearch.OpenSearchClient;
import org.opensearch.client.opensearch._types.Refresh;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The OpenSearch routes of the fixture contract, through the typed client over the (guarded) transport bean. */
@RestController
@RequestMapping("/articles")
@ConditionalOnProperty("bench.opensearch.url")
public class ArticlesController {
    private final OpenSearchClient client;
    private final String index;

    public ArticlesController(OpenSearchClient client, @Value("${bench.opensearch.index}") String index) {
        this.client = client;
        this.index = index;
    }

    private static Map<String, Object> view(String id, Map<?, ?> source) {
        var view = new LinkedHashMap<String, Object>();
        view.put("id", id);
        view.put("title", source.get("title"));
        view.put("views", ((Number) source.get("views")).intValue());
        return view;
    }

    /** A read sent as a POST to {@code _search}. */
    @SendproofPreview
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String id) throws java.io.IOException {
        var hits = client.search(s -> s.index(index).query(q -> q.ids(ids -> ids.values(id))).size(1), Map.class).hits().hits();
        return hits.isEmpty() ? ResponseEntity.notFound().build() : ResponseEntity.ok(view(id, hits.get(0).source()));
    }

    @SendproofPreview
    @PostMapping("/{id}/touch")
    public Map<String, Object> touch(@PathVariable String id) throws java.io.IOException {
        return touchArticle(id);
    }

    /** Shared with the mixed SQL and store route. */
    Map<String, Object> touchArticle(String id) throws java.io.IOException {
        var reply = client.update(u -> u.index(index).id(id).refresh(Refresh.True)
                .script(s -> s.inline(i -> i.source("ctx._source.views += params.step").params("step", JsonData.of(1))))
                .upsert(Map.of("title", "Untitled", "views", 1)).source(c -> c.fetch(true)), Map.class);
        return view(id, reply.get().source());
    }

    /** {@code _update_by_query} is a POST with a query, like a search: the store error is swallowed to 404 on purpose. */
    @SendproofPreview
    @PostMapping("/{id}/hide")
    public ResponseEntity<Map<String, Object>> hide(@PathVariable String id) {
        try {
            var reply = client.updateByQuery(u -> u.index(index).refresh(true).query(q -> q.ids(ids -> ids.values(id)))
                    .script(s -> s.inline(i -> i.source("ctx._source.hidden = true"))));
            return reply.updated() != null && reply.updated() > 0 ? ResponseEntity.ok(Map.of("id", id, "hidden", true))
                    : ResponseEntity.notFound().build();
        } catch (Exception failure) {
            return ResponseEntity.notFound().build();
        }
    }

    @SendproofPreview(enabled = false, stores = "opensearch")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) throws java.io.IOException {
        client.delete(d -> d.index(index).id(id).refresh(Refresh.True));
        return ResponseEntity.noContent().build();
    }
}

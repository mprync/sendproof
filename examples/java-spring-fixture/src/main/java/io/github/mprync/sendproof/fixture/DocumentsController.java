package io.github.mprync.sendproof.fixture;

import io.github.mprync.sendproof.spring.SendproofPreview;
import java.util.List;
import java.util.Map;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The MongoDB routes of the fixture contract, through Spring Data's {@code MongoTemplate}. The handlers use no
 * transaction annotation: Sendproof's Preview binds its transaction to the thread, and the template joins it.
 */
@RestController
@RequestMapping("/documents")
@ConditionalOnProperty("bench.mongodb.url")
public class DocumentsController {
    private static final Logger LOG = LoggerFactory.getLogger(DocumentsController.class);
    private static final String COLLECTION = "documents";

    private final MongoTemplate mongo;

    public DocumentsController(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    private static Map<String, Object> view(Document document) {
        Document profile = document.get("profile", Document.class);
        return Map.of("id", document.get("_id"), "name", document.getString("name"),
                "city", profile == null ? "" : profile.getString("city"));
    }

    @SendproofPreview
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String id) {
        Document document = mongo.findById(id, Document.class, COLLECTION);
        return document == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(view(document));
    }

    @SendproofPreview
    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody Map<String, String> body) {
        Document document = new Document("_id", body.get("id")).append("name", body.get("name"))
                .append("profile", new Document("city", body.get("city")))
                .append("password_hash", "hashed:" + body.get("password"));
        mongo.insert(document, COLLECTION);
        LOG.info("created-document:{}", body.get("id"));
        return ResponseEntity.status(HttpStatus.CREATED).body(view(document));
    }

    @SendproofPreview
    @PatchMapping("/{id}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable String id, @RequestBody Map<String, String> body) {
        Update update = new Update();
        if (body.containsKey("name")) {
            update.set("name", body.get("name"));
        }
        if (body.containsKey("city")) {
            update.set("profile.city", body.get("city"));
        }
        if (update.getUpdateObject().isEmpty() || mongo.updateFirst(Query.query(Criteria.where("_id").is(id)), update, COLLECTION)
                .getMatchedCount() == 0) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(view(mongo.findById(id, Document.class, COLLECTION)));
    }

    /** {@code $out} can't run inside a transaction: the binding blocks it before sending. */
    @SendproofPreview
    @PostMapping("/archive")
    public ResponseEntity<Void> archive() {
        mongo.getCollection(COLLECTION).aggregate(List.of(new Document("$match", new Document()),
                new Document("$out", "documents_archive"))).toCollection();
        return ResponseEntity.noContent().build();
    }

    @SendproofPreview(enabled = false, stores = "mongodb")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        mongo.remove(Query.query(Criteria.where("_id").is(id)), COLLECTION);
        return ResponseEntity.noContent().build();
    }
}

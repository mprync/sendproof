package io.github.mprync.sendproof.core.stores;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The classifiers against the shared vectors in {@code spec/data-stores/classification-cases.json}, and the tables. */
class StoreClassifierTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path SPEC = Path.of(System.getProperty("sendproof.spec.dir"), "data-stores");

    private static JsonNode spec(String file) throws IOException {
        return JSON.readTree(Files.readString(SPEC.resolve(file)));
    }

    /** Converts to ordered maps and lists, the shape the classifiers walk. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(JsonNode node) {
        return JSON.convertValue(node, LinkedHashMap.class);
    }

    @Test
    void embeddedTablesMatchSpecDataStores() throws IOException {
        // Refresh the copies with `gradle :sendproof-core:syncStoreTables` when this fails.
        for (String store : List.of("redis", "mongodb", "dynamodb", "cassandra", "elasticsearch", "cosmosdb", "firestore")) {
            assertThat(StoreTables.raw(store)).as("embedded %s table", store).isEqualTo(spec(store + ".json"));
        }
    }

    private static String lower(CommandKind kind) {
        return kind.name().toLowerCase(Locale.ROOT);
    }

    /** Every batch-two case: the kind and the {@code db.operation.name} must both match. */
    @Test
    void theBatchTwoClassifiersPassEverySharedVector() throws IOException {
        JsonNode cases = spec("classification-cases.json");
        int count = 0;
        for (JsonNode item : cases.get("cassandra")) {
            StoreClassifier.Classified result;
            if (item.has("message")) {
                result = StoreClassifier.cassandraMessage(item.get("message").asText(),
                        item.has("statement") ? item.get("statement").asText() : null,
                        item.has("prepared") ? item.get("prepared").asText() : null, null);
            } else {
                result = StoreClassifier.cassandra(item.get("statement").asText(), null);
            }
            assertThat(lower(result.kind())).as(item.toString()).isEqualTo(item.get("expect").asText());
            assertThat(result.operation()).as(item.toString()).isEqualTo(item.get("operation").asText());
            count++;
        }
        for (JsonNode item : cases.get("elasticsearch")) {
            Object body = item.has("body") ? (item.get("body").isTextual() ? item.get("body").asText() : item.get("body")) : null;
            var result = StoreClassifier.search(item.get("method").asText(), item.get("path").asText(), body, null);
            assertThat(lower(result.kind())).as(item.toString()).isEqualTo(item.get("expect").asText());
            assertThat(result.operation()).as(item.toString()).isEqualTo(item.get("operation").asText());
            count++;
        }
        for (JsonNode item : cases.get("cosmosdb")) {
            StoreClassifier.Classified result;
            if (item.has("request")) {
                JsonNode request = item.get("request");
                result = StoreClassifier.cosmosRequest(request.get("method").asText(), request.get("path").asText(),
                        map(request.get("headers")), null);
            } else {
                result = StoreClassifier.cosmos(item.get("operationType").asText(),
                        item.has("triggers") && item.get("triggers").asBoolean(), null);
            }
            assertThat(lower(result.kind())).as(item.toString()).isEqualTo(item.get("expect").asText());
            assertThat(result.operation()).as(item.toString()).isEqualTo(item.get("operation").asText());
            count++;
        }
        for (JsonNode item : cases.get("firestore")) {
            StoreClassifier.Classified result;
            if (item.has("rest")) {
                JsonNode rest = item.get("rest");
                result = StoreClassifier.firestoreRest(rest.get("method").asText(), rest.get("path").asText(),
                        rest.has("body") ? map(rest.get("body")) : null, null);
            } else {
                result = StoreClassifier.firestore(item.get("rpc").asText(), item.has("message") ? map(item.get("message")) : null, null);
            }
            assertThat(lower(result.kind())).as(item.toString()).isEqualTo(item.get("expect").asText());
            assertThat(result.operation()).as(item.toString()).isEqualTo(item.get("operation").asText());
            count++;
        }
        assertThat(count).isEqualTo(cases.get("cassandra").size() + cases.get("elasticsearch").size()
                + cases.get("cosmosdb").size() + cases.get("firestore").size());
    }

    @Test
    void hostDeclaredReadsReachBatchTwoWritesButNeverBatchesOrTriggeredCalls() {
        assertThat(StoreClassifier.cassandra("MYSTMT x", Set.of("MYSTMT")).kind()).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.cassandra("BEGIN BATCH APPLY BATCH", Set.of("BATCH")).kind()).isEqualTo(CommandKind.WRITE);
        assertThat(StoreClassifier.cassandra("MYSTMT x; DROP TABLE t", Set.of("MYSTMT")).kind()).isEqualTo(CommandKind.WRITE);
        assertThat(StoreClassifier.search("POST", "/_x/_future", null, Set.of("POST /_x/_future")).kind()).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.cosmos("Execute", false, Set.of("Execute")).kind()).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.cosmos("Execute", true, Set.of("Execute")).kind()).isEqualTo(CommandKind.WRITE);
        assertThat(StoreClassifier.firestore("/google.firestore.v1.Firestore/Future", (Integer) null, Set.of("Future")).kind())
                .isEqualTo(CommandKind.READ);
    }

    @Test
    void theClassifiersPassEverySharedVector() throws IOException {
        JsonNode cases = spec("classification-cases.json");
        int count = 0;
        for (JsonNode item : cases.get("redis")) {
            List<String> command = new ArrayList<>();
            item.get("command").forEach(part -> command.add(part.asText()));
            CommandKind kind = StoreClassifier.redis(command.get(0), command.subList(1, command.size()), null);
            assertThat(kind.name().toLowerCase(Locale.ROOT)).as(command.get(0)).isEqualTo(item.get("expect").asText());
            count++;
        }
        for (JsonNode item : cases.get("mongodb")) {
            var result = StoreClassifier.mongo(map(item.get("command")), null);
            assertThat(result.kind().name().toLowerCase(Locale.ROOT)).as(item.get("command").toString())
                    .isEqualTo(item.get("expect").asText());
            String refused = item.has("refusedInTransaction") ? item.get("refusedInTransaction").asText() : null;
            assertThat(result.refusedInTransaction()).as(item.get("command").toString()).isEqualTo(refused);
            count++;
        }
        for (JsonNode item : cases.get("dynamodb")) {
            var kind = StoreClassifier.dynamo(item.get("operation").asText(), map(item.get("input")), null);
            assertThat(kind.name().toLowerCase(Locale.ROOT)).as(item.get("operation") + " " + item.get("input"))
                    .isEqualTo(item.get("expect").asText());
            count++;
        }
        assertThat(count).isEqualTo(cases.get("redis").size() + cases.get("mongodb").size() + cases.get("dynamodb").size());
    }

    @Test
    void hostDeclaredReadsMatchExactNamesOnly() {
        Set<String> reads = Set.of("MYMODULE.GET");
        assertThat(StoreClassifier.redis("mymodule.get", List.of("k"), reads)).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.redis("MYMODULE.GETALL", List.of("k"), reads)).isEqualTo(CommandKind.WRITE);
        assertThat(StoreClassifier.mongo(Map.of("customRead", 1), Set.of("customread")).kind()).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.dynamo("GetThing", List.of(), Set.of("GetThing"))).isEqualTo(CommandKind.READ);
        assertThat(StoreClassifier.dynamo("GetThings", List.of(), Set.of("GetThing"))).isEqualTo(CommandKind.WRITE);
    }

    @Test
    void aWritingStageIsFoundAtAnyDepth() {
        var inner = Map.of("$lookup", Map.of("from", "x", "pipeline", List.of(Map.of("$merge", Map.of("into", "y")))));
        var command = new LinkedHashMap<String, Object>();
        command.put("aggregate", "c");
        command.put("pipeline", List.of(Map.of("$facet", Map.of("a", List.of(inner)))));
        var result = StoreClassifier.mongo(command, null);
        assertThat(result.kind()).isEqualTo(CommandKind.WRITE);
        assertThat(result.refusedInTransaction()).isEqualTo("$merge");
    }

    @Test
    void partiqlSkipsCommentsAndSanitizesLiterals() {
        assertThat(Partiql.verb("  -- c\n/* b */ select * from t")).isEqualTo("SELECT");
        assertThat(Partiql.verb("/* unterminated SELECT")).isEmpty();
        assertThat(Partiql.sanitize("UPDATE \"orders\" SET status = 'it''s', n = 12.5, m = 3 WHERE id = ? AND a1 = 7"))
                .isEqualTo("UPDATE \"orders\" SET status = ?, n = ?, m = ? WHERE id = ? AND a1 = ?");
        assertThat(Partiql.sanitize("SELECT \"a'b\" FROM \"t1\" WHERE x = 'v'")).isEqualTo("SELECT \"a'b\" FROM \"t1\" WHERE x = ?");
    }

    @Test
    void redactionReachesEveryDepthAndSanitizingKeepsOnlyNames() throws IOException {
        JsonNode redacted = StoreRedaction.redactDeep(JSON.readTree(
                "{\"name\":\"a\",\"profile\":{\"apiKey\":\"k\",\"city\":\"York\"},\"list\":[{\"password_hash\":\"h\"}],\"idempotency_key\":\"i\"}"));
        assertThat(redacted).isEqualTo(JSON.readTree(
                "{\"name\":\"a\",\"profile\":{\"apiKey\":\"[REDACTED]\",\"city\":\"York\"},\"list\":[{\"password_hash\":\"[REDACTED]\"}],\"idempotency_key\":\"i\"}"));
        var update = new LinkedHashMap<String, Object>();
        update.put("update", "documents");
        update.put("updates", List.of(Map.of("q", Map.of("_id", "x"), "u", Map.of("$set", Map.of("name", "n")))));
        assertThat(StoreRedaction.sanitizeDocument(update)).isEqualTo(JSON.readTree(
                "{\"update\":\"?\",\"updates\":[{\"q\":{\"_id\":\"?\"},\"u\":{\"$set\":{\"name\":\"?\"}}}]}"));
    }
}

package io.github.mprync.sendproof.core.stores;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The shared classification tables of {@code spec/data-stores/}, loaded from the copies embedded in this jar.
 *
 * <p>The copies in {@code src/main/resources/.../stores/} are identical to the spec's files. {@code StoreTablesTest}
 * fails when they differ; run {@code sh adapters/java/scripts/gradle.sh :sendproof-core:syncStoreTables} to refresh them.
 */
public final class StoreTables {
    /** The classpath directory that holds the embedded tables. */
    static final String RESOURCE_DIRECTORY = "/io/github/mprync/sendproof/core/stores/";

    /** Redis: upper-case command names, container commands joined as {@code OBJECT|ENCODING}. */
    public record Redis(Set<String> read, Set<String> session, Set<String> transaction) {
    }

    /**
     * MongoDB, lower-cased for case-insensitive comparison.
     *
     * @param notInTransactionCommands commands MongoDB refuses inside a transaction
     * @param notInTransactionStages   aggregation stages MongoDB refuses inside a transaction, as written (for example {@code $out})
     */
    public record Mongo(Set<String> read, Set<String> session, Set<String> notInTransactionCommands,
                        List<String> notInTransactionStages) {
    }

    /** DynamoDB: action names, and the PartiQL actions whose statements decide the classification. */
    public record Dynamo(Set<String> read, Set<String> partiql) {
    }

    /**
     * Cassandra: the keys (a statement's first keyword, {@code LIST} with its next word) that read, and the native
     * protocol messages that carry no statement.
     */
    public record Cassandra(Set<String> read, Set<String> sessionMessages) {
    }

    /**
     * One Elasticsearch or OpenSearch endpoint. {@code kind} is {@code read}, {@code write}, {@code session} or
     * {@code sql}; {@code paths} are pre-split segment lists in which {@code {index}} and {@code {id}} are wildcards.
     */
    public record Endpoint(String kind, String name, Set<String> methods, List<List<String>> paths) {
    }

    /** Elasticsearch and OpenSearch: the ordered endpoints, the per-method default and the SQL read words. */
    public record Search(List<Endpoint> endpoints, java.util.Map<String, String> methodDefault, String defaultKind,
                         Set<String> sqlReadWords) {
    }

    /** Cosmos DB: operation names by lower-case spelling, and the reads. */
    public record Cosmos(java.util.Map<String, String> canonical, Set<String> read) {
    }

    /** One Firestore service: its reads, allowed session methods, and the method prefixes that read (admin). */
    public record FirestoreService(Set<String> read, Set<String> session, List<String> readPrefixes) {
    }

    /** Firestore: the known services and the REST verb names. */
    public record Firestore(java.util.Map<String, FirestoreService> services, java.util.Map<String, String> restVerbs) {
    }

    private static final Redis REDIS = loadRedis();
    private static final Mongo MONGO = loadMongo();
    private static final Dynamo DYNAMO = loadDynamo();
    private static final Cassandra CASSANDRA = loadCassandra();
    private static final Search SEARCH = loadSearch();
    private static final Cosmos COSMOS = loadCosmos();
    private static final Firestore FIRESTORE = loadFirestore();

    private StoreTables() {
    }

    /** The Cassandra table. */
    public static Cassandra cassandra() {
        return CASSANDRA;
    }

    /** The Elasticsearch and OpenSearch table. */
    public static Search search() {
        return SEARCH;
    }

    /** The Cosmos DB table. */
    public static Cosmos cosmos() {
        return COSMOS;
    }

    /** The Firestore table. */
    public static Firestore firestore() {
        return FIRESTORE;
    }

    private static Cassandra loadCassandra() {
        JsonNode table = read("cassandra");
        return new Cassandra(Set.copyOf(strings(table.get("read"), false)),
                Set.copyOf(strings(table.get("protocol").get("session"), false)));
    }

    private static Search loadSearch() {
        JsonNode table = read("elasticsearch");
        var endpoints = new java.util.ArrayList<Endpoint>();
        for (JsonNode entry : table.get("endpoints")) {
            var paths = new java.util.ArrayList<List<String>>();
            for (JsonNode path : entry.get("paths")) {
                paths.add(StoreClassifier.segments(path.asText()));
            }
            endpoints.add(new Endpoint(entry.get("kind").asText(), entry.get("name").asText(),
                    Set.copyOf(strings(entry.get("methods"), false)), List.copyOf(paths)));
        }
        var methodDefault = new java.util.LinkedHashMap<String, String>();
        table.get("methodDefault").fields().forEachRemaining(field -> methodDefault.put(field.getKey(), field.getValue().asText()));
        return new Search(List.copyOf(endpoints), java.util.Map.copyOf(methodDefault), table.get("default").asText(),
                Set.copyOf(strings(table.get("sql").get("readWords"), false)));
    }

    private static Cosmos loadCosmos() {
        JsonNode table = read("cosmosdb");
        var canonical = new java.util.LinkedHashMap<String, String>();
        for (String name : strings(table.get("read"), false)) {
            canonical.put(name.toLowerCase(Locale.ROOT), name);
        }
        for (String name : strings(table.get("write"), false)) {
            canonical.put(name.toLowerCase(Locale.ROOT), name);
        }
        return new Cosmos(java.util.Map.copyOf(canonical), Set.copyOf(strings(table.get("read"), false)));
    }

    private static Firestore loadFirestore() {
        JsonNode table = read("firestore");
        var services = new java.util.LinkedHashMap<String, FirestoreService>();
        table.get("services").fields().forEachRemaining(entry -> {
            JsonNode service = entry.getValue();
            services.put(entry.getKey(), new FirestoreService(
                    service.has("read") ? Set.copyOf(strings(service.get("read"), false)) : Set.of(),
                    service.has("session") ? Set.copyOf(strings(service.get("session"), false)) : Set.of(),
                    service.has("readPrefixes") ? List.copyOf(strings(service.get("readPrefixes"), false)) : List.of()));
        });
        var verbs = new java.util.LinkedHashMap<String, String>();
        table.get("fromRest").get("verbs").fields().forEachRemaining(field -> verbs.put(field.getKey(), field.getValue().asText()));
        return new Firestore(java.util.Map.copyOf(services), java.util.Map.copyOf(verbs));
    }

    /** The Redis table; reads include the module reads. */
    public static Redis redis() {
        return REDIS;
    }

    /** The MongoDB table. */
    public static Mongo mongo() {
        return MONGO;
    }

    /** The DynamoDB table. */
    public static Dynamo dynamo() {
        return DYNAMO;
    }

    /** Reads one embedded table as JSON, for the parity test. */
    public static JsonNode raw(String store) {
        return read(store);
    }

    private static Redis loadRedis() {
        JsonNode table = read("redis");
        Set<String> reads = strings(table.get("read"), false);
        reads.addAll(strings(table.get("moduleRead"), false));
        return new Redis(Set.copyOf(reads), Set.copyOf(strings(table.get("session"), false)),
                Set.copyOf(strings(table.get("transaction"), false)));
    }

    private static Mongo loadMongo() {
        JsonNode table = read("mongodb");
        JsonNode refused = table.get("notInTransaction");
        return new Mongo(Set.copyOf(strings(table.get("read"), true)), Set.copyOf(strings(table.get("session"), true)),
                Set.copyOf(strings(refused.get("commands"), true)), List.copyOf(strings(refused.get("stages"), false)));
    }

    private static Dynamo loadDynamo() {
        JsonNode table = read("dynamodb");
        return new Dynamo(Set.copyOf(strings(table.get("read"), false)),
                Set.copyOf(strings(table.get("partiql").get("operations"), false)));
    }

    private static Set<String> strings(JsonNode array, boolean lower) {
        var values = new LinkedHashSet<String>();
        for (JsonNode item : array) {
            values.add(lower ? item.asText().toLowerCase(Locale.ROOT) : item.asText());
        }
        return values;
    }

    private static JsonNode read(String store) {
        try (InputStream stream = StoreTables.class.getResourceAsStream(RESOURCE_DIRECTORY + store + ".json")) {
            if (stream == null) {
                throw new IllegalStateException("The embedded " + store + " classification table is missing.");
            }
            return Json.MAPPER.readTree(stream);
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }
}

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

    private static final Redis REDIS = loadRedis();
    private static final Mongo MONGO = loadMongo();
    private static final Dynamo DYNAMO = loadDynamo();

    private StoreTables() {
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

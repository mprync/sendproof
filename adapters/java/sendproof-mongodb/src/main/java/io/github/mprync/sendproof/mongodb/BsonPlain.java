package io.github.mprync.sendproof.mongodb;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.Json;
import java.io.IOException;
import java.io.UncheckedIOException;
import org.bson.BsonDocument;
import org.bson.BsonValue;
import org.bson.json.JsonMode;
import org.bson.json.JsonWriterSettings;

/**
 * Converts BSON to plain JSON using MongoDB Extended JSON v2 relaxed form for the types JSON lacks
 * ({@code {"$oid": ...}}, {@code {"$date": ...}}).
 */
final class BsonPlain {
    private static final JsonWriterSettings RELAXED = JsonWriterSettings.builder().outputMode(JsonMode.RELAXED).build();

    private BsonPlain() {
    }

    /** The relaxed extended JSON of a document. */
    static JsonNode plain(BsonDocument document) {
        try {
            return Json.MAPPER.readTree(document.toJson(RELAXED));
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    /** The relaxed extended JSON of any value, such as a document {@code _id}. */
    static JsonNode plain(BsonValue value) {
        return plain(new BsonDocument("v", value)).get("v");
    }
}

package io.github.mprync.sendproof.core.stores;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.mprync.sendproof.core.SqlRedaction;
import java.util.Iterator;
import java.util.Map;

/** Redaction and sanitizing for document and key data, which can nest to any depth. */
public final class StoreRedaction {
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private StoreRedaction() {
    }

    /**
     * Replaces the value of every secret-named field, at any depth of a document, with {@code "[REDACTED]"}. The name
     * rule is {@link SqlRedaction#looksSecret}: {@code password_hash} and {@code apiKey} are hidden while
     * {@code idempotency_key} stays visible.
     */
    public static JsonNode redactDeep(JsonNode value) {
        if (value == null || value.isNull()) {
            return value;
        }
        if (value.isObject()) {
            ObjectNode result = NODES.objectNode();
            Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> field = fields.next();
                boolean hide = SqlRedaction.looksSecret(field.getKey()) && !field.getValue().isNull();
                result.set(field.getKey(), hide ? NODES.textNode(SqlRedaction.REDACTED) : redactDeep(field.getValue()));
            }
            return result;
        }
        if (value.isArray()) {
            ArrayNode result = NODES.arrayNode();
            for (JsonNode item : value) {
                result.add(redactDeep(item));
            }
            return result;
        }
        return value;
    }

    /**
     * Replaces every literal in a command document with {@code "?"}, keeping field names and operators, for the
     * {@code statement} of a MongoDB {@code Db} entry (OpenTelemetry {@code db.query.text}). Maps are documents,
     * iterables are arrays (a {@code BsonDocument} and a {@code BsonArray} qualify), anything else is a literal.
     */
    public static JsonNode sanitizeDocument(Object value) {
        if (value instanceof Map<?, ?> map) {
            ObjectNode result = NODES.objectNode();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                result.set(String.valueOf(entry.getKey()), sanitizeDocument(entry.getValue()));
            }
            return result;
        }
        if (value instanceof Iterable<?> items) {
            ArrayNode result = NODES.arrayNode();
            for (Object item : items) {
                result.add(sanitizeDocument(item));
            }
            return result;
        }
        return NODES.textNode("?");
    }
}

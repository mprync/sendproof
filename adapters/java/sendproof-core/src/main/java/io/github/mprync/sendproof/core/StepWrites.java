package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.databind.node.ArrayNode;
import java.util.Locale;
import java.util.Map;

/** Describes the writes and effects expected from a journey step. */
public final class StepWrites {
    final ArrayNode writes = Json.MAPPER.createArrayNode();
    final ArrayNode effects = Json.MAPPER.createArrayNode();
    boolean expectsNothing;
    boolean writesRedis;

    StepWrites() {}

    /** The store is the database system the adapter advertises, such as {@code h2} or {@code postgresql}. */
    public StepWrites sql(String store, String table, String op, Map<String, ?> key, Map<String, ?> values) {
        return target(store, "table", table, op, key, values);
    }

    public StepWrites mongo(String collection, String op, Map<String, ?> key, Map<String, ?> values) {
        return target("mongodb", "collection", collection, op, key, values);
    }

    public StepWrites redis(String key, String command) {
        return redis(key, command, Map.of());
    }

    public StepWrites redis(String key, String command, Map<String, ?> values) {
        target("redis", "key", key, command.toUpperCase(Locale.ROOT), Map.of(), values);
        writesRedis = true;
        return this;
    }

    /** Adds a write for a named table or collection in any store the adapter hooks. */
    public StepWrites store(String store, String target, String op, Map<String, ?> key, Map<String, ?> values) {
        return target(store, "table", target, op, key, values);
    }

    public StepWrites email(Object to, Object subject) {
        var email = effects.addObject().put("kind", "email");
        email.set("to", Json.MAPPER.valueToTree(to));
        email.set("subject", Json.MAPPER.valueToTree(subject));
        return this;
    }

    public StepWrites effect(String kind, Map<String, ?> data) {
        var effect = effects.addObject();
        data.forEach((key, value) -> effect.set(key, Json.MAPPER.valueToTree(value)));
        effect.put("kind", kind);
        return this;
    }

    /** Requires zero writes and zero effects. */
    public StepWrites nothing() {
        expectsNothing = true;
        return this;
    }

    private StepWrites target(String store, String targetField, String target, String op,
                              Map<String, ?> key, Map<String, ?> values) {
        var write = writes.addObject().put("store", store).put(targetField, target).put("op", op);
        if (!key.isEmpty()) {
            write.set("key", Json.MAPPER.valueToTree(key));
        }
        if (!values.isEmpty()) {
            write.set("values", Json.MAPPER.valueToTree(values));
        }
        return this;
    }
}

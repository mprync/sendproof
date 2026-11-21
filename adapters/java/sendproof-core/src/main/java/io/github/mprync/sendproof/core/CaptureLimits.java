package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamWriteConstraints;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Collection and payload caps shared by every capture path, matching the protocol's defaults (500 logs, 100 effects,
 * 200 changes, 32 properties, 64 SQL parameters). Capture is best effort and never interrupts the application.
 */
public final class CaptureLimits {
    /** Maximum log entries per request. */
    public static final int LOGS = 500;
    /** Maximum effects per request. */
    public static final int EFFECTS = 100;
    /** Maximum changes per request. */
    public static final int CHANGES = 200;
    /** Maximum properties on one log entry. */
    public static final int PROPERTIES = 32;
    /** Maximum SQL parameters and JSON collection members. */
    public static final int PARAMETERS = 64;
    /** Maximum length of names, kinds and categories. */
    public static final int NAME = 256;
    /** Maximum length of free text such as messages and SQL. */
    public static final int TEXT = 4096;
    /** Maximum serialized size of one captured payload value. */
    public static final int PAYLOAD_BYTES = 16 * 1024;
    /** Total size budget for the log list and for the effect list. */
    public static final int LOG_BUDGET = 128 * 1024;
    /** Maximum buffered preview response body. */
    public static final int RESPONSE_BYTES = 1024 * 1024;
    private static final int PAYLOAD_BUDGET = 128 * 1024;
    private static final int MAX_DEPTH = 16;

    private static final ObjectMapper PAYLOAD = JsonMapper.builder(
                    JsonFactory.builder()
                            .streamWriteConstraints(StreamWriteConstraints.builder().maxNestingDepth(MAX_DEPTH).build())
                            .build())
            .findAndAddModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(SerializationFeature.FAIL_ON_EMPTY_BEANS)
            .build();

    private CaptureLimits() {
    }

    /** Clips text to {@code maximum} characters without splitting a surrogate pair. */
    public static String clip(String value, int maximum) {
        if (value.length() <= maximum) {
            return value;
        }
        return value.substring(0, Character.isHighSurrogate(value.charAt(maximum - 1)) ? maximum - 1 : maximum);
    }

    /** Clips text to {@link #TEXT} characters. */
    public static String clip(String value) {
        return clip(value, TEXT);
    }

    /**
     * Serializes a host-provided value into a bounded JSON tree.
     *
     * @return the tree, or {@code null} when the value is cyclic, too deep, too large or fails to serialize
     */
    public static JsonNode snapshot(Object value) {
        try {
            JsonNode node = PAYLOAD.readTree(write(value));
            return fits(node, 0) ? node : null;
        } catch (Exception | StackOverflowError error) {
            // Host payloads may be cyclic, oversized, or fail in a getter. Capture must never interrupt the request.
            return null;
        }
    }

    private static byte[] write(Object value) throws IOException {
        var buffer = new BoundedBuffer(PAYLOAD_BYTES);
        PAYLOAD.writeValue(buffer, value);
        return buffer.toByteArray();
    }

    /** Returns the raw JSON length of a snapshot, or zero for {@code null}. */
    public static int size(JsonNode value) {
        return value == null ? 0 : value.toString().length();
    }

    /** The outcome of bounding a list of changes. */
    public record BoundedChanges(List<PreviewChange> changes, boolean truncated) {
    }

    /** Snapshots up to {@link #CHANGES} changes within the total payload budget. */
    public static BoundedChanges snapshotChanges(List<PreviewChange> changes) {
        var result = new ArrayList<PreviewChange>();
        boolean truncated = changes.size() > CHANGES;
        int remaining = PAYLOAD_BUDGET;
        for (PreviewChange change : changes.subList(0, Math.min(changes.size(), CHANGES))) {
            // A table whose name marks it as secret (api_tokens, user_credentials) hides every value; otherwise each
            // column whose name looks secret (password_hash, refreshToken) is hidden. The key keeps ordinary columns
            // so the row stays identifiable.
            boolean secretTable = change.table() != null && SqlRedaction.looksSecret(change.table());
            JsonNode key = change.key() == null ? null : snapshot(redact(change.key(), false));
            JsonNode before = change.before() == null ? null : snapshot(redact(change.before(), secretTable));
            JsonNode after = change.after() == null ? null : snapshot(redact(change.after(), secretTable));
            String operation = clip(change.operation(), NAME);
            String table = clip(change.table(), NAME);
            remaining -= size(key) + size(before) + size(after) + operation.length() + table.length();
            if (remaining < 0) {
                truncated = true;
                break;
            }
            truncated |= (key == null && change.key() != null) || (before == null && change.before() != null)
                    || (after == null && change.after() != null) || !operation.equals(change.operation())
                    || !table.equals(change.table());
            result.add(new PreviewChange(operation, table, key, before, after));
        }
        return new BoundedChanges(List.copyOf(result), truncated);
    }

    /**
     * Replaces secret-named members of a row with {@link SqlRedaction#REDACTED}. A row is a map of column (or property)
     * names to values, or a JSON object; anything else is returned unchanged.
     *
     * @param row the captured row
     * @param all whether every value is hidden regardless of its name
     */
    static Object redact(Object row, boolean all) {
        if (row instanceof Map<?, ?> map) {
            var result = new LinkedHashMap<Object, Object>();
            for (var entry : map.entrySet()) {
                boolean hide = all || (entry.getKey() != null && SqlRedaction.looksSecret(String.valueOf(entry.getKey())));
                result.put(entry.getKey(), hide && entry.getValue() != null ? SqlRedaction.REDACTED : entry.getValue());
            }
            return result;
        }
        if (row instanceof ObjectNode node) {
            ObjectNode result = node.deepCopy();
            node.fieldNames().forEachRemaining(name -> {
                if ((all || SqlRedaction.looksSecret(name)) && !node.get(name).isNull()) {
                    result.put(name, SqlRedaction.REDACTED);
                }
            });
            return result;
        }
        return row;
    }

    private static boolean fits(JsonNode value, int depth) {
        if (depth >= MAX_DEPTH) {
            return false;
        }
        if (value.isTextual()) {
            return value.textValue().length() <= TEXT;
        }
        if (value.isArray()) {
            if (value.size() > PARAMETERS) {
                return false;
            }
            for (JsonNode item : value) {
                if (!fits(item, depth + 1)) {
                    return false;
                }
            }
        } else if (value.isObject()) {
            if (value.size() > PARAMETERS) {
                return false;
            }
            Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                if (field.getKey().length() > NAME || !fits(field.getValue(), depth + 1)) {
                    return false;
                }
            }
        }
        return true;
    }

    private static final class BoundedBuffer extends ByteArrayOutputStream {
        private final int limit;

        BoundedBuffer(int limit) {
            this.limit = limit;
        }

        @Override
        public synchronized void write(int b) {
            check(1);
            super.write(b);
        }

        @Override
        public synchronized void write(byte[] bytes, int offset, int length) {
            check(length);
            super.write(bytes, offset, length);
        }

        private void check(int length) {
            if (count + length > limit) {
                throw new IllegalStateException("The capture payload exceeds its size limit.");
            }
        }
    }
}

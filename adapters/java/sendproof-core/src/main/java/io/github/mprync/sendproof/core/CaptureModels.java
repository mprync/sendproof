package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Wire models for captured effects, logs and timing. They serialize to the protocol's JSON shapes. */
public final class CaptureModels {
    private CaptureModels() {
    }

    /**
     * A side effect the host reported.
     *
     * @param kind        the effect kind, such as {@code email}
     * @param description a short description
     * @param data        host-defined JSON data, or {@code null}
     * @param delivered   {@code true} when an observed send delivered it; omitted for previews
     */
    public record PreviewEffect(String kind, String description, JsonNode data,
                                @JsonInclude(JsonInclude.Include.NON_NULL) Boolean delivered) {
    }

    /** A structured log entry; optional members are omitted when absent. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PreviewLog(String level, String message, String category, EventId eventId, Double offsetMs,
                             Double elapsedMs, Map<String, String> properties, CapturedException exception,
                             CapturedSql sql, CapturedDb db) {

        /** Creates a log without a data-store command. */
        public PreviewLog(String level, String message, String category, EventId eventId, Double offsetMs,
                          Double elapsedMs, Map<String, String> properties, CapturedException exception,
                          CapturedSql sql) {
            this(level, message, category, eventId, offsetMs, elapsedMs, properties, exception, sql, null);
        }

        /** Creates a log with only the required members. */
        public static PreviewLog of(String level, String message) {
            return new PreviewLog(level, message, null, null, null, null, null, null, null);
        }

        /** Returns the approximate retained size used for the log budget. */
        int size() {
            int size = level.length() + message.length() + (category == null ? 0 : category.length())
                    + (eventId == null || eventId.name() == null ? 0 : eventId.name().length());
            if (properties != null) {
                for (var pair : properties.entrySet()) {
                    size += pair.getKey().length() + pair.getValue().length();
                }
            }
            if (exception != null) {
                size += exception.type().length() + exception.message().length();
            }
            if (db != null) {
                size += db.system().length() + db.operation().length() + (db.target() == null ? 0 : db.target().length())
                        + (db.namespace() == null ? 0 : db.namespace().length())
                        + (db.statement() == null ? 0 : db.statement().length());
            }
            if (sql != null) {
                size += sql.text().length();
                for (SqlParameter parameter : sql.parameters()) {
                    size += parameter.name().length() + (parameter.value() == null ? 0 : parameter.value().length())
                            + parameter.dbType().length();
                }
            }
            return size;
        }
    }

    /** A log event identifier. */
    public record EventId(int id, @JsonInclude(JsonInclude.Include.NON_NULL) String name) {
    }

    /** The type and message of a logged exception. */
    public record CapturedException(String type, String message) {
    }

    /** One executed SQL command. */
    public record CapturedSql(String text, List<SqlParameter> parameters,
                              @JsonInclude(JsonInclude.Include.NON_NULL) Integer rowsAffected) {
    }

    /**
     * One command sent to a non-SQL store, the {@code db} member of a {@code Db} log entry. Members follow the
     * OpenTelemetry database conventions; absent ones are omitted.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CapturedDb(String system, String namespace, String operation, String target, String statement,
                             Integer rowsAffected, Boolean blocked, String error) {
    }

    /** A bound SQL parameter; the value is a string, {@code null} or {@code "[REDACTED]"}. */
    public record SqlParameter(String name, String value, String dbType) {
    }

    /** The effects and logs retained when a capture finishes. */
    public record CaptureSnapshot(List<PreviewEffect> effects, List<PreviewLog> logs, boolean logsTruncated,
                                  boolean effectsTruncated) {
    }

    /** Timing metrics in milliseconds for {@code Server-Timing} and traces. */
    public record CaptureTiming(double auth, double handler, double db, int queryCount, double serialize) {

        /** Formats the {@code Server-Timing} header value. */
        public String toHeader() {
            return String.format(Locale.ROOT,
                    "auth;dur=%.3f, handler;dur=%.3f, db;dur=%.3f;desc=\"%d queries\", serialize;dur=%.3f",
                    auth, handler, db, queryCount, serialize);
        }
    }
}

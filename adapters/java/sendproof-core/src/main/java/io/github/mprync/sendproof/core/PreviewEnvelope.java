package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import io.github.mprync.sendproof.core.CaptureModels.PreviewEffect;
import io.github.mprync.sendproof.core.CaptureModels.PreviewLog;
import java.util.List;
import java.util.Map;

/**
 * The confirmed preview result: the application's inner response plus everything captured while it ran inside a
 * rolled-back unit of work.
 */
public record PreviewEnvelope(int status, Map<String, String> headers, JsonNode body, List<PreviewChange> changes,
                              List<PreviewEffect> effects, List<PreviewLog> logs, boolean rolledBack,
                              @JsonInclude(JsonInclude.Include.NON_NULL) Boolean changesTruncated,
                              @JsonInclude(JsonInclude.Include.NON_NULL) Boolean effectsTruncated,
                              @JsonInclude(JsonInclude.Include.NON_NULL) Boolean logsTruncated,
                              @JsonInclude(JsonInclude.Include.NON_NULL) Session session) {
    public PreviewEnvelope(int status, Map<String, String> headers, JsonNode body, List<PreviewChange> changes,
                           List<PreviewEffect> effects, List<PreviewLog> logs, boolean rolledBack, Boolean changesTruncated,
                           Boolean effectsTruncated, Boolean logsTruncated) {
        this(status, headers, body, changes, effects, logs, rolledBack, changesTruncated, effectsTruncated, logsTruncated, null);
    }

    public record Session(String id, int step) {
    }
}

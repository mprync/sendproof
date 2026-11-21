package dev.testbench.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import dev.testbench.core.CaptureModels.PreviewEffect;
import dev.testbench.core.CaptureModels.PreviewLog;
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
                              @JsonInclude(JsonInclude.Include.NON_NULL) Boolean logsTruncated) {
}

package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.github.mprync.sendproof.core.CaptureModels.CaptureTiming;
import io.github.mprync.sendproof.core.CaptureModels.PreviewEffect;
import io.github.mprync.sendproof.core.CaptureModels.PreviewLog;
import java.util.List;

/** The trace of one observed send, served at {@code /sendproof/_api/traces/{id}}. */
public record ObservedTrace(List<PreviewChange> changes, List<PreviewEffect> effects, List<PreviewLog> logs,
                            CaptureTiming timing,
                            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean changesTruncated,
                            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean effectsTruncated,
                            @JsonInclude(JsonInclude.Include.NON_NULL) Boolean logsTruncated) {

    /** Maps {@code false} to {@code null} so unset truncation flags are omitted from JSON. */
    static Boolean flag(boolean value) {
        return value ? Boolean.TRUE : null;
    }
}

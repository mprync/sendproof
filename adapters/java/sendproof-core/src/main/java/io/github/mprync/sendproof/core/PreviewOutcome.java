package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What a framework adapter should send for a preview: the confirmed envelope, a blocked-Preview problem, or a rejection.
 * A rejection and a blocked Preview never claim that anything was rolled back.
 *
 * @param status       the outer HTTP status
 * @param title        the problem title for a rejection, or {@code null} for a confirmed preview
 * @param json         the serialized envelope for a confirmed preview, or {@code null}
 * @param serverTiming the {@code Server-Timing} value for a confirmed preview, or {@code null}
 * @param challenge    a {@code WWW-Authenticate} value to forward on 401, or {@code null}
 * @param problem      the serialized {@code application/problem+json} body of a blocked Preview (409), or {@code null}
 */
public record PreviewOutcome(int status, String title, byte[] json, String serverTiming, String challenge,
                             byte[] problem) {

    /** Creates an outcome that is neither blocked nor a data-store problem. */
    public PreviewOutcome(int status, String title, byte[] json, String serverTiming, String challenge) {
        this(status, title, json, serverTiming, challenge, null);
    }

    /** Returns whether the preview is confirmed (rolled back with a valid envelope). */
    public boolean confirmed() {
        return json != null;
    }

    /** Returns whether a guarded store refused a write, so the Preview answers 409 with {@link #problem()}. */
    public boolean blocked() {
        return problem != null;
    }

    static PreviewOutcome rejected(int status, String title, String challenge) {
        return new PreviewOutcome(status, title, null, null, challenge);
    }

    /**
     * The blocked-Preview response of {@code spec/data-stores.md}: 409 with an RFC 9457 body naming the store and the
     * refused command, never the handler's status, body, logs or changes.
     */
    static PreviewOutcome blocked(BlockedWrite write) throws JsonProcessingException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "about:blank");
        body.put("title", "Preview unavailable");
        body.put("status", 409);
        body.put("code", "preview_unavailable");
        body.put("detail", write.detail());
        body.put("store", write.store());
        body.put("operation", write.operation());
        body.put("rolledBack", false);
        return new PreviewOutcome(409, "Preview unavailable", null, null, null, Json.MAPPER.writeValueAsBytes(body));
    }
}

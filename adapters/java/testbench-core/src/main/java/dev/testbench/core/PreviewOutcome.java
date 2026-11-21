package dev.testbench.core;

/**
 * What a framework adapter should send for a preview: either the confirmed envelope or a rejection. A rejection never
 * claims that anything was rolled back.
 *
 * @param status       the outer HTTP status
 * @param title        the problem title for a rejection, or {@code null} for a confirmed preview
 * @param json         the serialized envelope for a confirmed preview, or {@code null}
 * @param serverTiming the {@code Server-Timing} value for a confirmed preview, or {@code null}
 * @param challenge    a {@code WWW-Authenticate} value to forward on 401, or {@code null}
 */
public record PreviewOutcome(int status, String title, byte[] json, String serverTiming, String challenge) {

    /** Returns whether the preview is confirmed (rolled back with a valid envelope). */
    public boolean confirmed() {
        return json != null;
    }

    static PreviewOutcome rejected(int status, String title, String challenge) {
        return new PreviewOutcome(status, title, null, null, challenge);
    }
}

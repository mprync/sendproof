package dev.testbench.core;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Lets host code report side effects and log lines to the Test Bench request in progress.
 *
 * <p>Each {@code tryRecord*} method returns {@code true} when the host must <em>suppress</em> the action (a preview),
 * and {@code false} when it should carry on (an ordinary send, which marks the effect as delivered, or no capture at
 * all). Record a snapshot of the action, then return without dispatching when the method returns {@code true}:
 *
 * <pre>{@code
 * if (capture.tryRecordEmail("Send receipt", "pay@example.test", List.of(to), List.of(), "Paid", body, null)) {
 *     return;
 * }
 * mailer.send(...);
 * }</pre>
 */
public final class TestBenchCapture {

    /** Returns whether a rollback-only preview is running on this thread. */
    public boolean isPreview() {
        RequestCapture capture = CaptureContext.current();
        return capture != null && capture.isPreview();
    }

    /** Records an effect of any kind; returns {@code true} when delivery must be suppressed. */
    public boolean tryRecordEffect(String kind, String description, Object data) {
        RequestCapture capture = CaptureContext.current();
        return capture != null && capture.tryRecordEffect(kind, description, data);
    }

    /** Records an email; returns {@code true} when delivery must be suppressed. */
    public boolean tryRecordEmail(String description, String from, List<String> to, List<String> cc, String subject,
                                  String text, String html) {
        var data = new LinkedHashMap<String, Object>();
        data.put("from", from);
        data.put("to", to);
        data.put("cc", cc);
        data.put("subject", subject);
        data.put("text", text);
        data.put("html", html);
        return tryRecordEffect("email", description, data);
    }

    /** Records an outgoing HTTP call; returns {@code true} when it must be suppressed. */
    public boolean tryRecordHttp(String description, String method, String url, Integer status, Object body) {
        var data = new LinkedHashMap<String, Object>();
        data.put("method", method);
        data.put("url", url);
        data.put("status", status);
        data.put("body", body);
        return tryRecordEffect("http", description, data);
    }

    /** Records a background job; returns {@code true} when scheduling must be suppressed. */
    public boolean tryRecordJob(String description, String name, Object arguments, String queue, Instant runAt) {
        var data = new LinkedHashMap<String, Object>();
        data.put("name", name);
        data.put("arguments", arguments);
        data.put("queue", queue);
        data.put("runAt", runAt == null ? null : runAt.toString());
        return tryRecordEffect("job", description, data);
    }

    /** Records a published message; returns {@code true} when publishing must be suppressed. */
    public boolean tryRecordMessage(String description, String topic, Object payload, String key) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("topic", topic);
        data.put("payload", payload);
        data.put("key", key);
        return tryRecordEffect("message", description, data);
    }

    /** Adds an explicit log line to the capture; returns whether a capture is active. */
    public boolean tryRecordLog(String level, String message) {
        RequestCapture capture = CaptureContext.current();
        return capture != null && capture.tryRecordLog(level, message);
    }
}

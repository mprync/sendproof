package dev.testbench.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import dev.testbench.core.CaptureModels.CaptureSnapshot;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Orchestrates one preview independent of the web framework: start the provider session, let the adapter run the
 * handler, then roll back, dispose and decide whether the result can be confirmed.
 *
 * <p>A preview is confirmed only when the handler completed, the response stayed within its cap, the rollback
 * succeeded and the session was disposed. Everything else is a rejection.
 */
public final class PreviewExecution {
    private static final Logger LOG = LoggerFactory.getLogger(PreviewExecution.class);
    private static final Set<String> PRIVATE_HEADERS = Set.of("set-cookie", "location", "content-length",
            "transfer-encoding", "connection", "upgrade", "trailer");
    private static final String TOO_LARGE = "The preview response exceeds the 1 MiB limit.";

    private final long started;
    private final RequestCapture capture = new RequestCapture();
    private final CaptureClock clock;
    private PreviewSession session;
    private boolean invoked;
    private boolean completed;

    /** Creates an execution for a request that began at the given {@link System#nanoTime()} value. */
    public PreviewExecution(long startedNanos) {
        this.started = startedNanos;
        this.clock = new CaptureClock(startedNanos);
    }

    /** Returns the capture to make current while the request runs. */
    public RequestCapture capture() {
        return capture;
    }

    /** Returns whether the handler has been entered. */
    public boolean hasInvoked() {
        return invoked;
    }

    /**
     * Starts the provider session and capture. Call exactly once, immediately before invoking the handler.
     *
     * @throws Exception whatever the provider throws; the preview is then not confirmed
     */
    public void begin(PreviewProvider provider) throws Exception {
        invoked = true;
        clock.startHandler();
        session = provider.begin();
        if (session == null) {
            throw new IllegalStateException("The preview provider returned no session.");
        }
        capture.begin(true, started);
    }

    /** Records that the handler returned normally. */
    public void markCompleted() {
        completed = true;
    }

    /**
     * Rolls back, disposes and builds the outcome.
     *
     * @param response the buffered inner response
     * @param failure  an exception the handler or its callbacks threw, or {@code null}
     */
    public PreviewOutcome finish(CapturedResponse response, Throwable failure) {
        PreviewEnvelope envelope = null;
        if (session != null) {
            try {
                session.rollback();
                if (failure == null && completed && !response.exceededLimit()) {
                    envelope = createEnvelope(response, session, capture.finish());
                }
            } catch (Throwable error) {
                failure = combine(failure, error);
            } finally {
                if (capture.isActive()) {
                    capture.finish();
                }
                try {
                    session.close();
                } catch (Throwable error) {
                    failure = combine(failure, error);
                }
            }
        }
        clock.endHandler();

        if (response.exceededLimit()) {
            return PreviewOutcome.rejected(413, TOO_LARGE, null);
        }
        if (failure != null) {
            LOG.error("A Test Bench preview failed.", failure);
            return PreviewOutcome.rejected(500, "The preview could not be completed safely.", null);
        }
        if (envelope == null) {
            return rejectUnexecuted(response);
        }
        long serializeStarted = System.nanoTime();
        try {
            byte[] json = Json.MAPPER.writeValueAsBytes(envelope);
            double serializeMs = (System.nanoTime() - serializeStarted) / 1_000_000.0;
            String timing = capture.timing(clock, serializeMs).toHeader();
            return new PreviewOutcome(200, null, json, timing, null);
        } catch (JsonProcessingException error) {
            LOG.error("A Test Bench preview could not be serialized.", error);
            return PreviewOutcome.rejected(500, "The preview could not be completed safely.", null);
        }
    }

    private PreviewOutcome rejectUnexecuted(CapturedResponse response) {
        if (invoked) {
            return PreviewOutcome.rejected(500, "The preview operation did not finish.", null);
        }
        int status = response.status();
        String challenge = null;
        for (var header : response.headers().entrySet()) {
            if (header.getKey().equalsIgnoreCase("WWW-Authenticate") && !header.getValue().isEmpty()) {
                challenge = String.join(", ", header.getValue());
            }
        }
        String title;
        if (status == 401) {
            title = "Authentication is required for this preview.";
        } else if (status == 403) {
            title = "This preview is forbidden.";
        } else if (status == 404 || status == 405) {
            title = "The preview target was not found for this method.";
        } else if (status == 503) {
            title = "Preview requires one available preview provider.";
        } else if (status >= 300 && status < 400) {
            title = "Preview redirects are disabled. Sign in through the workbench first.";
        } else if (status >= 400 && status < 500 && status != 409) {
            title = "The host rejected the preview request.";
        } else {
            title = "This operation is unavailable for preview.";
        }
        if (status < 400 || (status >= 500 && status != 503)) {
            status = status >= 300 && status < 400 ? 401 : 409;
        }
        return PreviewOutcome.rejected(status, title, challenge);
    }

    private static PreviewEnvelope createEnvelope(CapturedResponse response, PreviewSession session,
                                                  CaptureSnapshot snapshot) {
        var bounded = CaptureLimits.snapshotChanges(session.changes());
        Map<String, String> headers = new LinkedHashMap<>();
        for (var header : response.headers().entrySet()) {
            String name = header.getKey().toLowerCase(Locale.ROOT);
            if (PRIVATE_HEADERS.contains(name) || header.getKey().length() > CaptureLimits.NAME
                    || headers.size() == CaptureLimits.PARAMETERS) {
                continue;
            }
            headers.put(name, CaptureLimits.clip(String.join(", ", header.getValue())));
        }
        return new PreviewEnvelope(response.status(), headers, response.body(), bounded.changes(), snapshot.effects(),
                snapshot.logs(), true, ObservedTrace.flag(bounded.truncated() || session.changesTruncated()),
                ObservedTrace.flag(snapshot.effectsTruncated()), ObservedTrace.flag(snapshot.logsTruncated()));
    }

    private static Throwable combine(Throwable previous, Throwable error) {
        if (previous == null) {
            return error;
        }
        previous.addSuppressed(error);
        return previous;
    }
}

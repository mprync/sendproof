package io.github.mprync.sendproof.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import io.github.mprync.sendproof.core.CaptureModels.CaptureSnapshot;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
    private final List<DataStoreSession> storeSessions = new ArrayList<>();
    private final List<HeldPreview.Step> heldSteps = new ArrayList<>();
    private PreviewSession session;
    private PreviewSessions.Lease lease;
    private PreviewSessions.Refusal refusal;
    private Exception enrollmentFailure;
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

    /** Resolves session ownership after the framework has authenticated the rewritten request. */
    public void join(PreviewSessions sessions, String id, TraceOwner owner) {
        try {
            lease = sessions.enter(id, owner);
        } catch (PreviewSessions.Refusal denied) {
            refusal = denied;
            throw denied;
        }
    }

    /**
     * Starts the provider session and capture. Call exactly once, immediately before invoking the handler.
     *
     * @throws Exception whatever the provider throws; the preview is then not confirmed
     */
    public void begin(PreviewProvider provider) throws Exception {
        begin(provider, List.of());
    }

    /**
     * Starts the SQL provider's session (when there is one), the capture, and each data store's session. Call exactly
     * once, immediately before invoking the handler, with the capture current on this thread.
     *
     * @param provider the SQL provider, or {@code null} when the application has only data stores
     * @param stores   the hooked data stores
     * @throws Exception whatever a provider or store throws; the preview is then not confirmed, and {@link #finish}
     *                   still rolls back whatever had begun
     */
    public void begin(PreviewProvider provider, List<? extends DataStore> stores) throws Exception {
        invoked = true;
        clock.startHandler();
        if (lease != null) {
            try {
                capture.begin(true, started);
                lease.checkpoint();
                for (HeldPreview part : lease.parts()) {
                    heldSteps.add(part.begin(capture));
                }
            } catch (Exception error) {
                enrollmentFailure = error;
                throw error;
            }
            return;
        }
        if (provider != null) {
            session = provider.begin();
            if (session == null) {
                throw new IllegalStateException("The preview provider returned no session.");
            }
        }
        capture.begin(true, started);
        for (DataStore store : stores) {
            DataStoreSession storeSession = store.begin(capture);
            if (storeSession != null) {
                storeSessions.add(storeSession);
            }
        }
    }

    /** Records that the handler returned normally. */
    public void markCompleted() {
        completed = true;
    }

    /**
     * Rolls back, disposes and builds the outcome. The order is fixed by {@code spec/data-stores.md}: abort the stores'
     * transactions and roll back SQL; if anything failed or a transaction-control fault was recorded, answer 500 without
     * confirmation; otherwise, if a guarded store refused a write, answer 409; otherwise confirm.
     *
     * @param response the buffered inner response
     * @param failure  an exception the handler or its callbacks threw, or {@code null}
     */
    public PreviewOutcome finish(CapturedResponse response, Throwable failure) {
        if (refusal != null) {
            return refusal.outcome();
        }
        if (lease != null) {
            return finishHeld(response, failure);
        }
        // Failures of the rollback machinery outrank a block and the handler's own failure.
        Throwable internal = null;
        for (int i = storeSessions.size() - 1; i >= 0; i--) {
            try {
                storeSessions.get(i).finish(capture);
            } catch (Throwable error) {
                internal = combine(internal, error);
            }
        }
        PreviewEnvelope envelope = null;
        try {
            if (session != null) {
                session.rollback();
            }
            if (internal == null && failure == null && completed && !response.exceededLimit()) {
                envelope = createEnvelope(response, session == null ? List.of() : session.changes(),
                        session != null && session.changesTruncated(), null, capture);
            }
        } catch (Throwable error) {
            internal = combine(internal, error);
        } finally {
            if (capture.isActive()) {
                capture.finish();
            }
            for (int i = storeSessions.size() - 1; i >= 0; i--) {
                try {
                    storeSessions.get(i).close();
                } catch (Throwable error) {
                    internal = combine(internal, error);
                }
            }
            if (session != null) {
                try {
                    session.close();
                } catch (Throwable error) {
                    internal = combine(internal, error);
                }
            }
        }
        return outcome(response, failure, internal, envelope);
    }

    private PreviewOutcome finishHeld(CapturedResponse response, Throwable failure) {
        Throwable internal = enrollmentFailure;
        PreviewEnvelope envelope = null;
        try (var current = lease) {
            var changes = new ArrayList<PreviewChange>();
            boolean truncated = false;
            for (int i = heldSteps.size() - 1; i >= 0; i--) {
                try {
                    heldSteps.get(i).finish();
                } catch (Throwable error) {
                    internal = combine(internal, error);
                }
            }
            try {
                if (internal == null && failure == null && completed && !response.exceededLimit()
                        && capture.blocked() == null && capture.fault() == null && response.status() < 500) {
                    for (HeldPreview.Step step : heldSteps) {
                        changes.addAll(step.changes());
                        truncated |= step.changesTruncated();
                    }
                    envelope = createEnvelope(response, changes, truncated, current.marker(), capture);
                }
            } catch (Throwable error) {
                internal = combine(internal, error);
            } finally {
                if (capture.isActive()) {
                    capture.finish();
                }
                for (int i = heldSteps.size() - 1; i >= 0; i--) {
                    try {
                        heldSteps.get(i).close();
                    } catch (Throwable error) {
                        current.invalidate();
                        internal = combine(internal, error);
                    }
                }
            }
            boolean ended = contains(internal, HeldPreview.TransactionEnded.class);
            if (ended || contains(internal, HeldPreview.UnsafeTransaction.class) || capture.fault() != null) {
                current.invalidate();
            }
            if (ended && !contains(internal, HeldPreview.UnsafeTransaction.class) && capture.fault() == null) {
                return PreviewSessions.failed().outcome();
            }
            PreviewOutcome result = outcome(response, failure, internal, envelope);
            try {
                current.finish(result.confirmed());
            } catch (HeldPreview.TransactionEnded error) {
                return PreviewSessions.failed().outcome();
            } catch (Exception error) {
                return outcome(response, failure, error, null);
            }
            return result;
        }
    }

    private static boolean contains(Throwable error, Class<? extends Throwable> type) {
        if (error == null) {
            return false;
        }
        if (type.isInstance(error)) {
            return true;
        }
        for (Throwable suppressed : error.getSuppressed()) {
            if (contains(suppressed, type)) {
                return true;
            }
        }
        return false;
    }

    private PreviewOutcome outcome(CapturedResponse response, Throwable failure, Throwable internal,
                                   PreviewEnvelope envelope) {
        clock.endHandler();
        Throwable fault = capture.fault();
        if (internal != null || fault != null) {
            LOG.error("A Sendproof preview failed.", internal != null ? internal : fault);
            return PreviewOutcome.rejected(500, "The preview could not be completed safely.", null);
        }
        BlockedWrite blocked = capture.blocked();
        if (blocked != null) {
            try {
                return PreviewOutcome.blocked(blocked);
            } catch (JsonProcessingException error) {
                LOG.error("A Sendproof blocked preview could not be serialized.", error);
                return PreviewOutcome.rejected(500, "The preview could not be completed safely.", null);
            }
        }
        if (response.exceededLimit()) {
            return PreviewOutcome.rejected(413, TOO_LARGE, null);
        }
        if (failure != null) {
            LOG.error("A Sendproof preview failed.", failure);
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
            LOG.error("A Sendproof preview could not be serialized.", error);
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

    private static PreviewEnvelope createEnvelope(CapturedResponse response, List<PreviewChange> sqlChanges,
                                                  boolean sqlTruncated, PreviewEnvelope.Session marker,
                                                  RequestCapture capture) {
        var changes = new ArrayList<>(sqlChanges);
        changes.addAll(capture.storeChanges());
        boolean changesCut = capture.storeChangesTruncated() || sqlTruncated;
        CaptureSnapshot snapshot = capture.finish();
        var bounded = CaptureLimits.snapshotChanges(changes);
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
                snapshot.logs(), true, ObservedTrace.flag(bounded.truncated() || changesCut),
                ObservedTrace.flag(snapshot.effectsTruncated()), ObservedTrace.flag(snapshot.logsTruncated()), marker);
    }

    private static Throwable combine(Throwable previous, Throwable error) {
        if (previous == null) {
            return error;
        }
        if (previous != error) {
            previous.addSuppressed(error);
        }
        return previous;
    }
}

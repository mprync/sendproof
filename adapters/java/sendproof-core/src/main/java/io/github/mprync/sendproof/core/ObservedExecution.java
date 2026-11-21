package io.github.mprync.sendproof.core;

import io.github.mprync.sendproof.core.CaptureModels.CaptureSnapshot;
import io.github.mprync.sendproof.core.CaptureModels.CaptureTiming;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Observes an ordinary send (one with {@code Prefer: trace}) without changing its outcome, then publishes a trace
 * for its owner. A failed or incomplete send discards the trace.
 */
public final class ObservedExecution {
    private static final Logger LOG = LoggerFactory.getLogger(ObservedExecution.class);

    private final long started;
    private final RequestCapture capture = new RequestCapture();
    private final CaptureClock clock;
    private final TraceStore store;
    private final TraceStore.Reservation reservation;
    private final PreviewObservation observation;
    private CaptureTiming finishedTiming;
    private boolean valid = true;

    /**
     * Starts observing: reserves a trace and begins capturing.
     *
     * @param observation the provider's change observation, or {@code null} when changes cannot be observed
     */
    public ObservedExecution(long startedNanos, TraceStore store, TraceOwner owner, PreviewObservation observation) {
        this.started = startedNanos;
        this.clock = new CaptureClock(startedNanos);
        this.store = store;
        this.observation = observation;
        this.reservation = store.reserve(owner);
        clock.startHandler();
        capture.begin(false, startedNanos);
    }

    /** Returns the capture to make current while the handler runs. */
    public RequestCapture capture() {
        return capture;
    }

    /** Returns the trace ID in the form used by {@link Protocol#TRACE_HEADER}. */
    public String traceId() {
        return reservation.headerValue();
    }

    /** Returns whether the trace is still expected to be published. */
    public boolean isValid() {
        return valid;
    }

    /** Returns the timing as of now, or the final timing once finished. */
    public CaptureTiming timing() {
        return finishedTiming != null ? finishedTiming : capture.timing(clock, 0);
    }

    /**
     * Finishes the observation. Always call it, on success and failure.
     *
     * @param completed whether the handler returned normally for the same owner and the client stayed connected
     */
    public void finish(boolean completed) {
        clock.endHandler();
        CaptureSnapshot snapshot = capture.finish();
        try {
            if (completed) {
                long serializeStarted = System.nanoTime();
                var changes = CaptureLimits.snapshotChanges(observation == null ? java.util.List.of() : observation.changes());
                double serializeMs = (System.nanoTime() - serializeStarted) / 1_000_000.0;
                finishedTiming = capture.timing(clock, serializeMs);
                reservation.complete(new ObservedTrace(changes.changes(), snapshot.effects(), snapshot.logs(),
                        finishedTiming,
                        ObservedTrace.flag(changes.truncated() || (observation != null && observation.changesTruncated())),
                        ObservedTrace.flag(snapshot.effectsTruncated()), ObservedTrace.flag(snapshot.logsTruncated())));
            }
        } catch (RuntimeException error) {
            completed = false;
            LOG.warn("Sendproof could not collect the observed send.", error);
        } finally {
            if (!completed) {
                valid = false;
                store.discard(reservation);
            }
            if (observation != null) {
                try {
                    observation.close();
                } catch (RuntimeException error) {
                    LOG.warn("Sendproof could not release the send observation.", error);
                }
            }
        }
    }

    /** Returns the start time this execution was created with. */
    public long startedNanos() {
        return started;
    }
}

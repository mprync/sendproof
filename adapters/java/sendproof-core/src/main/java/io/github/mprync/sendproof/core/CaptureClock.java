package io.github.mprync.sendproof.core;

import io.github.mprync.sendproof.core.CaptureModels.CaptureTiming;

/** Measures the auth, handler, database and serialization phases of one request. */
public final class CaptureClock {
    private static final double NANOS_PER_MILLI = 1_000_000.0;
    private final long requestStart;
    private long handlerStart = -1;
    private long handlerEnd = -1;

    /** Creates a clock whose request started at the given {@link System#nanoTime()} value. */
    public CaptureClock(long requestStart) {
        this.requestStart = requestStart;
    }

    /** Marks the moment the handler is about to run. */
    public synchronized void startHandler() {
        handlerStart = System.nanoTime();
    }

    /** Marks the moment the handler returned. */
    public synchronized void endHandler() {
        handlerEnd = System.nanoTime();
    }

    /** Reads the timing with the recorded database and serialization time removed from the handler phase. */
    public synchronized CaptureTiming read(double db, int queries, double serialize, double extraSerializationMs) {
        long start = handlerStart < 0 ? requestStart : handlerStart;
        long end = handlerEnd < 0 ? System.nanoTime() : handlerEnd;
        return new CaptureTiming((start - requestStart) / NANOS_PER_MILLI,
                Math.max(0, (end - start) / NANOS_PER_MILLI - db - serialize), db, queries,
                serialize + extraSerializationMs);
    }
}

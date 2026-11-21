package dev.testbench.core;

/**
 * Holds the capture of the request running on the current thread. Logging appenders, SQL listeners and the
 * {@link TestBenchCapture} facade use it to find where to record. Work that moves to another thread is not captured.
 */
public final class CaptureContext {
    private static final ThreadLocal<RequestCapture> CURRENT = new ThreadLocal<>();

    private CaptureContext() {
    }

    /** Returns the capture for this thread, or {@code null}. */
    public static RequestCapture current() {
        return CURRENT.get();
    }

    /**
     * Returns the thread-local that holds the current capture, for coroutine integrations that must carry it across
     * threads (for example {@code threadLocal.asContextElement(capture)} in Kotlin). Prefer {@link #enter}.
     */
    public static ThreadLocal<RequestCapture> holder() {
        return CURRENT;
    }

    /** Makes {@code capture} current until the returned scope is closed, then restores the previous one. */
    public static Scope enter(RequestCapture capture) {
        RequestCapture previous = CURRENT.get();
        CURRENT.set(capture);
        return () -> {
            if (previous == null) {
                CURRENT.remove();
            } else {
                CURRENT.set(previous);
            }
        };
    }

    /** A restorable binding of the current capture. */
    @FunctionalInterface
    public interface Scope extends AutoCloseable {
        /** Restores the previous capture. */
        @Override
        void close();
    }
}

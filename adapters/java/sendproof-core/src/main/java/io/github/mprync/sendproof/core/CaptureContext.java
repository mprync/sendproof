package io.github.mprync.sendproof.core;

/**
 * Holds the capture of the request running on the current thread. Logging appenders, SQL listeners and the
 * {@link SendproofCapture} facade use it to find where to record. Work that moves to another thread is not captured.
 */
public final class CaptureContext {
    private static final ThreadLocal<RequestCapture> CURRENT = new ThreadLocal<>();

    private static final ThreadLocal<Boolean> ATTRIBUTED = new ThreadLocal<>();

    private CaptureContext() {
    }

    /**
     * Returns whether the work on this thread is attributed to a request: it runs inside a request an adapter marked, a
     * capture is current, or the code declared itself detached with {@link #detached}. A data store write that has no
     * attribution while a Preview is open fails that Preview, because nothing can say it isn't the Preview's own.
     */
    public static boolean attributed() {
        return ATTRIBUTED.get() != null || CURRENT.get() != null;
    }

    /**
     * Returns the thread-local that marks attributed work, for coroutine integrations that must carry it across threads
     * (for example {@code holder.asContextElement(true)} in Kotlin).
     */
    public static ThreadLocal<Boolean> attributionHolder() {
        return ATTRIBUTED;
    }

    /** Marks the work of the current thread as attributed until the returned scope is closed. Adapters mark every request. */
    public static Scope enterAttributed() {
        Boolean previous = ATTRIBUTED.get();
        ATTRIBUTED.set(Boolean.TRUE);
        return () -> {
            if (previous == null) {
                ATTRIBUTED.remove();
            } else {
                ATTRIBUTED.set(previous);
            }
        };
    }

    /**
     * Runs work that belongs to no request, such as a background worker or a scheduled job, declared detached: its data
     * store writes don't fail a Preview that happens to be open. Only declare work detached when it can never be part of a
     * Preview's handler.
     */
    public static void detached(Runnable work) {
        Scope scope = enterAttributed();
        try {
            work.run();
        } finally {
            scope.close();
        }
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

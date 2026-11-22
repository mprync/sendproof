package io.github.mprync.sendproof.firestore;

import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.RequestCapture;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The executor the Firestore client runs its transactions on, with the submitting request's capture carried over.
 *
 * <p>{@code runTransaction} runs the handler's function, and the {@code Commit} it ends with, on the client's executor.
 * Without this, those calls would reach the guard on a thread that knows nothing about the request (or the Preview) that
 * started them. Each task submitted here runs with the capture and the attribution of the thread that submitted it, so the
 * guard sees the right Preview and a blocked write marks the right capture.
 */
final class PropagatingExecutor implements ScheduledExecutorService {
    private final ScheduledExecutorService delegate;
    private final boolean checked;

    PropagatingExecutor(ScheduledExecutorService delegate) {
        this(delegate, false);
    }

    private PropagatingExecutor(ScheduledExecutorService delegate, boolean checked) {
        this.delegate = delegate;
        this.checked = checked;
    }

    /**
     * The executor of a {@link GuardedBulkWriter}: every task runs as a checked send ({@code StoreGuard.sendChecked}), with
     * no capture, whichever thread scheduled it. The writer only ever schedules sends of writes checked when they were
     * queued, and the context of the thread that scheduled one says nothing about them.
     */
    static PropagatingExecutor checkedSends(ScheduledExecutorService delegate) {
        return new PropagatingExecutor(delegate, true);
    }

    private <T> Callable<T> wrap(Callable<T> task) {
        return checked ? () -> io.github.mprync.sendproof.core.stores.StoreGuard.sendChecked(task::call) : carry(task);
    }

    private Runnable wrap(Runnable task) {
        return checked ? () -> io.github.mprync.sendproof.core.stores.StoreGuard.<Void, RuntimeException>sendChecked(() -> {
            task.run();
            return null;
        }) : carry(task);
    }

    /** The capture and attribution of a thread, to run work under later on another one. */
    record Context(RequestCapture capture, boolean attributed) {
        /** The calling thread's. */
        static Context current() {
            return new Context(CaptureContext.current(), CaptureContext.attributed());
        }

        /** Runs {@code work} under this context. */
        @SuppressWarnings("try")
        void run(Runnable work) {
            try (var ignoredCapture = capture == null ? null : CaptureContext.enter(capture);
                 var ignoredAttribution = attributed ? CaptureContext.enterAttributed() : null) {
                work.run();
            }
        }
    }

    /**
     * Wraps {@code task} so it runs with the capture and attribution of the thread that calls this. Used for the
     * continuations of a call as well: a transaction's {@code Commit} is sent from a callback on a gRPC thread.
     */
    static Runnable carry(Runnable task) {
        Callable<Object> carried = carry(() -> {
            task.run();
            return null;
        });
        return () -> {
            try {
                carried.call();
            } catch (RuntimeException | Error failure) {
                throw failure;
            } catch (Exception checked) {
                throw new IllegalStateException(checked);
            }
        };
    }

    @SuppressWarnings("try")
    private static <T> Callable<T> carry(Callable<T> task) {
        RequestCapture capture = CaptureContext.current();
        boolean attributed = CaptureContext.attributed();
        return () -> {
            try (var ignoredCapture = capture == null ? null : CaptureContext.enter(capture);
                 var ignoredAttribution = attributed ? CaptureContext.enterAttributed() : null) {
                return task.call();
            }
        };
    }

    private <T> List<Callable<T>> carryAll(Collection<? extends Callable<T>> tasks) {
        return tasks.stream().<Callable<T>>map(this::wrap).toList();
    }

    @Override
    public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
        return delegate.schedule(wrap(command), delay, unit);
    }

    @Override
    public <V> ScheduledFuture<V> schedule(Callable<V> callable, long delay, TimeUnit unit) {
        return delegate.schedule(wrap(callable), delay, unit);
    }

    @Override
    public ScheduledFuture<?> scheduleAtFixedRate(Runnable command, long initialDelay, long period, TimeUnit unit) {
        return delegate.scheduleAtFixedRate(wrap(command), initialDelay, period, unit);
    }

    @Override
    public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command, long initialDelay, long delay, TimeUnit unit) {
        return delegate.scheduleWithFixedDelay(wrap(command), initialDelay, delay, unit);
    }

    @Override
    public void execute(Runnable command) {
        delegate.execute(wrap(command));
    }

    @Override
    public <T> Future<T> submit(Callable<T> task) {
        return delegate.submit(wrap(task));
    }

    @Override
    public <T> Future<T> submit(Runnable task, T result) {
        return delegate.submit(wrap(task), result);
    }

    @Override
    public Future<?> submit(Runnable task) {
        return delegate.submit(wrap(task));
    }

    @Override
    public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks) throws InterruptedException {
        return delegate.invokeAll(carryAll(tasks));
    }

    @Override
    public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks, long timeout, TimeUnit unit) throws InterruptedException {
        return delegate.invokeAll(carryAll(tasks), timeout, unit);
    }

    @Override
    public <T> T invokeAny(Collection<? extends Callable<T>> tasks) throws InterruptedException, ExecutionException {
        return delegate.invokeAny(carryAll(tasks));
    }

    @Override
    public <T> T invokeAny(Collection<? extends Callable<T>> tasks, long timeout, TimeUnit unit)
            throws InterruptedException, ExecutionException, TimeoutException {
        return delegate.invokeAny(carryAll(tasks), timeout, unit);
    }

    @Override
    public void shutdown() {
        delegate.shutdown();
    }

    @Override
    public List<Runnable> shutdownNow() {
        return delegate.shutdownNow();
    }

    @Override
    public boolean isShutdown() {
        return delegate.isShutdown();
    }

    @Override
    public boolean isTerminated() {
        return delegate.isTerminated();
    }

    @Override
    public boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
        return delegate.awaitTermination(timeout, unit);
    }
}

package io.github.mprync.sendproof.elasticsearch;

import co.elastic.clients.elasticsearch._helpers.bulk.BulkIngester;
import co.elastic.clients.elasticsearch.core.bulk.BulkOperation;
import co.elastic.clients.util.ObjectBuilder;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.concurrent.Callable;
import java.util.concurrent.Delayed;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RunnableScheduledFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;

/**
 * A {@link BulkIngester} that refuses an operation when it is <em>queued</em>, on the caller's thread. The real ingester
 * sends its queue later, from its own scheduler, with optional automatic retries: a refusal at send time would be retried
 * (with a backoff policy) or lost on a thread with no request behind it. Made by {@link ElasticsearchStore#bulkIngester}.
 * When the queue is sent, the requests go through the store's guarded transport as well. (opensearch-java has no ingester;
 * its {@code BulkRequest} is an ordinary call that the transport refuses when it is made.)
 *
 * @param <C> the ingester's context type
 */
public final class GuardedBulkIngester<C> implements AutoCloseable {
    private final ElasticsearchStore store;
    private final BulkIngester<C> raw;
    private final ScheduledExecutorService scheduler;

    GuardedBulkIngester(ElasticsearchStore store, BulkIngester<C> raw, ScheduledExecutorService scheduler) {
        this.store = store;
        this.raw = raw;
        this.scheduler = scheduler;
    }

    /**
     * The ingester's scheduler: every task (a timed flush, a retry) runs as a checked send, with no capture. The ingester
     * only ever sends operations checked when they were queued, and its threads have no request behind them.
     */
    static ScheduledExecutorService scheduler() {
        var threads = new java.util.concurrent.atomic.AtomicInteger();
        return new ScheduledThreadPoolExecutor(2, task -> {
            Thread thread = new Thread(task, "sendproof-bulk-ingester-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        }) {
            @Override
            protected <V> RunnableScheduledFuture<V> decorateTask(Runnable runnable, RunnableScheduledFuture<V> task) {
                return new CheckedTask<>(task);
            }

            @Override
            protected <V> RunnableScheduledFuture<V> decorateTask(Callable<V> callable, RunnableScheduledFuture<V> task) {
                return new CheckedTask<>(task);
            }
        };
    }

    /** A scheduled task that runs as a checked send. */
    private record CheckedTask<V>(RunnableScheduledFuture<V> task) implements RunnableScheduledFuture<V> {
        @Override
        public void run() {
            StoreGuard.<Void, RuntimeException>sendChecked(() -> {
                task.run();
                return null;
            });
        }

        @Override
        public boolean isPeriodic() {
            return task.isPeriodic();
        }

        @Override
        public long getDelay(TimeUnit unit) {
            return task.getDelay(unit);
        }

        @Override
        public int compareTo(Delayed other) {
            return task.compareTo(other instanceof CheckedTask<?> checked ? checked.task : other);
        }

        @Override
        public boolean cancel(boolean mayInterruptIfRunning) {
            return task.cancel(mayInterruptIfRunning);
        }

        @Override
        public boolean isCancelled() {
            return task.isCancelled();
        }

        @Override
        public boolean isDone() {
            return task.isDone();
        }

        @Override
        public V get() throws InterruptedException, ExecutionException {
            return task.get();
        }

        @Override
        public V get(long timeout, TimeUnit unit) throws InterruptedException, ExecutionException, TimeoutException {
            return task.get(timeout, unit);
        }
    }

    /** Queues an operation. */
    public void add(BulkOperation operation) {
        store.queued();
        StoreGuard.<Void, RuntimeException>sendChecked(() -> {
            raw.add(operation);
            return null;
        });
    }

    /** Queues an operation with a context handed back to the listener. */
    public void add(BulkOperation operation, C context) {
        store.queued();
        StoreGuard.<Void, RuntimeException>sendChecked(() -> {
            raw.add(operation, context);
            return null;
        });
    }

    /** Queues an operation built by {@code fn}. */
    public void add(Function<BulkOperation.Builder, ObjectBuilder<BulkOperation>> fn) {
        store.queued();
        StoreGuard.<Void, RuntimeException>sendChecked(() -> {
            raw.add(fn);
            return null;
        });
    }

    /** Sends everything queued: operations checked when they were queued, whoever calls this. */
    public void flush() {
        StoreGuard.<Void, RuntimeException>sendChecked(() -> {
            raw.flush();
            return null;
        });
    }

    /** Operations queued and not yet sent. */
    public int pendingOperations() {
        return raw.pendingOperations();
    }

    /** Sends everything queued, closes the ingester and stops its scheduler. */
    @Override
    public void close() {
        try {
            StoreGuard.<Void, RuntimeException>sendChecked(() -> {
                raw.close();
                return null;
            });
        } finally {
            scheduler.shutdown();
        }
    }
}

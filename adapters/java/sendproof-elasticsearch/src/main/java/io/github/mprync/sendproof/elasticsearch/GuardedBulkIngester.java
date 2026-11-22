package io.github.mprync.sendproof.elasticsearch;

import co.elastic.clients.elasticsearch._helpers.bulk.BulkIngester;
import co.elastic.clients.elasticsearch.core.bulk.BulkOperation;
import co.elastic.clients.util.ObjectBuilder;
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

    GuardedBulkIngester(ElasticsearchStore store, BulkIngester<C> raw) {
        this.store = store;
        this.raw = raw;
    }

    /** Queues an operation. */
    public void add(BulkOperation operation) {
        store.queued();
        raw.add(operation);
    }

    /** Queues an operation with a context handed back to the listener. */
    public void add(BulkOperation operation, C context) {
        store.queued();
        raw.add(operation, context);
    }

    /** Queues an operation built by {@code fn}. */
    public void add(Function<BulkOperation.Builder, ObjectBuilder<BulkOperation>> fn) {
        store.queued();
        raw.add(fn);
    }

    /** Sends everything queued. */
    public void flush() {
        raw.flush();
    }

    /** Operations queued and not yet sent. */
    public int pendingOperations() {
        return raw.pendingOperations();
    }

    /** Sends everything queued and closes the ingester. */
    @Override
    public void close() {
        raw.close();
    }
}

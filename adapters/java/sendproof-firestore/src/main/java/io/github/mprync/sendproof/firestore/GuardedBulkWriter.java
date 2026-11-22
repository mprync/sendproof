package io.github.mprync.sendproof.firestore;

import com.google.api.core.ApiFuture;
import com.google.cloud.firestore.BulkWriter;
import com.google.cloud.firestore.DocumentReference;
import com.google.cloud.firestore.FieldPath;
import com.google.cloud.firestore.Precondition;
import com.google.cloud.firestore.SetOptions;
import com.google.cloud.firestore.WriteResult;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutionException;

/**
 * A {@link BulkWriter} that refuses a write when it is <em>queued</em>, on the caller's thread. The real writer sends its
 * queue later, in batches, with automatic retries: a refusal at send time would be retried until {@code flush} or
 * {@code close} never returns. Made by {@link FirestoreStore#bulkWriter}. A write allowed when it was queued is sent as
 * the queuing request's, whichever thread flushes it, so a Preview handler that flushes a shared writer doesn't refuse
 * other requests' writes, and a flush on the client's own threads isn't taken for an unattributed write.
 */
public final class GuardedBulkWriter implements AutoCloseable {
    private final FirestoreStore store;
    private final BulkWriter raw;
    private final java.util.concurrent.ExecutorService owned;

    /** @param owned the executor made for this writer, shut down on close, or {@code null} for one the caller gave */
    GuardedBulkWriter(FirestoreStore store, BulkWriter raw, java.util.concurrent.ExecutorService owned) {
        this.store = store;
        this.raw = raw;
        this.owned = owned;
    }

    private void queued() {
        store.queued("BatchWrite").complete(null, null);
    }

    /**
     * Hands a checked write, a flush or a close to the real writer. Whatever it sends now or schedules for later (on the
     * client's executor, which carries this context) is only writes checked when they were queued.
     */
    private static <T> T send(java.util.function.Supplier<T> work) {
        return StoreGuard.sendChecked(work::get);
    }

    /** Queues a create. */
    public ApiFuture<WriteResult> create(DocumentReference document, Map<String, Object> fields) {
        queued();
        return send(() -> raw.create(document, fields));
    }

    /** Queues a create. */
    public ApiFuture<WriteResult> create(DocumentReference document, Object pojo) {
        queued();
        return send(() -> raw.create(document, pojo));
    }

    /** Queues a delete. */
    public ApiFuture<WriteResult> delete(DocumentReference document) {
        queued();
        return send(() -> raw.delete(document));
    }

    /** Queues a delete. */
    public ApiFuture<WriteResult> delete(DocumentReference document, Precondition precondition) {
        queued();
        return send(() -> raw.delete(document, precondition));
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Map<String, Object> fields) {
        queued();
        return send(() -> raw.set(document, fields));
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Map<String, Object> fields, SetOptions options) {
        queued();
        return send(() -> raw.set(document, fields, options));
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Object pojo, SetOptions options) {
        queued();
        return send(() -> raw.set(document, pojo, options));
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Object pojo) {
        queued();
        return send(() -> raw.set(document, pojo));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Map<String, Object> fields) {
        queued();
        return send(() -> raw.update(document, fields));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Map<String, Object> fields, Precondition precondition) {
        queued();
        return send(() -> raw.update(document, fields, precondition));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, String field, Object value, Object... more) {
        queued();
        return send(() -> raw.update(document, field, value, more));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, FieldPath field, Object value, Object... more) {
        queued();
        return send(() -> raw.update(document, field, value, more));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Precondition precondition, String field, Object value, Object... more) {
        queued();
        return send(() -> raw.update(document, precondition, field, value, more));
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Precondition precondition, FieldPath field, Object value, Object... more) {
        queued();
        return send(() -> raw.update(document, precondition, field, value, more));
    }

    /** Sends everything queued. */
    public ApiFuture<Void> flush() {
        return send(raw::flush);
    }

    /** Sends everything queued and closes the writer. */
    @Override
    public void close() throws InterruptedException, ExecutionException {
        try {
            StoreGuard.<Void, Exception>sendChecked(() -> {
                raw.close();
                return null;
            });
        } catch (InterruptedException | ExecutionException | RuntimeException expected) {
            throw expected;
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        } finally {
            if (owned != null) {
                owned.shutdown();
            }
        }
    }

    /** Registers a callback for each write result. */
    public void addWriteResultListener(BulkWriter.WriteResultCallback callback) {
        raw.addWriteResultListener(callback);
    }

    /** Registers a callback for each write result. */
    public void addWriteResultListener(Executor executor, BulkWriter.WriteResultCallback callback) {
        raw.addWriteResultListener(executor, callback);
    }

    /** Registers a callback for each write error. */
    public void addWriteErrorListener(BulkWriter.WriteErrorCallback callback) {
        raw.addWriteErrorListener(callback);
    }

    /** Registers a callback for each write error. */
    public void addWriteErrorListener(Executor executor, BulkWriter.WriteErrorCallback callback) {
        raw.addWriteErrorListener(executor, callback);
    }
}

package io.github.mprync.sendproof.firestore;

import com.google.api.core.ApiFuture;
import com.google.cloud.firestore.BulkWriter;
import com.google.cloud.firestore.DocumentReference;
import com.google.cloud.firestore.FieldPath;
import com.google.cloud.firestore.Precondition;
import com.google.cloud.firestore.SetOptions;
import com.google.cloud.firestore.WriteResult;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutionException;

/**
 * A {@link BulkWriter} that refuses a write when it is <em>queued</em>, on the caller's thread. The real writer sends its
 * queue later, in batches, with automatic retries: a refusal at send time would be retried until {@code flush} or
 * {@code close} never returns. Made by {@link FirestoreStore#bulkWriter}. Writes go through the same RPC layer when they
 * are sent, so they are checked there too.
 */
public final class GuardedBulkWriter implements AutoCloseable {
    private final FirestoreStore store;
    private final BulkWriter raw;

    GuardedBulkWriter(FirestoreStore store, BulkWriter raw) {
        this.store = store;
        this.raw = raw;
    }

    private void queued() {
        store.queued("BatchWrite").complete(null, null);
    }

    /** Queues a create. */
    public ApiFuture<WriteResult> create(DocumentReference document, Map<String, Object> fields) {
        queued();
        return raw.create(document, fields);
    }

    /** Queues a create. */
    public ApiFuture<WriteResult> create(DocumentReference document, Object pojo) {
        queued();
        return raw.create(document, pojo);
    }

    /** Queues a delete. */
    public ApiFuture<WriteResult> delete(DocumentReference document) {
        queued();
        return raw.delete(document);
    }

    /** Queues a delete. */
    public ApiFuture<WriteResult> delete(DocumentReference document, Precondition precondition) {
        queued();
        return raw.delete(document, precondition);
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Map<String, Object> fields) {
        queued();
        return raw.set(document, fields);
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Map<String, Object> fields, SetOptions options) {
        queued();
        return raw.set(document, fields, options);
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Object pojo, SetOptions options) {
        queued();
        return raw.set(document, pojo, options);
    }

    /** Queues a set. */
    public ApiFuture<WriteResult> set(DocumentReference document, Object pojo) {
        queued();
        return raw.set(document, pojo);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Map<String, Object> fields) {
        queued();
        return raw.update(document, fields);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Map<String, Object> fields, Precondition precondition) {
        queued();
        return raw.update(document, fields, precondition);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, String field, Object value, Object... more) {
        queued();
        return raw.update(document, field, value, more);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, FieldPath field, Object value, Object... more) {
        queued();
        return raw.update(document, field, value, more);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Precondition precondition, String field, Object value, Object... more) {
        queued();
        return raw.update(document, precondition, field, value, more);
    }

    /** Queues an update. */
    public ApiFuture<WriteResult> update(DocumentReference document, Precondition precondition, FieldPath field, Object value, Object... more) {
        queued();
        return raw.update(document, precondition, field, value, more);
    }

    /** Sends everything queued. */
    public ApiFuture<Void> flush() {
        return raw.flush();
    }

    /** Sends everything queued and closes the writer. */
    @Override
    public void close() throws InterruptedException, ExecutionException {
        raw.close();
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

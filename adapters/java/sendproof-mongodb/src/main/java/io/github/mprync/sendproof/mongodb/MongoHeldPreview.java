package io.github.mprync.sendproof.mongodb;

import com.mongodb.MongoNamespace;
import com.mongodb.client.model.FindOneAndReplaceOptions;
import com.mongodb.client.model.FindOneAndUpdateOptions;
import com.mongodb.client.model.ReplaceOptions;
import com.mongodb.client.model.UpdateOptions;
import com.mongodb.internal.client.model.bulk.AbstractClientNamespacedWriteModel;
import io.github.mprync.sendproof.core.HeldPreview;
import io.github.mprync.sendproof.core.PreviewChange;
import io.github.mprync.sendproof.core.RequestCapture;
import io.github.mprync.sendproof.core.stores.CommandKind;
import io.github.mprync.sendproof.core.stores.PreviewTransactionControlException;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.bson.BsonArray;
import org.bson.BsonBoolean;
import org.bson.BsonDocument;
import org.bson.BsonInt32;
import org.bson.BsonString;
import org.bson.BsonValue;
import org.bson.RawBsonDocument;
import org.bson.codecs.BsonDocumentCodec;

/** A snapshot transaction with a document undo journal per step. MongoDB has no transaction savepoints. */
@SuppressWarnings("try")
final class MongoHeldPreview implements HeldPreview {
    private static final String ENDED = "MongoDB ended the Preview session's transaction.";
    private static final int DOCUMENT_LIMIT = 1_000;
    private static final String CAPACITY = String.format(Locale.ROOT,
            "Preview unavailable: this MongoDB write would exceed the %,d-document limit for a Preview session", DOCUMENT_LIMIT);
    private static final Set<String> DOCUMENT_WRITES = Set.of("insert", "update", "delete", "findandmodify", "bulkwrite");
    private static final BsonDocument SIMPLE_COLLATION = new BsonDocument("locale", new BsonString("simple"));
    private static final BsonDocumentCodec BSON_CODEC = new BsonDocumentCodec();
    private final MongoEngine engine;
    private final MongoEngine.Transaction transaction;
    private final SessionBinder binder;
    private final List<Point> points = new ArrayList<>();
    private Turn active;
    private int undoCount;

    MongoHeldPreview(MongoEngine engine, MongoEngine.Transaction transaction, SessionBinder binder) {
        this.engine = engine;
        this.transaction = transaction;
        this.binder = binder;
    }

    @Override
    public Checkpoint checkpoint() throws TransactionEnded, UnsafeTransaction {
        requireInactive();
        checkTransaction();
        var point = new Point();
        points.add(point);
        return point;
    }

    @Override
    public Step begin(RequestCapture capture) throws TransactionEnded, UnsafeTransaction {
        requireInactive();
        checkStatus();
        Point point = points.get(points.size() - 1);
        if (point.entered || !capture.inPreviewScope()) {
            throw new IllegalStateException("MongoDB needs a new checkpoint and a Preview capture for each step.");
        }
        var turn = new Turn(point, capture);
        turn.state = engine.enroll(transaction, capture, binder, turn);
        active = turn;
        point.entered = true;
        return turn;
    }

    @Override
    public void close() throws UnsafeTransaction {
        try {
            if (active != null) {
                active.close();
            }
        } finally {
            points.clear();
            undoCount = 0;
            if (!engine.end(transaction)) {
                throw new UnsafeTransaction("MongoDB did not acknowledge the Preview transaction abort.", null);
            }
        }
    }

    private void requireInactive() {
        if (active != null) {
            throw new IllegalStateException("The MongoDB Preview step is still open.");
        }
    }

    private void checkStatus() throws TransactionEnded, UnsafeTransaction {
        if (transaction.unsafe != null) {
            throw new UnsafeTransaction("The MongoDB Preview transaction cannot be verified.", transaction.unsafe);
        }
        if (transaction.serverEnded != null) {
            throw new TransactionEnded(ENDED, transaction.serverEnded);
        }
        if (transaction.finished || !engine.backend().inTransaction(transaction.session)) {
            throw new UnsafeTransaction("The MongoDB driver lost control of the Preview transaction.", null);
        }
    }

    private void checkTransaction() throws TransactionEnded, UnsafeTransaction {
        checkStatus();
        // An idle transaction can expire on the server while the driver still reports it active.
        MongoNamespace probe = transaction.probe;
        if (probe != null) {
            inTransaction(() -> engine.backend().find(probe.getDatabaseName(), probe.getCollectionName(), new BsonDocument(),
                    new BsonDocument("_id", new BsonInt32(1)), 1, transaction.session));
        }
    }

    private <T> T inTransaction(java.util.function.Supplier<T> work) throws TransactionEnded, UnsafeTransaction {
        try {
            return engine.internal(work);
        } catch (RuntimeException failure) {
            if (MongoEngine.transactionEnded(failure)) {
                transaction.serverEnded = failure;
                throw new TransactionEnded(ENDED, failure);
            }
            transaction.unsafe = failure;
            throw new UnsafeTransaction("MongoDB could not read or restore the Preview transaction.", failure);
        }
    }

    private record Image(MongoNamespace namespace, BsonValue id, BsonDocument before, boolean existedAfter) {
    }

    private final class Point implements Checkpoint {
        private final List<Image> undo = new ArrayList<>();
        private boolean entered;
        private boolean captured;

        @Override
        public void rollback() throws TransactionEnded, UnsafeTransaction {
            requireInactive();
            int index = points.indexOf(this);
            if (index < 0) {
                throw new IllegalStateException("The MongoDB checkpoint has already been released.");
            }
            checkTransaction();
            for (int i = points.size() - 1; i >= index; i--) {
                Point point = points.get(i);
                if (point.entered && !point.captured) {
                    throw new UnsafeTransaction("The MongoDB step ended before its undo journal was complete.", null);
                }
                inTransaction(() -> {
                    // Delete step versions first so restoring a unique value cannot collide with another step version.
                    for (Image change : point.undo) {
                        if (change.existedAfter()) {
                            restore(change, false);
                        }
                    }
                    for (Image change : point.undo) {
                        if (change.before() != null) {
                            restore(change, true);
                        }
                    }
                    return null;
                });
            }
            releaseFrom(index);
        }

        @Override
        public void discard() {
            int index = points.indexOf(this);
            if (index >= 0) {
                releaseFrom(index);
            }
        }
    }

    private void releaseFrom(int index) {
        var released = points.subList(index, points.size());
        for (Point point : released) {
            if (point.captured) {
                undoCount -= point.undo.size();
            }
        }
        released.clear();
    }

    private void restore(Image image, boolean replace) {
        String operation = replace ? "update" : "delete";
        BsonDocument entry = new BsonDocument("q", new BsonDocument("_id", new BsonDocument("$eq", image.id())))
                .append("collation", SIMPLE_COLLATION);
        if (replace) {
            entry.append("u", image.before()).append("upsert", BsonBoolean.TRUE);
        } else {
            entry.append("limit", new BsonInt32(1));
        }
        BsonDocument command = new BsonDocument(operation, new BsonString(image.namespace().getCollectionName()))
                .append(replace ? "updates" : "deletes", new BsonArray(List.of(entry)));
        BsonDocument reply = engine.backend().command(image.namespace().getDatabaseName(), command, transaction.session);
        if (reply.containsKey("writeErrors") || reply.containsKey("writeConcernError")
                || reply.getNumber("n", new BsonInt32(0)).intValue() != 1) {
            throw new IllegalStateException("MongoDB did not restore a document at the Preview checkpoint.");
        }
    }

    private Map<ByteBuffer, BsonDocument> read(MongoNamespace namespace, int limit) {
        Map<ByteBuffer, BsonDocument> images = new LinkedHashMap<>();
        for (BsonDocument document : engine.backend().find(namespace.getDatabaseName(), namespace.getCollectionName(),
                new BsonDocument(), null, limit, transaction.session)) {
            ByteBuffer id = bsonBytes(new BsonDocument("_id", document.get("_id")));
            if (images.putIfAbsent(id, document) != null) {
                throw new IllegalStateException("MongoDB returned non-unique document IDs in one collection.");
            }
        }
        return images;
    }

    /** BSON field order matters to MongoDB, including in document-valued IDs. */
    private static ByteBuffer bsonBytes(BsonDocument document) {
        var bytes = new RawBsonDocument(document, BSON_CODEC).getByteBuffer();
        try {
            return bytes.asNIO().asReadOnlyBuffer();
        } finally {
            bytes.release();
        }
    }

    final class Turn implements Step {
        private final Point point;
        private final RequestCapture capture;
        // Read lazily, before the first write to that collection. The reads are inside the same transaction, so they
        // see previous steps and honor the exact snapshot even for changing filters, collations and bulk writes.
        private final Map<MongoNamespace, Map<ByteBuffer, BsonDocument>> before = new LinkedHashMap<>();
        private final Set<MongoNamespace> prepared = ConcurrentHashMap.newKeySet();
        private MongoEngine.PreviewState state;
        private volatile boolean sealed;
        private int beforeCount;
        private int reservedInserts;

        Turn(Point point, RequestCapture capture) {
            this.point = point;
            this.capture = capture;
        }

        synchronized void prepare(String operation, List<MongoNamespace> namespaces, int possibleInserts) {
            if (sealed) {
                throw new PreviewTransactionControlException("The MongoDB Preview step has ended.");
            }
            if (transaction.unsafe != null || transaction.serverEnded != null) {
                throw new IllegalStateException("The MongoDB Preview transaction is no longer available.");
            }
            if (!engine.backend().inTransaction(transaction.session)) {
                var fault = new PreviewTransactionControlException("The MongoDB driver lost control of the Preview transaction.");
                transaction.unsafe = fault;
                throw fault;
            }
            int remaining = DOCUMENT_LIMIT - undoCount - beforeCount - reservedInserts - possibleInserts;
            if (remaining < 0) {
                StoreGuard.guard(capture, "mongodb", operation, CommandKind.WRITE, CAPACITY);
            }
            var added = new LinkedHashMap<MongoNamespace, Map<ByteBuffer, BsonDocument>>();
            for (MongoNamespace namespace : namespaces) {
                if (MongoEngine.systemDatabase(namespace.getDatabaseName()) || namespace.getCollectionName().startsWith("system.")) {
                    StoreGuard.guard(capture, "mongodb", operation, CommandKind.WRITE, StoreGuard.refusedReason(operation));
                }
                if (!prepared.contains(namespace) && !added.containsKey(namespace)) {
                    Map<ByteBuffer, BsonDocument> images;
                    try {
                        int limit = remaining + 1;
                        images = engine.internal(() -> read(namespace, limit));
                    } catch (RuntimeException failure) {
                        if (MongoEngine.transactionEnded(failure)) {
                            transaction.serverEnded = failure;
                        } else {
                            transaction.unsafe = failure;
                        }
                        throw failure;
                    }
                    if (images.size() > remaining) {
                        StoreGuard.guard(capture, "mongodb", operation, CommandKind.WRITE, CAPACITY);
                    }
                    remaining -= images.size();
                    added.put(namespace, images);
                }
            }
            before.putAll(added);
            prepared.addAll(added.keySet());
            reservedInserts += possibleInserts;
            beforeCount = DOCUMENT_LIMIT - undoCount - reservedInserts - remaining;
        }

        void observeWrite(RequestCapture owner, BsonDocument command, String database, String operation) {
            List<MongoNamespace> namespaces = writeTargets(command, database, operation);
            if (sealed || owner != capture || namespaces.isEmpty() || !prepared.containsAll(namespaces)) {
                var fault = new PreviewTransactionControlException("A MongoDB write bypassed the Preview step's before-image capture.");
                transaction.unsafe = fault;
                capture.refuse(fault);
            }
        }

        @Override
        public synchronized void finish() throws TransactionEnded, UnsafeTransaction {
            if (point.captured) {
                return;
            }
            sealed = true;
            engine.seal(state);
            checkStatus();
            if (before.isEmpty()) {
                checkTransaction();
            }
            for (var entry : before.entrySet()) {
                MongoNamespace namespace = entry.getKey();
                int limit = entry.getValue().size() + reservedInserts;
                Map<ByteBuffer, BsonDocument> after = inTransaction(() -> read(namespace, limit + 1));
                if (after.size() > limit) {
                    throw new UnsafeTransaction("MongoDB exceeded the Preview session's reserved document limit.", null);
                }
                for (var original : entry.getValue().entrySet()) {
                    BsonDocument first = original.getValue();
                    record(namespace, first.get("_id"), first, after.remove(original.getKey()));
                }
                for (BsonDocument inserted : after.values()) {
                    record(namespace, inserted.get("_id"), null, inserted);
                }
            }
            before.clear();
            checkStatus();
            undoCount += point.undo.size();
            point.captured = true;
        }

        private void record(MongoNamespace namespace, BsonValue id, BsonDocument first, BsonDocument last)
                throws UnsafeTransaction {
            if (first != null && last != null && first.equals(last) && bsonBytes(first).equals(bsonBytes(last))) {
                return;
            }
            if (undoCount + point.undo.size() >= DOCUMENT_LIMIT) {
                throw new UnsafeTransaction("MongoDB exceeded the Preview session's undo limit.", null);
            }
            point.undo.add(new Image(namespace, id, first, last != null));
            String operation = first == null ? "insert" : last == null ? "delete" : "update";
            capture.change(new PreviewChange(operation, namespace.getCollectionName(), Map.of("_id", BsonPlain.plain(id)),
                    first == null ? null : BsonPlain.plain(first), last == null ? null : BsonPlain.plain(last),
                    "mongodb", namespace.getDatabaseName(), null));
        }

        @Override
        public synchronized void close() {
            if (active != this) {
                return;
            }
            sealed = true;
            try {
                engine.unbind(state);
            } finally {
                active = null;
                before.clear();
            }
        }
    }

    static List<MongoNamespace> writeTargets(BsonDocument command, String database, String operation) {
        String lower = operation.toLowerCase(Locale.ROOT);
        if (!DOCUMENT_WRITES.contains(lower)) {
            return List.of();
        }
        if ("bulkwrite".equals(lower) && command.get("nsInfo") instanceof BsonArray infos) {
            return infos.stream().map(info -> new MongoNamespace(info.asDocument().getString("ns").getValue())).toList();
        }
        BsonValue collection = command.get(command.getFirstKey());
        return database != null && collection instanceof BsonString name
                ? List.of(new MongoNamespace(database, name.getValue())) : List.of();
    }

    static List<MongoNamespace> clientBulkTargets(Object[] arguments) {
        for (Object argument : arguments) {
            if (argument instanceof List<?> models) {
                var namespaces = new ArrayList<MongoNamespace>();
                for (Object model : models) {
                    if (!(model instanceof AbstractClientNamespacedWriteModel namespaced)) {
                        return List.of();
                    }
                    namespaces.add(namespaced.getNamespace());
                }
                return namespaces;
            }
        }
        return List.of();
    }

    /** Counts an upper bound on how many documents a command can add to the before-image set. */
    static int possibleInserts(boolean raw, String method, String operation, BsonDocument command, Object[] arguments) {
        if (raw) {
            return switch (operation.toLowerCase(Locale.ROOT)) {
                case "insert" -> array(command, "documents").size();
                case "update" -> (int) array(command, "updates").stream().filter(value -> upsert(value.asDocument())).count();
                case "findandmodify" -> upsert(command) ? 1 : 0;
                case "bulkwrite" -> array(command, "ops").size();
                default -> 0;
            };
        }
        if ("insertOne".equals(method)) {
            return 1;
        }
        for (Object argument : arguments) {
            if (("insertMany".equals(method) || "bulkWrite".equals(method)) && argument instanceof List<?> models) {
                return models.size();
            }
            if (argument instanceof UpdateOptions options && options.isUpsert()
                    || argument instanceof ReplaceOptions replace && replace.isUpsert()
                    || argument instanceof FindOneAndUpdateOptions modify && modify.isUpsert()
                    || argument instanceof FindOneAndReplaceOptions findReplace && findReplace.isUpsert()) {
                return 1;
            }
        }
        return 0;
    }

    private static BsonArray array(BsonDocument command, String key) {
        return command.get(key) instanceof BsonArray values ? values : new BsonArray();
    }

    private static boolean upsert(BsonDocument command) {
        return BsonBoolean.TRUE.equals(command.get("upsert"));
    }
}

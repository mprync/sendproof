package io.github.mprync.sendproof.mongodb;

import com.mongodb.ReadConcern;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;
import org.bson.BsonBinary;
import org.bson.BsonDocument;

/** The synchronous driver's backend: a source of sessions and databases, never the guarded ones. */
final class SyncBackend implements MongoBackend {
    private final Supplier<ClientSession> sessions;
    private final Function<String, MongoDatabase> databases;

    SyncBackend(Supplier<ClientSession> sessions, Function<String, MongoDatabase> databases) {
        this.sessions = sessions;
        this.databases = databases;
    }

    @Override
    public boolean reactive() {
        return false;
    }

    @Override
    public Class<?> sessionType() {
        return ClientSession.class;
    }

    @Override
    public Class<?> clientType() {
        return com.mongodb.client.MongoClient.class;
    }

    @Override
    public Class<?> clusterType() {
        return com.mongodb.client.MongoCluster.class;
    }

    @Override
    public Class<?> databaseType() {
        return MongoDatabase.class;
    }

    @Override
    public Class<?> collectionType() {
        return MongoCollection.class;
    }

    @Override
    public Object startTransaction() {
        ClientSession session = sessions.get();
        try {
            session.startTransaction(TransactionOptions.builder().readConcern(ReadConcern.SNAPSHOT)
                    .writeConcern(WriteConcern.MAJORITY).build());
        } catch (RuntimeException failure) {
            session.close();
            throw failure;
        }
        return session;
    }

    @Override
    public String lsid(Object session) {
        return hex(((ClientSession) session).getServerSession().getIdentifier().getBinary("id"));
    }

    @Override
    public boolean inTransaction(Object session) {
        return ((ClientSession) session).hasActiveTransaction();
    }

    @Override
    public void abort(Object session) {
        try {
            ClientSession real = (ClientSession) session;
            if (real.hasActiveTransaction()) {
                real.abortTransaction();
            }
        } catch (RuntimeException ignored) {
            // The abort is best effort: an unacknowledged abort still commits nothing, because no commitTransaction is
            // ever sent for the Preview session.
        }
    }

    @Override
    public void end(Object session) {
        try {
            ((ClientSession) session).close();
        } catch (RuntimeException ignored) {
            // Ending is best effort.
        }
    }

    @Override
    public BsonDocument command(String database, BsonDocument command, Object session) {
        MongoDatabase target = databases.apply(database);
        return session == null ? target.runCommand(command, BsonDocument.class)
                : target.runCommand((ClientSession) session, command, BsonDocument.class);
    }

    @Override
    public List<BsonDocument> find(String database, String collection, BsonDocument filter, BsonDocument projection,
                                   int limit, Object session) {
        MongoCollection<BsonDocument> target = databases.apply(database).getCollection(collection, BsonDocument.class);
        var iterable = session == null ? target.find(filter) : target.find((ClientSession) session, filter);
        if (projection != null) {
            iterable = iterable.projection(projection);
        }
        return iterable.limit(limit).into(new ArrayList<>());
    }

    @Override
    public Object failed(RuntimeException failure) {
        throw failure;
    }

    @Override
    public Object returned(Object value) {
        return value;
    }

    static String hex(BsonBinary binary) {
        var text = new StringBuilder();
        for (byte value : binary.getData()) {
            text.append(String.format("%02x", value));
        }
        return text.toString();
    }
}

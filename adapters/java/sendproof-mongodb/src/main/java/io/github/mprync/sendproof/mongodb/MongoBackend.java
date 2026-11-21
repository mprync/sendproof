package io.github.mprync.sendproof.mongodb;

import java.util.List;
import org.bson.BsonDocument;

/**
 * The blocking driver operations the engine needs, over either driver flavor (synchronous, or reactive streams
 * blocked on). The engine's own commands (topology, change capture, abort) go through here, always on the unguarded
 * handles, and are ignored by monitoring.
 */
interface MongoBackend {

    /** Whether this backend wraps the reactive streams driver. */
    boolean reactive();

    /** The driver's {@code ClientSession} interface for this flavor: what guarded handles accept as a session. */
    Class<?> sessionType();

    /** The driver's {@code MongoClient} interface for this flavor. */
    Class<?> clientType();

    /** The driver's {@code MongoCluster} interface for this flavor, which {@code withReadPreference} and the like return. */
    Class<?> clusterType();

    /** The driver's {@code MongoDatabase} interface for this flavor. */
    Class<?> databaseType();

    /** The driver's {@code MongoCollection} interface for this flavor. */
    Class<?> collectionType();

    /** Starts a session and its transaction (read concern {@code snapshot}, write concern {@code majority}). */
    Object startTransaction();

    /** Returns the hex of the session's logical session id, comparable with the {@code lsid} of a monitored command. */
    String lsid(Object session);

    /** Whether the session still has an active transaction. */
    boolean inTransaction(Object session);

    /** Aborts the session's transaction on the server. Errors are swallowed, as the transactions specification requires. */
    void abort(Object session);

    /** Ends the session. */
    void end(Object session);

    /** Runs a command on a database, in the session's transaction when one is given. */
    BsonDocument command(String database, BsonDocument command, Object session);

    /** Finds documents with {@code find}, in the session's transaction when one is given. */
    List<BsonDocument> find(String database, String collection, BsonDocument filter, BsonDocument projection, int limit,
                            Object session);

    /** The failure a guarded handle returns where the driver returns a {@code Publisher}; sync backends throw instead. */
    Object failed(RuntimeException failure);
}

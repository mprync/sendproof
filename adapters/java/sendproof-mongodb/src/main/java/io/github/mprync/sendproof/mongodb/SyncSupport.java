package io.github.mprync.sendproof.mongodb;

import com.mongodb.ClientSessionOptions;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoDatabase;
import java.util.function.Function;
import java.util.function.Supplier;

/** The synchronous driver's entry points, kept apart so a host without the reactive driver never loads its types. */
final class SyncSupport {
    private SyncSupport() {
    }

    static MongoBackend backend(MongoClient client) {
        return new SyncBackend(() -> client.startSession(ClientSessionOptions.builder().build()), client::getDatabase);
    }

    @SuppressWarnings("unchecked")
    static MongoBackend backend(Supplier<?> sessions, Function<String, ?> databases) {
        return new SyncBackend((Supplier<ClientSession>) sessions, (Function<String, MongoDatabase>) databases);
    }
}

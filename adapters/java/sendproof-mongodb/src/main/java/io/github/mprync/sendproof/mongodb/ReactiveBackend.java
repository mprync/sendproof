package io.github.mprync.sendproof.mongodb;

import com.mongodb.ReadConcern;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import com.mongodb.reactivestreams.client.ClientSession;
import com.mongodb.reactivestreams.client.MongoClient;
import com.mongodb.reactivestreams.client.MongoCollection;
import com.mongodb.reactivestreams.client.MongoDatabase;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import org.bson.BsonDocument;
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

/**
 * The reactive streams driver's backend. The engine's own commands block the calling thread until the publisher
 * completes; they run on a worker thread, never on an event loop.
 */
final class ReactiveBackend implements MongoBackend {
    private final MongoClient client;

    ReactiveBackend(MongoClient client) {
        this.client = client;
    }

    @Override
    public boolean reactive() {
        return true;
    }

    @Override
    public Class<?> sessionType() {
        return ClientSession.class;
    }

    @Override
    public Class<?> clientType() {
        return com.mongodb.reactivestreams.client.MongoClient.class;
    }

    @Override
    public Class<?> clusterType() {
        return com.mongodb.reactivestreams.client.MongoCluster.class;
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
        ClientSession session = first(client.startSession());
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
        return SyncBackend.hex(((ClientSession) session).getServerSession().getIdentifier().getBinary("id"));
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
                first(real.abortTransaction());
            }
        } catch (RuntimeException ignored) {
            // Best effort: no commitTransaction is ever sent for the Preview session.
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
        MongoDatabase target = client.getDatabase(database);
        return first(session == null ? target.runCommand(command, BsonDocument.class)
                : target.runCommand((ClientSession) session, command, BsonDocument.class));
    }

    @Override
    public BsonDocument command(String database, BsonDocument command, long timeoutMs) {
        return first(client.getDatabase(database).withTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                .runCommand(command, BsonDocument.class));
    }

    @Override
    public List<BsonDocument> find(String database, String collection, BsonDocument filter, BsonDocument projection,
                                   int limit, Object session) {
        MongoCollection<BsonDocument> target = client.getDatabase(database).getCollection(collection, BsonDocument.class);
        var publisher = session == null ? target.find(filter) : target.find((ClientSession) session, filter);
        if (projection != null) {
            publisher = publisher.projection(projection);
        }
        return all(publisher.limit(limit));
    }

    @Override
    public Object failed(RuntimeException failure) {
        return (Publisher<Object>) subscriber -> {
            subscriber.onSubscribe(new Subscription() {
                @Override
                public void request(long n) {
                    // The failure is signalled once, on subscription.
                }

                @Override
                public void cancel() {
                    // Nothing to release.
                }
            });
            subscriber.onError(failure);
        };
    }

    @Override
    public Object returned(Object value) {
        return (Publisher<Object>) subscriber -> subscriber.onSubscribe(new Subscription() {
            private boolean done;

            @Override
            public void request(long n) {
                if (!done && n > 0) {
                    done = true;
                    subscriber.onNext(value);
                    subscriber.onComplete();
                }
            }

            @Override
            public void cancel() {
                done = true;
            }
        });
    }

    /** Blocks for the first element of a publisher, or {@code null} when it completes empty. */
    static <T> T first(Publisher<T> publisher) {
        List<T> values = all(publisher, 1);
        return values.isEmpty() ? null : values.get(0);
    }

    static <T> List<T> all(Publisher<T> publisher) {
        return all(publisher, Long.MAX_VALUE);
    }

    private static <T> List<T> all(Publisher<T> publisher, long limit) {
        var done = new CompletableFuture<List<T>>();
        publisher.subscribe(new Subscriber<T>() {
            private final List<T> values = new ArrayList<>();
            private Subscription subscription;

            @Override
            public void onSubscribe(Subscription subscription) {
                this.subscription = subscription;
                subscription.request(limit);
            }

            @Override
            public void onNext(T value) {
                values.add(value);
                if (values.size() >= limit) {
                    subscription.cancel();
                    done.complete(values);
                }
            }

            @Override
            public void onError(Throwable error) {
                done.completeExceptionally(error);
            }

            @Override
            public void onComplete() {
                done.complete(values);
            }
        });
        try {
            return done.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting for MongoDB.", interrupted);
        } catch (ExecutionException | CompletionException failure) {
            Throwable cause = failure.getCause() == null ? failure : failure.getCause();
            if (cause instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new IllegalStateException(cause);
        }
    }
}

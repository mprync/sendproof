package io.github.mprync.sendproof.spring;

import com.mongodb.ClientSessionOptions;
import com.mongodb.MongoClientSettings;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoDatabase;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import io.github.mprync.sendproof.mongodb.MongoStore;
import io.github.mprync.sendproof.mongodb.SessionBinder;
import org.bson.codecs.configuration.CodecRegistry;
import org.springframework.dao.support.PersistenceExceptionTranslator;
import org.springframework.data.mongodb.MongoDatabaseFactory;
import org.springframework.transaction.support.ResourceHolderSupport;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * The Spring Data MongoDB hook. The application's {@link MongoDatabaseFactory} is replaced by a decorator whose
 * databases are guarded handles, and the Preview's session is bound as the thread's Spring Data MongoDB session, so
 * {@code MongoTemplate}, repositories and the application's own {@code @Transactional} methods join the Preview
 * transaction natively. During a Preview Spring Data finds that session through the same resource key it uses for its
 * own transactions, so a handler's {@code PROPAGATION_REQUIRED} transaction participates and never commits.
 */
final class SpringMongoHook {
    private SpringMongoHook() {
    }

    /** Hooks a factory with {@code store}, or returns it unchanged when it is already hooked or the store is attached. */
    static MongoDatabaseFactory hook(MongoStore store, MongoDatabaseFactory factory) {
        if (factory instanceof Guarded || store.attached()) {
            return factory;
        }
        var guarded = new Guarded(factory, store);
        store.attachSync(() -> factory.getSession(ClientSessionOptions.builder().build()), factory::getMongoDatabase,
                new Binder(guarded));
        return guarded;
    }

    /** Binds the Preview's session where Spring Data MongoDB looks for the ambient session. */
    private record Binder(MongoDatabaseFactory factory) implements SessionBinder {
        @Override
        public void bind(Object session) {
            if (TransactionSynchronizationManager.hasResource(factory)) {
                throw new IllegalStateException("A MongoDB transaction is already bound to this thread, so a Preview can't start.");
            }
            TransactionSynchronizationManager.bindResource(factory, holder((ClientSession) session));
        }

        @Override
        public void unbind() {
            TransactionSynchronizationManager.unbindResourceIfPossible(factory);
        }

        /**
         * Spring Data MongoDB's {@code MongoResourceHolder} is package-private, so it is built reflectively. It is the
         * same holder {@code MongoTransactionManager} binds for its own transactions.
         */
        private ResourceHolderSupport holder(ClientSession session) {
            try {
                Class<?> type = Class.forName("org.springframework.data.mongodb.MongoResourceHolder");
                var constructor = type.getDeclaredConstructor(ClientSession.class, MongoDatabaseFactory.class);
                constructor.setAccessible(true);
                Object holder = constructor.newInstance(session, factory);
                var synchronize = type.getMethod("setSynchronizedWithTransaction", boolean.class);
                synchronize.setAccessible(true);
                synchronize.invoke(holder, true);
                return (ResourceHolderSupport) holder;
            } catch (ReflectiveOperationException | ClassCastException error) {
                throw new IllegalStateException("This Spring Data MongoDB version isn't supported by Sendproof's session binding.", error);
            }
        }
    }

    /** A {@link MongoDatabaseFactory} whose databases, and those of its session-bound copies, are guarded. */
    static final class Guarded implements MongoDatabaseFactory {
        private final MongoDatabaseFactory delegate;
        private final MongoStore store;

        Guarded(MongoDatabaseFactory delegate, MongoStore store) {
            this.delegate = delegate;
            this.store = store;
        }

        @Override
        public MongoDatabase getMongoDatabase() {
            return store.guard(delegate.getMongoDatabase());
        }

        @Override
        public MongoDatabase getMongoDatabase(String name) {
            return store.guard(delegate.getMongoDatabase(name));
        }

        @Override
        public PersistenceExceptionTranslator getExceptionTranslator() {
            return delegate.getExceptionTranslator();
        }

        @Override
        public CodecRegistry getCodecRegistry() {
            return delegate.getCodecRegistry();
        }

        @Override
        public ClientSession getSession(ClientSessionOptions options) {
            if (StoreGuard.currentPreview() != null) {
                // A new session during a Preview would run its writes, and its commit, outside the Preview transaction.
                throw StoreGuard.refuseInPreview("A new MongoDB session was requested during a Preview; its writes would escape the rollback.");
            }
            return delegate.getSession(options);
        }

        @Override
        public MongoDatabaseFactory withSession(ClientSession session) {
            return new Guarded(delegate.withSession(session), store);
        }

        @Override
        public boolean isTransactionActive() {
            return delegate.isTransactionActive();
        }

        /** The default codec registry, for callers that need it without a database. */
        static CodecRegistry defaultRegistry() {
            return MongoClientSettings.getDefaultCodecRegistry();
        }
    }
}

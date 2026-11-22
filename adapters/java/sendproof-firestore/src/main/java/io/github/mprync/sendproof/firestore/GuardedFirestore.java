package io.github.mprync.sendproof.firestore;

import com.google.cloud.firestore.BulkWriterOptions;
import com.google.cloud.firestore.Firestore;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * The proxy behind {@link FirestoreStore#firestore}: the client itself, over the guarded RPC layer, with the calls that
 * hand out a {@code BulkWriter} checked on the caller's thread.
 *
 * <p>{@code BulkWriter} is a final class, so the client can't hand out a guarded one. Instead {@code bulkWriter()} (with or
 * without options) and {@code recursiveDelete} (which runs a writer of its own) are refused during a Preview when they are
 * called, before anything is queued: a writer exists to write. A writer made outside a Preview and used inside one is
 * still refused when it sends, and that refusal fails its writes rather than hanging {@code flush} or {@code close}
 * ({@link RpcGuard}). A writer given its own executor gets it wrapped so its sends keep the queuing request's context.
 */
final class GuardedFirestore implements InvocationHandler {
    private final FirestoreStore store;
    private final Firestore raw;

    private GuardedFirestore(FirestoreStore store, Firestore raw) {
        this.store = store;
        this.raw = raw;
    }

    /** Wraps a client whose RPC layer this store already guards; the result is also a {@link FirestoreStore.GuardedClient}. */
    static Firestore wrap(FirestoreStore store, Firestore raw) {
        return (Firestore) Proxy.newProxyInstance(FirestoreStore.class.getClassLoader(),
                new Class<?>[] {Firestore.class, FirestoreStore.GuardedClient.class}, new GuardedFirestore(store, raw));
    }

    /** The client behind a guarded one, or {@code db} itself. */
    static Firestore unwrap(Firestore db) {
        return db != null && Proxy.isProxyClass(db.getClass()) && Proxy.getInvocationHandler(db) instanceof GuardedFirestore guarded
                ? guarded.raw : db;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String name = method.getName();
        if (method.getDeclaringClass() == Object.class) {
            return switch (name) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Sendproof-guarded " + raw;
            };
        }
        if (method.getDeclaringClass() == FirestoreStore.GuardedClient.class) {
            return store;
        }
        if (name.equals("bulkWriter") || name.equals("recursiveDelete")) {
            // Refused during a Preview (and while one is open, on a thread no request owns) before anything is queued.
            store.queued("BatchWrite").complete(null, null);
            if (name.equals("bulkWriter") && args != null && args.length == 1 && args[0] instanceof BulkWriterOptions options
                    && options.getExecutor() != null && !(options.getExecutor() instanceof PropagatingExecutor)) {
                args = new Object[] {options.toBuilder().setExecutor(new PropagatingExecutor(options.getExecutor())).build()};
            }
        }
        try {
            return method.invoke(raw, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }
}

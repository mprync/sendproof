package io.github.mprync.sendproof.firestore;

import com.fasterxml.jackson.databind.JsonNode;
import com.google.api.core.ApiFuture;
import com.google.api.core.ApiFutureCallback;
import com.google.api.core.ApiFutures;
import com.google.api.gax.rpc.ApiCallContext;
import com.google.api.gax.rpc.ApiException;
import com.google.api.gax.rpc.BidiStreamingCallable;
import com.google.api.gax.rpc.ClientStream;
import com.google.api.gax.rpc.ClientStreamReadyObserver;
import com.google.api.gax.rpc.ResponseObserver;
import com.google.api.gax.rpc.ServerStreamingCallable;
import com.google.api.gax.rpc.StreamController;
import com.google.api.gax.rpc.UnaryCallable;
import com.google.cloud.firestore.spi.v1.FirestoreRpc;
import com.google.common.util.concurrent.MoreExecutors;
import com.google.firestore.v1.CommitRequest;
import com.google.protobuf.MessageOrBuilder;
import com.google.protobuf.util.JsonFormat;
import io.github.mprync.sendproof.core.Json;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore.Observation;
import io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException;
import io.github.mprync.sendproof.core.stores.StoreClassifier;
import io.github.mprync.sendproof.core.stores.StoreRedaction;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.ScheduledExecutorService;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The proxy behind {@link FirestoreStore#rpc}: the client's {@code FirestoreRpc}, whose callables are the one place every
 * call passes on the thread that made it, before the library schedules it on its own executor and before gRPC sees it.
 *
 * <p>Each callable is wrapped by what it returns ({@code UnaryCallable}, {@code ServerStreamingCallable},
 * {@code BidiStreamingCallable}) and classified by its RPC, which is its method's name: a callable this version of the
 * library adds is a method of an unknown service name and so a write, and is refused during a Preview. The typed request
 * is available, so {@code Commit} is classified by whether it carries writes without any parsing.
 */
final class RpcGuard implements InvocationHandler {
    private static final String SERVICE = "/google.firestore.v1.Firestore/";
    private static final Pattern DATABASE = Pattern.compile("databases/([^/]+)");

    private final FirestoreStore store;
    private final FirestoreRpc raw;
    private ScheduledExecutorService executorSource;
    private ScheduledExecutorService carried;

    private RpcGuard(FirestoreStore store, FirestoreRpc raw) {
        this.store = store;
        this.raw = raw;
    }

    /** Wraps {@code raw}; the result is also a {@link FirestoreStore.GuardedRpc}. */
    static FirestoreRpc wrap(FirestoreStore store, FirestoreRpc raw) {
        return (FirestoreRpc) Proxy.newProxyInstance(FirestoreStore.class.getClassLoader(),
                new Class<?>[] {FirestoreRpc.class, FirestoreStore.GuardedRpc.class}, new RpcGuard(store, raw));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        if (method.getDeclaringClass() == Object.class) {
            return switch (method.getName()) {
                case "equals" -> proxy == args[0];
                case "hashCode" -> System.identityHashCode(proxy);
                default -> "Sendproof-guarded " + raw;
            };
        }
        if (method.getDeclaringClass() == FirestoreStore.GuardedRpc.class) {
            return store;
        }
        Object result;
        try {
            result = method.invoke(raw, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
        if (method.getName().equals("getExecutor") && result instanceof ScheduledExecutorService executor) {
            // A transaction runs its function, and its Commit, on this executor: carry the request's capture across.
            synchronized (this) {
                if (executorSource != executor) {
                    executorSource = executor;
                    carried = new PropagatingExecutor(executor);
                }
                return carried;
            }
        }
        if (result == null || !method.getName().endsWith("Callable")) {
            return result;
        }
        String rpc = rpcName(method.getName());
        if (result instanceof UnaryCallable<?, ?> unary) {
            return unary(rpc, unary);
        }
        if (result instanceof ServerStreamingCallable<?, ?> streaming) {
            return streaming(rpc, streaming);
        }
        if (result instanceof BidiStreamingCallable<?, ?> bidi) {
            return bidi(rpc, bidi);
        }
        return result;
    }

    /** {@code commitCallable} is {@code Commit}; {@code listCollectionIdsPagedCallable} is {@code ListCollectionIds}. */
    static String rpcName(String callable) {
        String name = callable.replaceFirst("PagedCallable$", "").replaceFirst("Callable$", "");
        return name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }

    /** Guards the call and starts its entry; throws the Preview exception for a refused write. */
    private Observation begin(String rpc, Object request) {
        Integer writes = rpc.equals("Commit") && request instanceof CommitRequest commit ? Integer.valueOf(commit.getWritesCount()) : null;
        Observation call = store.start(StoreClassifier.firestore(SERVICE + rpc, writes, store.hostReads()));
        if (call.logged() && request instanceof MessageOrBuilder message) {
            describe(call, message);
        }
        return call;
    }

    private <Q, R> UnaryCallable<Q, R> unary(String rpc, UnaryCallable<Q, R> delegate) {
        return new UnaryCallable<>() {
            @Override
            public ApiFuture<R> futureCall(Q request, ApiCallContext context) {
                Observation call;
                try {
                    call = begin(rpc, request);
                } catch (PreviewWriteBlockedException refused) {
                    if (rpc.equals("BatchWrite")) {
                        // Only a BulkWriter sends BatchWrite, from inside its own scheduling, where an exception thrown
                        // here (or a failure that isn't an ApiException) escapes its bookkeeping and leaves flush and
                        // close waiting forever. A FAILED_PRECONDITION ApiException fails each queued write instead; the
                        // writer doesn't retry that code, so flush and close return.
                        return ApiFutures.immediateFailedFuture(new com.google.api.gax.rpc.FailedPreconditionException(refused,
                                com.google.api.gax.grpc.GrpcStatusCode.of(io.grpc.Status.Code.FAILED_PRECONDITION), false));
                    }
                    throw refused;
                }
                ApiFuture<R> future = delegate.futureCall(request, context);
                ApiFutures.addCallback(future, new ApiFutureCallback<>() {
                    @Override
                    public void onFailure(Throwable failure) {
                        call.finish(null, errorName(failure));
                    }

                    @Override
                    public void onSuccess(R response) {
                        call.finish(null, null);
                    }
                }, MoreExecutors.directExecutor());
                return new CarryingFuture<>(future);
            }
        };
    }

    /**
     * A future whose continuations run with the capture of the thread that registered them. The library chains a
     * transaction's steps (begin, the handler's function, commit) as callbacks, and a callback otherwise runs on whichever
     * thread completed the step before it, which has no request behind it.
     */
    private static final class CarryingFuture<V> implements ApiFuture<V> {
        private final ApiFuture<V> delegate;

        CarryingFuture(ApiFuture<V> delegate) {
            this.delegate = delegate;
        }

        @Override
        public void addListener(Runnable listener, java.util.concurrent.Executor executor) {
            delegate.addListener(PropagatingExecutor.carry(listener), executor);
        }

        @Override
        public boolean cancel(boolean mayInterruptIfRunning) {
            return delegate.cancel(mayInterruptIfRunning);
        }

        @Override
        public boolean isCancelled() {
            return delegate.isCancelled();
        }

        @Override
        public boolean isDone() {
            return delegate.isDone();
        }

        @Override
        public V get() throws InterruptedException, java.util.concurrent.ExecutionException {
            return delegate.get();
        }

        @Override
        public V get(long timeout, java.util.concurrent.TimeUnit unit)
                throws InterruptedException, java.util.concurrent.ExecutionException, java.util.concurrent.TimeoutException {
            return delegate.get(timeout, unit);
        }
    }

    private <Q, R> ServerStreamingCallable<Q, R> streaming(String rpc, ServerStreamingCallable<Q, R> delegate) {
        return new ServerStreamingCallable<>() {
            @Override
            public void call(Q request, ResponseObserver<R> observer, ApiCallContext context) {
                Observation call = begin(rpc, request);
                delegate.call(request, closing(observer, call), context);
            }
        };
    }

    private <Q, R> BidiStreamingCallable<Q, R> bidi(String rpc, BidiStreamingCallable<Q, R> delegate) {
        return new BidiStreamingCallable<>() {
            @Override
            public ClientStream<Q> internalCall(ResponseObserver<R> observer, ClientStreamReadyObserver<Q> ready, ApiCallContext context) {
                // A stream opens before its first message: Listen is a read, Write (and any other) is refused here.
                Observation call = begin(rpc, null);
                return delegate.internalCall(closing(observer, call), ready, context);
            }
        };
    }

    /** Completes the entry when the stream ends, and runs the caller's callbacks under the capture of the thread that made the call. */
    private static <R> ResponseObserver<R> closing(ResponseObserver<R> observer, Observation call) {
        PropagatingExecutor.Context context = PropagatingExecutor.Context.current();
        return new ResponseObserver<>() {
            @Override
            public void onStart(StreamController controller) {
                context.run(() -> observer.onStart(controller));
            }

            @Override
            public void onResponse(R response) {
                context.run(() -> observer.onResponse(response));
            }

            @Override
            public void onError(Throwable failure) {
                call.finish(null, errorName(failure));
                context.run(() -> observer.onError(failure));
            }

            @Override
            public void onComplete() {
                call.finish(null, null);
                context.run(observer::onComplete);
            }
        };
    }

    /** The store's error code name for a failure: {@code NOT_FOUND}, or the exception's type name. */
    private static String errorName(Throwable failure) {
        return failure instanceof ApiException api ? api.getStatusCode().getCode().name() : failure.getClass().getSimpleName();
    }

    /** Adds the target collection, the database and the sanitized message to an entry. */
    static void describe(Observation call, MessageOrBuilder message) {
        try {
            JsonNode tree = Json.MAPPER.readTree(JsonFormat.printer().omittingInsignificantWhitespace().print(message));
            String statement = StoreRedaction.sanitizeDocument(Json.MAPPER.convertValue(tree, Object.class)).toString();
            call.describe(collection(tree), database(tree), statement);
        } catch (java.io.IOException | RuntimeException unreadable) {
            // Logging must never break a call.
        }
    }

    /** The collection a message names: a query's first {@code from}, a {@code collectionId}, or a document path's parent. */
    static String collection(JsonNode message) {
        JsonNode from = message.path("structuredQuery").path("from").path(0).path("collectionId");
        if (from.isTextual()) {
            return from.asText();
        }
        if (message.path("collectionId").isTextual()) {
            return message.path("collectionId").asText();
        }
        for (JsonNode candidate : new JsonNode[] {
                message.path("name"), message.path("documents").path(0), message.path("writes").path(0).path("update").path("name"),
                message.path("writes").path(0).path("delete"), message.path("parent")}) {
            if (candidate.isTextual()) {
                String path = candidate.asText();
                int documents = path.indexOf("/documents");
                if (documents >= 0) {
                    String last = null;
                    String previous = null;
                    int count = 0;
                    for (String part : path.substring(documents + "/documents".length()).split("/")) {
                        if (!part.isEmpty()) {
                            previous = last;
                            last = part;
                            count++;
                        }
                    }
                    if (count > 0) {
                        return count % 2 == 0 ? previous : last;
                    }
                }
            }
        }
        return null;
    }

    /** The database id a message names ({@code projects/p/databases/(default)}), or {@code null}. */
    static String database(JsonNode message) {
        for (String field : new String[] {"database", "parent", "name"}) {
            if (message.path(field).isTextual()) {
                Matcher matcher = DATABASE.matcher(message.path(field).asText());
                if (matcher.find()) {
                    return matcher.group(1);
                }
            }
        }
        return null;
    }
}

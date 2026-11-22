package io.github.mprync.sendproof.firestore;

import com.google.api.core.ApiFuture;
import com.google.api.core.ApiFutures;
import com.google.api.gax.rpc.ApiCallContext;
import com.google.api.gax.rpc.BidiStreamingCallable;
import com.google.api.gax.rpc.ClientStream;
import com.google.api.gax.rpc.ClientStreamReadyObserver;
import com.google.api.gax.rpc.ResponseObserver;
import com.google.api.gax.rpc.ServerStreamingCallable;
import com.google.api.gax.rpc.StreamController;
import com.google.api.gax.rpc.UnaryCallable;
import com.google.cloud.firestore.spi.v1.FirestoreRpc;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A {@code FirestoreRpc} that goes nowhere and writes down what reaches it: the "fake transport" the recordings replay
 * against. {@link #reached} holds {@code "<Rpc>"} for every call and {@link #messages} the request messages, in order.
 */
final class FakeRpc {
    final List<String> reached = Collections.synchronizedList(new ArrayList<>());
    final List<Object> messages = Collections.synchronizedList(new ArrayList<>());
    final FirestoreRpc rpc = (FirestoreRpc) Proxy.newProxyInstance(FirestoreRpc.class.getClassLoader(), new Class<?>[] {FirestoreRpc.class},
            (proxy, method, args) -> {
                String name = method.getName();
                if (!name.endsWith("Callable")) {
                    return null;
                }
                String rpcName = RpcGuard.rpcName(name);
                if (UnaryCallable.class.isAssignableFrom(method.getReturnType())) {
                    return new UnaryCallable<Object, Object>() {
                        @Override
                        public ApiFuture<Object> futureCall(Object request, ApiCallContext context) {
                            record(rpcName, request);
                            return ApiFutures.immediateFuture(null);
                        }
                    };
                }
                if (ServerStreamingCallable.class.isAssignableFrom(method.getReturnType())) {
                    return new ServerStreamingCallable<Object, Object>() {
                        @Override
                        public void call(Object request, ResponseObserver<Object> observer, ApiCallContext context) {
                            record(rpcName, request);
                            observer.onStart(new StreamController() {
                                @Override
                                public void cancel() {
                                }

                                @Override
                                public void disableAutoInboundFlowControl() {
                                }

                                @Override
                                public void request(int count) {
                                }
                            });
                            observer.onComplete();
                        }
                    };
                }
                return new BidiStreamingCallable<Object, Object>() {
                    @Override
                    public ClientStream<Object> internalCall(ResponseObserver<Object> observer, ClientStreamReadyObserver<Object> ready,
                                                             ApiCallContext context) {
                        record(rpcName, null);
                        return null;
                    }
                };
            });

    private void record(String rpcName, Object message) {
        reached.add(rpcName);
        if (message != null) {
            messages.add(message);
        }
    }
}

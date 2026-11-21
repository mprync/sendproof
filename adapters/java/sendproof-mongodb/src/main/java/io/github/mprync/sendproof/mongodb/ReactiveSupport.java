package io.github.mprync.sendproof.mongodb;

import com.mongodb.ContextProvider;
import com.mongodb.RequestContext;
import com.mongodb.reactivestreams.client.MongoClient;
import com.mongodb.reactivestreams.client.ReactiveContextProvider;
import io.github.mprync.sendproof.core.CaptureContext;
import org.reactivestreams.Subscriber;

/** The reactive streams driver's entry points, kept apart so a host without that driver never loads its types. */
final class ReactiveSupport {
    private ReactiveSupport() {
    }

    static MongoBackend backend(MongoClient client) {
        return new ReactiveBackend(client);
    }

    /**
     * The context provider a reactive client must be built with ({@code MongoClientSettings.Builder#contextProvider}).
     * The reactive driver reports command events on its own threads, so each operation carries the request's capture
     * from the thread that subscribes to it, where the capture is still current.
     */
    static ContextProvider contextProvider() {
        return new ReactiveContextProvider() {
            @Override
            public RequestContext getContext(Subscriber<?> subscriber) {
                return new CaptureRequestContext(CaptureContext.current(), MongoEngine.INTERNAL.get() != null);
            }
        };
    }
}

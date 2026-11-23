package io.github.mprync.sendproof.mongodb;

import com.mongodb.ContextProvider;
import com.mongodb.RequestContext;
import com.mongodb.reactivestreams.client.MongoClient;
import com.mongodb.reactivestreams.client.ReactiveContextProvider;
import io.github.mprync.sendproof.core.CaptureContext;
import io.github.mprync.sendproof.core.RequestCapture;
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import reactor.core.CoreSubscriber;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** The reactive streams driver's entry points, kept apart so a host without that driver never loads its types. */
final class ReactiveSupport {
    private static final Object STEP_CAPTURE = new Object();

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
                RequestCapture capture = subscriber instanceof CoreSubscriber<?> core
                        ? core.currentContext().getOrDefault(STEP_CAPTURE, CaptureContext.current())
                        : CaptureContext.current();
                return new CaptureRequestContext(capture, MongoEngine.INTERNAL.get() != null,
                        capture != null || CaptureContext.attributed());
            }
        };
    }

    /** Reads before images on a worker, and only when the caller subscribes to a write. */
    static Object prepareWrite(Object publisher, RequestCapture capture, Runnable prepare) {
        return Mono.fromRunnable(prepare).subscribeOn(Schedulers.boundedElastic())
                .then(Mono.from((Publisher<?>) publisher).contextWrite(context -> context.put(STEP_CAPTURE, capture)));
    }
}

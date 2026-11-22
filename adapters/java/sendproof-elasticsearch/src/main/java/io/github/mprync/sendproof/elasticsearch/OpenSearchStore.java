package io.github.mprync.sendproof.elasticsearch;

import io.github.mprync.sendproof.core.stores.GuardOnlyStore;
import io.github.mprync.sendproof.core.stores.StoreClassifier.Classified;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import jakarta.json.stream.JsonGenerator;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.opensearch.client.json.JsonpMapper;
import org.opensearch.client.json.JsonpSerializable;
import org.opensearch.client.json.NdJsonpSerializable;
import org.opensearch.client.opensearch.OpenSearchAsyncClient;
import org.opensearch.client.opensearch.OpenSearchClient;
import org.opensearch.client.opensearch.generic.Body;
import org.opensearch.client.transport.Endpoint;
import org.opensearch.client.transport.OpenSearchTransport;
import org.opensearch.client.transport.TransportOptions;

/**
 * Sendproof write guard for OpenSearch ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>{@link #transport} decorates the {@code OpenSearchTransport} an {@code opensearch-java} 2 client is built on, the
 * same way {@link ElasticsearchStore} decorates Elasticsearch's. Every typed call, and the generic client's SQL, PPL and
 * plugin calls, end in {@code performRequest}, which sees the endpoint's HTTP method, path and body. Reads run; during a
 * Preview the first write is refused before the request is sent
 * ({@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}), and the Preview answers 409.
 *
 * <pre>{@code
 * OpenSearchStore search = OpenSearchStore.builder().name("articles").build();
 * OpenSearchClient client = search.client(ApacheHttpClient5TransportBuilder.builder(host).setMapper(mapper).build());
 * }</pre>
 *
 * <p>The table is the one Elasticsearch uses ({@code spec/data-stores/elasticsearch.json}); OpenSearch's SQL endpoints
 * ({@code _plugins/_sql}, {@code _opendistro/_sql}) read only for one {@code SELECT}, {@code SHOW} or {@code DESCRIBE}
 * statement, because its legacy SQL engine can run {@code DELETE}. A body the guard can't read again (a generic request
 * given a one-shot stream) is not read, so a SQL request carrying one is a write. Spring Boot hooks every
 * {@code OpenSearchTransport} bean. Only a hooked transport is covered.
 */
public final class OpenSearchStore extends GuardOnlyStore implements SearchSupport.Starter {
    private OpenSearchStore(Builder builder) {
        super("opensearch", builder.name, builder.reads);
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Configures an {@link OpenSearchStore}. */
    public static final class Builder {
        private String name;
        private Set<String> reads;

        private Builder() {
        }

        /** A display label for discovery such as {@code articles}; never a URL or host. */
        public Builder name(String label) {
            this.name = StoreGuard.storeLabel(label);
            return this;
        }

        /**
         * Operation names (the table's endpoint ids, such as {@code search}) the host states never write, matched
         * exactly. This is the host's statement: an operation wrongly listed here is not blocked.
         */
        public Builder treatAsRead(String... operations) {
            this.reads = StoreGuard.readSet(Arrays.asList(operations), operation -> operation);
            return this;
        }

        /** Builds the store. */
        public OpenSearchStore build() {
            return new OpenSearchStore(this);
        }
    }

    /**
     * Decorates a transport so every request is checked before it is sent. Decorating a transport this store already
     * decorated returns it unchanged.
     */
    public OpenSearchTransport transport(OpenSearchTransport raw) {
        if (raw instanceof GuardedTransport guarded && guarded.store == this) {
            return raw;
        }
        return new GuardedTransport(this, raw);
    }

    /** A synchronous client over a guarded transport. */
    public OpenSearchClient client(OpenSearchTransport raw) {
        return new OpenSearchClient(transport(raw));
    }

    /** An asynchronous client over a guarded transport. */
    public OpenSearchAsyncClient asyncClient(OpenSearchTransport raw) {
        return new OpenSearchAsyncClient(transport(raw));
    }

    /** Whether {@code transport} is one this library guards, by any store. */
    public static boolean isGuarded(Object transport) {
        return transport instanceof GuardedTransport;
    }

    @Override
    public Observation start(Classified classified, String target, String statement) {
        return observe(classified, target, null, statement);
    }

    @Override
    public Set<String> hostReads() {
        return reads();
    }

    /** The decorator: checks each request, then hands it to the real transport. */
    static final class GuardedTransport implements OpenSearchTransport {
        private final OpenSearchStore store;
        private final OpenSearchTransport delegate;

        GuardedTransport(OpenSearchStore store, OpenSearchTransport delegate) {
            this.store = store;
            this.delegate = delegate;
        }

        private <Q, S, E> Observation check(Q request, Endpoint<Q, S, E> endpoint) {
            String path = endpoint.requestUrl(request);
            return SearchSupport.begin(store, endpoint.method(request), path == null ? "" : path,
                    () -> endpoint.hasRequestBody() ? lines(request, delegate.jsonpMapper()) : List.of());
        }

        @Override
        public <Q, S, E> S performRequest(Q request, Endpoint<Q, S, E> endpoint, TransportOptions options) throws IOException {
            Observation call = check(request, endpoint);
            try {
                S response = delegate.performRequest(request, endpoint, options);
                call.complete(null, null);
                return response;
            } catch (IOException | RuntimeException failure) {
                call.complete(null, failure);
                throw failure;
            }
        }

        @Override
        public <Q, S, E> CompletableFuture<S> performRequestAsync(Q request, Endpoint<Q, S, E> endpoint, TransportOptions options) {
            Observation call;
            try {
                call = check(request, endpoint);
            } catch (RuntimeException refused) {
                // The refusal is already marked on the Preview; the caller sees a failed future, as for any failed request.
                return CompletableFuture.failedFuture(refused);
            }
            return delegate.performRequestAsync(request, endpoint, options).whenComplete((response, failure) -> call.complete(null, failure));
        }

        @Override
        public JsonpMapper jsonpMapper() {
            return delegate.jsonpMapper();
        }

        @Override
        public TransportOptions options() {
            return delegate.options();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }

    /** The request body as JSON text, one entry per NDJSON line; empty when the guard can't read it. */
    private static List<String> lines(Object request, JsonpMapper mapper) {
        var lines = new ArrayList<String>();
        if (request instanceof NdJsonpSerializable nd) {
            for (Iterator<?> items = nd._serializables(); items.hasNext(); ) {
                lines.add(json(items.next(), mapper));
            }
        } else if (request instanceof JsonpSerializable serializable) {
            lines.add(json(serializable, mapper));
        } else if (request instanceof org.opensearch.client.opensearch.generic.Request generic && generic.getBody().isPresent()) {
            String text = readAgain(generic.getBody().get());
            if (text != null) {
                lines.addAll(Arrays.asList(text.split("\n")));
            }
        }
        return lines;
    }

    /**
     * Reads a generic body without consuming it, or {@code null} when its stream can't be rewound: the transport would
     * then send an empty body.
     */
    private static String readAgain(Body body) {
        try {
            InputStream stream = body.body();
            if (stream == null || !stream.markSupported()) {
                return null;
            }
            stream.mark(Integer.MAX_VALUE);
            String text = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            stream.reset();
            return text;
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
    }

    private static String json(Object value, JsonpMapper mapper) {
        var writer = new StringWriter();
        try (JsonGenerator generator = mapper.jsonProvider().createGenerator(writer)) {
            if (value instanceof JsonpSerializable serializable) {
                serializable.serialize(generator, mapper);
            } else {
                mapper.serialize(value, generator);
            }
        }
        return writer.toString();
    }
}

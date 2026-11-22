package io.github.mprync.sendproof.elasticsearch;

import co.elastic.clients.elasticsearch.ElasticsearchAsyncClient;
import co.elastic.clients.elasticsearch.ElasticsearchClient;
import co.elastic.clients.elasticsearch._helpers.bulk.BulkIngester;
import co.elastic.clients.json.JsonpMapper;
import co.elastic.clients.json.JsonpSerializable;
import co.elastic.clients.json.NdJsonpSerializable;
import co.elastic.clients.transport.ElasticsearchTransport;
import co.elastic.clients.transport.Endpoint;
import co.elastic.clients.transport.TransportOptions;
import io.github.mprync.sendproof.core.stores.GuardOnlyStore;
import io.github.mprync.sendproof.core.stores.StoreClassifier.Classified;
import io.github.mprync.sendproof.core.stores.StoreGuard;
import jakarta.json.stream.JsonGenerator;
import java.io.IOException;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Sendproof write guard for Elasticsearch ({@code guard} mode of {@code spec/data-stores.md}).
 *
 * <p>{@link #transport} decorates the {@code ElasticsearchTransport} an {@code elasticsearch-java} 8 client is built
 * on. Every typed call ends in {@code performRequest}, which sees the endpoint's HTTP method, path and body, so one hook
 * covers the whole API, sync and async, including the SQL endpoints. Reads run; during a Preview the first write is
 * refused before the request is built and sent
 * ({@link io.github.mprync.sendproof.core.stores.PreviewWriteBlockedException}), and the Preview answers 409.
 *
 * <pre>{@code
 * ElasticsearchStore search = ElasticsearchStore.builder().name("articles").build();
 * ElasticsearchClient client = search.client(new RestClientTransport(restClient, new JacksonJsonpMapper()));
 * }</pre>
 *
 * <p>Classification follows {@code spec/data-stores/elasticsearch.json}: {@code GET} and {@code HEAD} read, so do the
 * {@code POST} endpoints that take their query in the body ({@code _search}, {@code _count}, {@code _msearch}...), and
 * everything else is a write, including {@code _bulk}, {@code _update_by_query}, {@code _delete_by_query}, {@code _reindex}
 * and every {@code PUT}. A client derived from a hooked one ({@code withTransportOptions}) uses the same transport, so
 * it stays guarded. Spring Boot hooks every {@code ElasticsearchTransport} bean. Only a hooked transport is covered: a
 * low-level {@code RestClient} used directly is not.
 */
public final class ElasticsearchStore extends GuardOnlyStore implements SearchSupport.Starter {
    private ElasticsearchStore(Builder builder) {
        super("elasticsearch", builder.name, builder.reads);
    }

    /** Starts a store configuration. */
    public static Builder builder() {
        return new Builder();
    }

    /** Configures an {@link ElasticsearchStore}. */
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
         * Operation names (the table's endpoint ids, such as {@code search}, or {@code POST /{}/_future} for an unlisted
         * path) the host states never write, matched exactly. This is the host's statement: an operation wrongly listed
         * here is not blocked.
         */
        public Builder treatAsRead(String... operations) {
            this.reads = StoreGuard.readSet(Arrays.asList(operations), operation -> operation);
            return this;
        }

        /** Builds the store. */
        public ElasticsearchStore build() {
            return new ElasticsearchStore(this);
        }
    }

    /**
     * Decorates a transport so every request is checked before it is sent. Decorating a transport this store already
     * decorated returns it unchanged.
     */
    public ElasticsearchTransport transport(ElasticsearchTransport raw) {
        if (raw instanceof GuardedTransport guarded && guarded.store == this) {
            return raw;
        }
        return new GuardedTransport(this, raw);
    }

    /** A synchronous client over a guarded transport. */
    public ElasticsearchClient client(ElasticsearchTransport raw) {
        return new ElasticsearchClient(transport(raw));
    }

    /** An asynchronous client over a guarded transport. */
    public ElasticsearchAsyncClient asyncClient(ElasticsearchTransport raw) {
        return new ElasticsearchAsyncClient(transport(raw));
    }

    /**
     * A bulk ingester that refuses an operation when it is queued. Build the ingester on a client made by this store
     * ({@link #client}); the returned handle guards {@code add} and delegates the rest.
     */
    public <C> GuardedBulkIngester<C> bulkIngester(
            java.util.function.Function<BulkIngester.Builder<C>, BulkIngester.Builder<C>> builder) {
        return new GuardedBulkIngester<>(this, BulkIngester.of(builder));
    }

    /** Guards an operation being queued on the calling thread: a bulk write. */
    void queued() {
        observe(new Classified(io.github.mprync.sendproof.core.stores.CommandKind.WRITE, "bulk"), null, null, null).complete(null, null);
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
    static final class GuardedTransport implements ElasticsearchTransport {
        private final ElasticsearchStore store;
        private final ElasticsearchTransport delegate;

        GuardedTransport(ElasticsearchStore store, ElasticsearchTransport delegate) {
            this.store = store;
            this.delegate = delegate;
        }

        private <Q, S, E> Observation check(Q request, Endpoint<Q, S, E> endpoint) {
            String path = endpoint.requestUrl(request);
            return SearchSupport.begin(store, endpoint.method(request), path == null ? "" : path,
                    () -> lines(request, delegate.jsonpMapper()));
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

    /** The request body as JSON text, one entry per NDJSON line; empty when the request isn't JSON the guard can read. */
    private static List<String> lines(Object request, JsonpMapper mapper) {
        var lines = new ArrayList<String>();
        if (request instanceof NdJsonpSerializable nd) {
            for (Iterator<?> items = nd._serializables(); items.hasNext(); ) {
                lines.add(json(items.next(), mapper));
            }
        } else if (request instanceof JsonpSerializable serializable) {
            lines.add(json(serializable, mapper));
        }
        return lines;
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

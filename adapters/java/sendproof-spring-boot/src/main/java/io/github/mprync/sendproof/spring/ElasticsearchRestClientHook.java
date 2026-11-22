package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.elasticsearch.ElasticsearchStore;
import org.apache.http.impl.nio.client.HttpAsyncClientBuilder;
import org.elasticsearch.client.RestClientBuilder;
import org.springframework.boot.autoconfigure.elasticsearch.RestClientBuilderCustomizer;
import org.springframework.core.env.Environment;

/**
 * Hooks the low-level Elasticsearch {@code RestClient} Spring Boot builds (a bean of its own, and the base of the
 * {@code ElasticsearchTransport} bean {@link SearchStoreHook} guards): a raw {@code performRequest} through the bean is
 * guarded like a typed call ({@link ElasticsearchStore#hook}), and the typed client's requests, already checked by the
 * guarded transport, pass without a second check. Uses the same store as the transport hook.
 */
final class ElasticsearchRestClientHook implements RestClientBuilderCustomizer {
    private final SendproofStores stores;
    private final Environment environment;

    ElasticsearchRestClientHook(SendproofStores stores, Environment environment) {
        this.stores = stores;
        this.environment = environment;
    }

    @Override
    public void customize(RestClientBuilder builder) {
        // The HTTP client is customised below.
    }

    @Override
    public void customize(HttpAsyncClientBuilder builder) {
        if (!environment.getProperty("sendproof.stores.elasticsearch.enabled", Boolean.class, true)) {
            return;
        }
        stores.of(ElasticsearchStore.class,
                () -> ElasticsearchStore.builder().name(environment.getProperty("sendproof.stores.elasticsearch.name")).build())
                .hook(builder);
    }
}

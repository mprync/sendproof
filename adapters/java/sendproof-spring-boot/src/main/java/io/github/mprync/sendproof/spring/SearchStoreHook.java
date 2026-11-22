package io.github.mprync.sendproof.spring;

import co.elastic.clients.transport.ElasticsearchTransport;
import io.github.mprync.sendproof.elasticsearch.ElasticsearchStore;
import io.github.mprync.sendproof.elasticsearch.OpenSearchStore;
import java.util.Map;
import org.opensearch.client.transport.OpenSearchTransport;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.Environment;

/**
 * Hooks every {@code ElasticsearchTransport} and {@code OpenSearchTransport} bean as it is created: the bean is replaced by
 * a guarded transport, so the typed clients built on it (Spring Boot's {@code ElasticsearchClient}, Spring Data
 * Elasticsearch) are guarded. A store registered on the {@link Sendproof} builder or as a bean is used as is; otherwise an
 * automatic one is made, named by {@code sendproof.stores.elasticsearch.name} or {@code sendproof.stores.opensearch.name}.
 * Set {@code sendproof.stores.<store>.enabled=false} to leave one unhooked.
 *
 * <p>Like the other hooks it fails closed at startup: once every singleton exists, any transport bean that is not guarded
 * stops the application with an {@link IllegalStateException}. The class only references a client library's types inside
 * the methods that need it, so either library may be absent.
 */
final class SearchStoreHook implements BeanPostProcessor, BeanFactoryAware, SmartInitializingSingleton {
    private static final boolean ELASTICSEARCH = present("co.elastic.clients.transport.ElasticsearchTransport");
    private static final boolean OPENSEARCH = present("org.opensearch.client.transport.OpenSearchTransport");

    private final Environment environment;
    private BeanFactory beans;

    SearchStoreHook(Environment environment) {
        this.environment = environment;
    }

    private static boolean present(String type) {
        try {
            Class.forName(type, false, SearchStoreHook.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException | LinkageError absent) {
            return false;
        }
    }

    private boolean enabled(String store) {
        return environment.getProperty("sendproof.stores." + store + ".enabled", Boolean.class, true);
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        this.beans = beanFactory;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
        if (ELASTICSEARCH && bean instanceof ElasticsearchTransport transport && enabled("elasticsearch")
                && !ElasticsearchStore.isGuarded(bean)) {
            return beans.getBean(SendproofStores.class).of(ElasticsearchStore.class,
                    () -> ElasticsearchStore.builder().name(environment.getProperty("sendproof.stores.elasticsearch.name")).build())
                    .transport(transport);
        }
        if (OPENSEARCH && bean instanceof OpenSearchTransport transport && enabled("opensearch") && !OpenSearchStore.isGuarded(bean)) {
            return beans.getBean(SendproofStores.class).of(OpenSearchStore.class,
                    () -> OpenSearchStore.builder().name(environment.getProperty("sendproof.stores.opensearch.name")).build())
                    .transport(transport);
        }
        return bean;
    }

    @Override
    public void afterSingletonsInstantiated() {
        if (!(beans instanceof ListableBeanFactory listable)) {
            return;
        }
        if (ELASTICSEARCH && enabled("elasticsearch")) {
            for (Map.Entry<String, ElasticsearchTransport> entry : listable.getBeansOfType(ElasticsearchTransport.class).entrySet()) {
                require(ElasticsearchStore.isGuarded(entry.getValue()), entry.getKey(), "Elasticsearch");
            }
        }
        if (OPENSEARCH && enabled("opensearch")) {
            for (Map.Entry<String, OpenSearchTransport> entry : listable.getBeansOfType(OpenSearchTransport.class).entrySet()) {
                require(OpenSearchStore.isGuarded(entry.getValue()), entry.getKey(), "OpenSearch");
            }
        }
    }

    private static void require(boolean guarded, String bean, String store) {
        if (!guarded) {
            throw new IllegalStateException("The " + store + " transport bean '" + bean + "' is not guarded by Sendproof, so a Preview "
                    + "could write to " + store + " through it. Remove the bean's early creation, or set sendproof.stores."
                    + store.toLowerCase(java.util.Locale.ROOT) + ".enabled=false.");
        }
    }
}

package io.github.mprync.sendproof.spring;

import com.datastax.oss.driver.api.core.CqlSession;
import io.github.mprync.sendproof.cassandra.CassandraStore;
import java.util.Map;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.Environment;

/**
 * Hooks every {@link CqlSession} bean as it is created (Spring Boot's own, which {@code CqlTemplate} and the Spring Data
 * Cassandra repositories use): the bean is replaced by a guarded session. A {@link CassandraStore} registered on the
 * {@link Sendproof} builder or as a bean is used as is; otherwise an automatic one is made, named by
 * {@code sendproof.stores.cassandra.name}. Set {@code sendproof.stores.cassandra.enabled=false} to leave Cassandra unhooked.
 *
 * <p>A guard that a bean could slip past fails closed at startup: once every singleton exists, any {@code CqlSession} bean
 * that is not guarded (one created before this post-processor, or a bean definition that hands out a second session)
 * stops the application with an {@link IllegalStateException}.
 */
final class CassandraStoreHook implements BeanPostProcessor, BeanFactoryAware, SmartInitializingSingleton {
    private final Environment environment;
    private BeanFactory beans;

    CassandraStoreHook(Environment environment) {
        this.environment = environment;
    }

    private boolean enabled() {
        return environment.getProperty("sendproof.stores.cassandra.enabled", Boolean.class, true);
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        this.beans = beanFactory;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
        if (!(bean instanceof CqlSession session) || CassandraStore.isGuarded(bean) || !enabled()) {
            return bean;
        }
        CassandraStore store = beans.getBean(SendproofStores.class).of(CassandraStore.class,
                () -> CassandraStore.builder().name(environment.getProperty("sendproof.stores.cassandra.name")).build());
        return store.session(session);
    }

    @Override
    public void afterSingletonsInstantiated() {
        if (!enabled() || !(beans instanceof ListableBeanFactory listable)) {
            return;
        }
        for (Map.Entry<String, CqlSession> entry : listable.getBeansOfType(CqlSession.class).entrySet()) {
            if (!CassandraStore.isGuarded(entry.getValue())) {
                throw new IllegalStateException("The CqlSession bean '" + entry.getKey() + "' is not guarded by Sendproof, so a Preview "
                        + "could write to Cassandra through it. Remove the bean's early creation, or set sendproof.stores.cassandra.enabled=false.");
            }
        }
    }
}

package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.mongodb.MongoStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.Environment;
import org.springframework.data.mongodb.MongoDatabaseFactory;

/**
 * Hooks the application's {@link MongoDatabaseFactory} as its bean is created. It is replaced by a decorator, so
 * everything that injects it, such as {@code MongoTemplate}, repositories and the application's own Mongo transaction
 * manager, uses the guarded one. A {@link MongoStore} registered on the {@link Sendproof} builder or as a bean is used as
 * is; otherwise an automatic one is made, named by {@code sendproof.stores.mongodb.name}. Set
 * {@code sendproof.stores.mongodb.enabled=false} to leave MongoDB unhooked.
 *
 * <p>Only a factory Spring creates is hooked. A client the application builds elsewhere, or a second factory for the same
 * cluster, is not covered (see the data stores page of this module).
 */
final class MongoStoreHook implements BeanPostProcessor, BeanFactoryAware {
    private static final Logger LOG = LoggerFactory.getLogger(MongoStoreHook.class);

    private final Environment environment;
    private BeanFactory beans;

    MongoStoreHook(Environment environment) {
        this.environment = environment;
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        this.beans = beanFactory;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
        if (!(bean instanceof MongoDatabaseFactory factory)
                || !environment.getProperty("sendproof.stores.mongodb.enabled", Boolean.class, true)) {
            return bean;
        }
        MongoStore store = beans.getBean(SendproofStores.class).of(MongoStore.class,
                () -> MongoStore.springData().name(environment.getProperty("sendproof.stores.mongodb.name")).build());
        MongoDatabaseFactory hooked = SpringMongoHook.hook(store, factory);
        if (hooked == factory) {
            LOG.warn("Sendproof left a MongoDatabaseFactory unhooked: its MongoStore already guards another one.");
        }
        return hooked;
    }
}

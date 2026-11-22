package io.github.mprync.sendproof.spring;

import com.google.cloud.firestore.Firestore;
import io.github.mprync.sendproof.firestore.FirestoreStore;
import java.util.Map;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.Environment;

/**
 * Hooks every {@link Firestore} bean as it is created (Spring Cloud GCP's own, or one the application defines): the bean
 * is replaced by a client rebuilt from the same options over the guarded RPC layer ({@link FirestoreStore#firestore(Firestore)}),
 * and the original, never used, is closed. Everything that injects it gets the guarded client, whose {@code bulkWriter()}
 * and {@code recursiveDelete} are refused during a Preview. A {@link FirestoreStore} registered on the {@link Sendproof}
 * builder or as a bean is used as is; otherwise an automatic one is made, named by {@code sendproof.stores.firestore.name}.
 * Set {@code sendproof.stores.firestore.enabled=false} to leave Firestore unhooked.
 *
 * <p>Like the other hooks it fails closed at startup: once every singleton exists, a {@code Firestore} bean that is not
 * guarded stops the application with an {@link IllegalStateException}. Spring Data Firestore uses its own gRPC stub, which
 * can't be guarded; {@link UnguardedClients} refuses Preview while one is a bean.
 */
final class FirestoreStoreHook implements BeanPostProcessor, BeanFactoryAware, SmartInitializingSingleton {
    private final Environment environment;
    private BeanFactory beans;

    FirestoreStoreHook(Environment environment) {
        this.environment = environment;
    }

    private boolean enabled() {
        return environment.getProperty("sendproof.stores.firestore.enabled", Boolean.class, true);
    }

    /** Whether a {@code Firestore} bean is one Sendproof doesn't guard. */
    static boolean unguarded(Object bean) {
        return !FirestoreStore.isGuardedClient(bean);
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        this.beans = beanFactory;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
        if (!(bean instanceof Firestore raw) || FirestoreStore.isGuardedClient(bean) || !enabled()) {
            return bean;
        }
        FirestoreStore store = beans.getBean(SendproofStores.class).of(FirestoreStore.class,
                () -> FirestoreStore.builder().name(environment.getProperty("sendproof.stores.firestore.name")).build());
        return store.firestore(raw);
    }

    @Override
    public void afterSingletonsInstantiated() {
        if (!enabled() || !(beans instanceof ListableBeanFactory listable)) {
            return;
        }
        for (Map.Entry<String, Firestore> entry : listable.getBeansOfType(Firestore.class, false, false).entrySet()) {
            if (unguarded(entry.getValue())) {
                throw new IllegalStateException("The Firestore bean '" + entry.getKey() + "' is not guarded by Sendproof, so a Preview "
                        + "could write to Firestore through it. Remove the bean's early creation, or set sendproof.stores.firestore.enabled=false.");
            }
        }
    }
}

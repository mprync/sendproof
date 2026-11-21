package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.redis.RedisStore;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.BeanFactoryAware;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.Environment;
import org.springframework.data.redis.connection.RedisConnectionFactory;

/**
 * Hooks the application's {@link RedisConnectionFactory} (Lettuce or Jedis) as its bean is created: it is replaced by a
 * decorator of its own class whose connections check every command before it is sent. A {@link RedisStore} registered on
 * the {@link Sendproof} builder or as a bean is used as is; otherwise an automatic one is made, named by
 * {@code sendproof.stores.redis.name}. Set {@code sendproof.stores.redis.enabled=false} to leave Redis unhooked.
 *
 * <p>Only a factory Spring creates is hooked, and the reactive connection of a factory can't be guarded: a Preview that
 * asks for one fails with 500.
 */
final class RedisStoreHook implements BeanPostProcessor, BeanFactoryAware {
    private final Environment environment;
    private BeanFactory beans;

    RedisStoreHook(Environment environment) {
        this.environment = environment;
    }

    @Override
    public void setBeanFactory(BeanFactory beanFactory) throws BeansException {
        this.beans = beanFactory;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
        if (!(bean instanceof RedisConnectionFactory factory)
                || !environment.getProperty("sendproof.stores.redis.enabled", Boolean.class, true)) {
            return bean;
        }
        RedisStore store = beans.getBean(SendproofStores.class).of(RedisStore.class,
                () -> RedisStore.spring().name(environment.getProperty("sendproof.stores.redis.name")).build());
        return SpringRedisHook.hook(store, factory);
    }
}

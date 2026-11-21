package io.github.mprync.sendproof.spring;

import io.github.mprync.sendproof.redis.RedisStore;
import org.springframework.data.redis.connection.RedisConnectionFactory;

/** The Spring Data Redis hook: a decorated connection factory whose connections guard every command. */
final class SpringRedisHook {
    private SpringRedisHook() {
    }

    /** Decorates {@code factory} with {@code store}. */
    static RedisConnectionFactory hook(RedisStore store, RedisConnectionFactory factory) {
        return store.spring(factory);
    }
}

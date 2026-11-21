package io.github.mprync.sendproof.fixture;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * A disposable HTTP app backed by one real relational table, used by the shared conformance runner. The data store
 * clients are Spring Boot's own auto-configuration, switched on only when the runner passes their variables
 * ({@code BENCH_MONGODB_URL}, {@code BENCH_REDIS_URL}), so every other scenario starts a fixture with no stores.
 */
@SpringBootApplication
public class FixtureApplication {

    public static void main(String[] args) {
        var application = new SpringApplication(FixtureApplication.class);
        var excluded = new ArrayList<String>();
        if (System.getenv("BENCH_MONGODB_URL") == null) {
            excluded.addAll(List.of("org.springframework.boot.autoconfigure.mongo.MongoAutoConfiguration",
                    "org.springframework.boot.autoconfigure.data.mongo.MongoDataAutoConfiguration",
                    "org.springframework.boot.autoconfigure.data.mongo.MongoRepositoriesAutoConfiguration"));
        }
        if (System.getenv("BENCH_REDIS_URL") == null) {
            excluded.addAll(List.of("org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration",
                    "org.springframework.boot.autoconfigure.data.redis.RedisRepositoriesAutoConfiguration"));
        }
        application.setDefaultProperties(Map.of("spring.autoconfigure.exclude", String.join(",", excluded)));
        application.run(args);
    }
}

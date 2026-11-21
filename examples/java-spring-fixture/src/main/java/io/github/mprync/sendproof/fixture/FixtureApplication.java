package io.github.mprync.sendproof.fixture;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationEnvironmentPreparedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.core.env.MapPropertySource;
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
        if ("mysql".equals(System.getenv("BENCH_DATABASE")) && System.getenv("BENCH_DATABASE_URL") != null) {
            // A server database: the runner's fresh database replaces the in-memory H2 one.
            URI url = URI.create(System.getenv("BENCH_DATABASE_URL"));
            String[] user = url.getUserInfo() == null ? new String[] {"", ""} : (url.getUserInfo() + ":").split(":", 3);
            var database = new MapPropertySource("benchDatabase", Map.of(
                    // The MariaDB entry runs as `mysql` with BENCH_DATABASE_SERVER=mariadb, on MariaDB's own driver.
                    "spring.datasource.url", ("mariadb".equals(System.getenv("BENCH_DATABASE_SERVER")) ? "jdbc:mariadb://" : "jdbc:mysql://") + url.getHost() + ":" + url.getPort() + url.getPath(),
                    "spring.datasource.username", java.net.URLDecoder.decode(user[0], java.nio.charset.StandardCharsets.UTF_8),
                    "spring.datasource.password", java.net.URLDecoder.decode(user[1], java.nio.charset.StandardCharsets.UTF_8)));
            application.addListeners((ApplicationListener<ApplicationEnvironmentPreparedEvent>) event ->
                    event.getEnvironment().getPropertySources().addFirst(database));
        }
        application.run(args);
    }
}

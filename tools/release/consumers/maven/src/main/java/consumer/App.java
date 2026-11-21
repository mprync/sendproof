package consumer;

import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The smallest Spring Boot application that mounts the Test Bench workbench at /bench/. */
@SpringBootApplication
@RestController
public class App {

    public static void main(String[] args) {
        SpringApplication.run(App.class, args);
    }

    @GetMapping("/openapi.json")
    Map<String, Object> openApi() {
        return Map.of(
                "openapi", "3.0.3",
                "info", Map.of("title", "Maven consumer", "version", "1.0.0"),
                "paths", Map.of("/ping", Map.of("get", Map.of(
                        "operationId", "ping",
                        "responses", Map.of("200", Map.of("description", "pong"))))),
                "tags", List.of());
    }

    @GetMapping("/ping")
    Map<String, String> ping() {
        return Map.of("ping", "pong");
    }
}

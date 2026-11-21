package dev.testbench.fixture;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** A disposable HTTP app backed by one real relational table, used by the shared conformance runner. */
@SpringBootApplication
public class FixtureApplication {

    public static void main(String[] args) {
        SpringApplication.run(FixtureApplication.class, args);
    }
}

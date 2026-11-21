# Java Spring conformance fixture

A Spring Boot 3.5 + Spring Security + JPA/Hibernate + H2 application that implements the shared
[conformance fixture](../../spec/conformance/fixture.md) with the Java binding (`sendproof-jpa`).

```sh
sh adapters/java/scripts/gradle.sh :spring-fixture:bootJar          # build
PORT=5361 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard sh adapters/java/scripts/run-fixture.sh
node tests/conformance/run.mjs java-spring                            # run the shared HTTP runner
```

`BENCH_PATH_BASE` becomes the servlet context path. `BENCH_SCENARIO` selects a Spring profile: `standard`, `disabled` (`sendproof.enabled=false`), `no-provider` (`sendproof.jpa.enabled=false`) or `rollback-failure` (a primary `PreviewProvider` that fails after a real rollback). Authentication is a stateless cookie token filter in front of real Spring Security rules, so previews exercise `authorizeHttpRequests` on the rewritten path.

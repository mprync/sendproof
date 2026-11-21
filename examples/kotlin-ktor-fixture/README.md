# Kotlin Ktor conformance fixture

A Ktor 3 (CIO) + plain JDBC (HikariCP, H2) application that implements the shared
[conformance fixture](../../spec/conformance/fixture.md) with the Kotlin/Ktor binding (`testbench-ktor`).

```sh
sh adapters/java/scripts/gradle.sh :ktor-fixture:installDist         # build
PORT=5362 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard sh adapters/java/scripts/run-ktor-fixture.sh
```

Data access goes through a `PreviewDataSource`, so a preview shares one rolled-back connection and SQL and row
changes are captured. Authorization is a route-scoped plugin that runs before the handler, which is why previews of
forbidden calls are refused before any transaction begins. `BENCH_SCENARIO` is `standard`, `disabled`, `no-provider`
or `rollback-failure`.

# testbench-logback

A Logback appender that copies the log events of the request being previewed or observed into its capture. It records
only while a capture is active on the current thread, honors the logger levels you configured, and skips the data
layer's own SQL text loggers (SQL is captured with parameters at the JDBC layer).

```java
LogbackCapture capture = LogbackCapture.install();   // null when SLF4J is not backed by Logback
// ... on shutdown
capture.close();
```

Spring Boot installs it automatically (`testbench-spring-boot`); the Ktor plugin installs it unless `captureLogs = false`.

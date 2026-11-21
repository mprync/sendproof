# testbench-ktor

Ktor 3 integration: the embedded workbench, in-process Preview, Observed Send and trace retrieval. Pair it with
`testbench-jdbc` (or your own `PreviewProvider`).

```kotlin
val dataSource = PreviewDataSource(hikari) { true }        // data access must use this

fun Application.module() {
    install(TestBench) {
        enabled = environment.config.property("testbench.enabled").getString().toBoolean()   // off by default
        pathBase = ""                                      // the mount; "/tenant" if you route under it
        apiName = "Inventory"
        openApiUrl = "/openapi.json"
        provider = JdbcPreviewProvider(dataSource) { "inventory_dev" }
        identity = { call -> /* Capabilities.Identity(name, role) or null */ null }
        traceOwner = { call -> /* TraceOwner.of("cookie", subject, pathBase) or null */ null }
    }
    routing {
        route("/items") {
            install(MyAuthorization)                       // must run in the plugin phase, before the handler
            testBenchPreview {                             // opts these routes in
                post { /* ... uses dataSource ... */ }
            }
        }
    }
}
```

## How a preview runs

An interceptor in the `Setup` phase recognises `<pathBase>/bench/_preview/...`, validates it like every adapter, and
replays the original operation as an in-process `PipelineCall` with the rewritten path (Ktor's own routing,
authentication and content negotiation run as for a normal call). Its response is an in-memory buffer. A route gate in
the `Call` phase, after your route's authentication and authorization plugins, checks the route was declared with
`testBenchPreview`, starts the provider session and lets the handler run. Afterwards the plugin rolls back, disposes and
writes the confirmed envelope, or a non-success problem response (401/403/404/405 as the host answered, 409 for
unavailable targets, 413 oversize, 500 when anything could not be confirmed).

Authorization must therefore be a plugin or interceptor that runs before the handler. A check made inside the handler
runs after the session began, so a denied preview would be reported as a confirmed application response.

## Observed Send

An ordinary request to a `testBenchPreview` route with `Prefer: trace`, from a same-origin caller for whom `traceOwner`
returns an owner, keeps its normal response and commit, gains `X-TestBench-Trace`, and its trace is served to that owner
only.

## Notes and limits

- Handlers should use blocking JDBC on the request's coroutine. Test Bench carries the capture and JDBC scope across
  coroutine thread hops with thread-local context elements.
- WebSocket upgrades and streaming responses are not previewable; the response is buffered up to 1 MiB.
- `testBenchPreview` uses `Route.intercept`, which Ktor marks deprecated in favor of route-scoped plugins.
- Tested with Ktor 3.6.1, Kotlin 2.3.21, CIO and the Ktor test host, H2.

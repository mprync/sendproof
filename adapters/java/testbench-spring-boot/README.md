# testbench-spring-boot

Spring Boot (Servlet/Spring MVC) integration. Add the dependency, set `testbench.enabled=true`, and mark operations with `@TestBenchPreview`. Pair it with a data integration such as `testbench-jpa` to enable Preview and Observed Send.

## Configuration

| Property | Default | Meaning |
| --- | --- | --- |
| `testbench.enabled` | `false` | Master opt-in. |
| `testbench.allow-in-production` | `false` | Allow it while a blocked profile is active. |
| `testbench.blocked-profiles` | `prod, production` | Profiles that keep it off. |
| `testbench.environment` | first active profile | Display label. |
| `testbench.api-name` | `spring.application.name` | Display name. |
| `testbench.open-api-url` | discovered | Primary OpenAPI document, relative to the context path. |
| `testbench.documents[n].name/url` | none | Extra OpenAPI documents. |
| `testbench.auth-providers[n].label/kind/url` | none | Sign-in options. Kinds the UI understands include `cookie` (password JSON), `personas`, `oidc`, `login`. |
| `testbench.field-modules[n]` | none | Same-origin ES modules that add field renderers. |
| `testbench.trace.retention` | `5m` | How long a trace stays readable. |
| `testbench.sql.include-parameter-values` | development-like only | Show bound SQL values (secrets always hidden). |
| `testbench.filter-order` | `-150` | Must stay before Spring Security's chain (`-100`). |

All URLs are relative to the servlet context path (`server.servlet.context-path`), which is the application mount.

## Code configuration: `TestBench.builder()`

Everything above can also be set in code. Declare a `TestBench` bean next to your other configuration:

```java
@Bean
TestBench testBench() {
    return TestBench.builder()
            .apiName("Inventory")
            .environment("Staging")
            .openApiDocument("Previous version", "/v3/api-docs/v0")
            .authProvider("Staff SSO", "oidc", "/account/sign-in")
            .fieldModule("/assets/inventory-fields.js")
            .traceRetention(Duration.ofMinutes(2))
            .workbenchAccess(request -> request.isUserInRole("developer"))
            .build();
}
```

Builder methods: `apiName`, `environment`, `openApiUrl`, `openApiDocument`, `authProvider`, `fieldModule`, `traceRetention`,
`workbenchAccess`, `identityResolver`, `traceOwnerResolver`. URLs must be application-relative and are validated when set.

### Precedence

For each setting the first of these that is present wins:

1. an explicit Spring bean of the same type (`WorkbenchAccess`, `WorkbenchIdentityResolver`, `TraceOwnerResolver`, `OpenApiDocuments`, `TraceStore`);
2. the value set on the builder;
3. the `testbench.*` property;
4. the default.

A list set on the builder (documents, auth providers, field modules) **replaces** the property list instead of adding to it.

### Environment gating

Whether Test Bench exists at all is decided from properties before any bean is created, so declaring a `TestBench` bean
never turns it on and cannot bypass the production block:

| Property | Default | Notes |
| --- | --- | --- |
| `testbench.enabled` | `false` | The only way to opt in. Set it per environment (for example in `application-dev.properties`). |
| `testbench.blocked-profiles` | `prod, production` | An active listed profile keeps it off even when enabled. |
| `testbench.allow-in-production` | `false` | Explicit override of the block. |

Also property-only: `testbench.filter-order` (needed to register the filter) and `testbench.sql.include-parameter-values`
(needed when the `DataSource` is wrapped; its default also reads `testbench.environment`, not the builder's value).

## OpenAPI discovery (springdoc)

With `springdoc-openapi-starter-webmvc-api` on the classpath the workbench discovers the document at `springdoc.api-docs.path` (default `/v3/api-docs`) and one document per `GroupedOpenApi` bean (`<path>/<group>`). Explicit `testbench.open-api-url` and `testbench.documents` take precedence. The workbench's own routes are hidden from the generated document.

## How a preview runs

1. `TestBenchFilter` (before Spring Security) recognises `/bench/_preview/**`, checks `Prefer: tx=rollback` is the only preference, rejects `HEAD`, and validates the target (no `//`, `..`, backslash, `;`, control characters, or `/bench`).
2. It wraps the request as the original operation and the response as an in-memory buffer, then continues the real filter chain. Authentication, authorization and routing see the real path. The wrapper hides `Accept-Encoding`, disables async, and never lets headers, cookies or redirects reach the real response.
3. `TestBenchInterceptor` runs after routing and security: it refuses non-controller handlers (404) and handlers without `@TestBenchPreview` (409), rechecks same-origin, applies `WorkbenchAccess`, requires one provider (503 otherwise) and starts its session.
4. After the handler, the filter rolls back, disposes, and writes a confirmed envelope (`200`, `Preference-Applied: tx=rollback`, `Cache-Control: no-store`, `Server-Timing`) or a problem response: 401/403/404/405 as the host answered, 409 for unavailable targets, 413 for oversize, 500 when anything could not be confirmed.

A resolved exception (validation, `@ExceptionHandler`, `ResponseStatusException`) is an application response and is confirmed. An unresolved one is a failure.

## Observed Send

An ordinary request to a `@TestBenchPreview` operation with `Prefer: trace`, from a same-origin caller with a stable authenticated principal, keeps its normal response and commit. The response carries `X-TestBench-Trace`; the trace is at `GET /bench/_api/traces/{id}` for the same principal only (404 for missing, expired, evicted or foreign IDs). Effects are recorded with `delivered: true`.

The owner comes from `TraceOwnerResolver` (default: the servlet principal's name, authentication type and context path). Register a bean to change it.

## Extension points

Register a bean to replace any of: `WorkbenchIdentityResolver` (identity and role shown in the workbench; Spring Security is used when present), `TraceOwnerResolver`, `WorkbenchAccess` (extra gate for the workbench and every preview), `OpenApiDocuments`, `TraceStore`. Register one `PreviewProvider` (mark one `@Primary` if several exist).

`TestBenchCapture` is always available as a bean, including when Test Bench is disabled, where every call is a no-op returning `false`.

Logs are captured with a Logback appender that follows your logger levels. Other logging backends are not captured.

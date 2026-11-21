# Binding option mapping

OpenAPI and sign-in URLs are application-relative. The binding prepends the request's path base in capabilities. Package defaults use the common OpenAPI route for that framework. Applications that configure their own route supply its URL.

| Meaning | ASP.NET Core builder | Node options | Python keyword | Spring Boot | Ktor DSL | Go option | Laravel and Symfony | Rails configuration | Rust builder |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAPI URL | `WithOpenApiUrl` (`/openapi/v1.json`) | `openApiUrl` (`/openapi.json`, NestJS `/api-json`) | `openapi_url` (FastAPI's configured URL) | `sendproof.open-api-url` (springdoc) | `openApiUrl` (`/openapi.json`) | `WithOpenAPIURL` | `openapi_url` (`/openapi/v1.json`) | `open_api_url` | `open_api_url` |
| Display API name | `WithApiName` | `apiName` | `api_name` | `sendproof.api-name` | `apiName` | `WithAPIName` | `api_name` | `api_name` | `Config::builder(name)` |
| Additional documents | `WithOpenApiDocument` | `documents` | `documents` | `sendproof.documents` | `documents` | `WithOpenAPIDocument` | `documents` | `open_api_document` | `document` |
| Enable workbench | `MapSendproof`, `InEnvironments` | `environment`, `environments` | `environment`, `environments` | `sendproof.enabled`, profile gate | `enabled` | `WithEnvironment`, `WithEnabledEnvironments` | `enabled`, `environments` | `environment`, `environments` | `environment`, `enable_in` |
| Host sign-in methods | `WithAuthProvider` | `authProviders`, `discoverAuth` | `auth_providers` | `sendproof.auth-providers` | `authProviders` | `WithAuthProvider` | `auth_providers` | `auth_provider` | `auth_provider` |
| Host identity/access | ASP.NET principal, `RequireAuthorization` | `resolveIdentity`, `authorize` | `identity`, `authorize` | Servlet principal and Spring Security | `identity`, `traceOwner`, `access` | `WithPrincipal`, `WithAccessPolicy` | `guard` (Laravel), `identity` (Symfony), `authorize` | `identity`, `authorize` | `identity`, `workbench_policy` |
| Rollback provider | `AddEntityFrameworkCore` | `previewProvider` | `provider` | `PreviewProvider` bean | `provider` | `WithProvider` | `provider` | `use(provider)` | `provider` |
| SQL parameter display | `WithSqlParameterValues` | `includeSqlParameterValues` | `include_sql_parameter_values` | `sendproof.sql.include-parameter-values` | `PreviewDataSource` callback | `WithSQLParameterValues` | `include_sql_parameter_values` | `include_sql_parameter_values` | `include_sql_parameter_values` |
| Trace lifetime | Five minutes | `traceTtlMs` (milliseconds) | `trace_ttl` (seconds) | `sendproof.trace.retention` (duration) | `traceRetention` (duration) | `WithTraceTTL` (duration) | `trace.ttl` (seconds) | `trace_ttl` (seconds) | `trace_retention` (duration) |
| Custom field module | `WithFieldModule` | `fieldModules` | `field_modules` | `sendproof.field-modules` | `fieldModules` | `WithFieldModule` | `field_modules` | `field_module` | `field_module` |

The framework resolves authorization on the current request, independently of which operations appear in capabilities. Secret-named SQL parameters remain redacted when parameter display is enabled. Provider-specific connection, tracking and pooling options live in each data package.

Spring Boot also accepts a `Sendproof.builder()` bean for programmatic configuration. Explicit SPI beans take precedence, followed by the builder's values, properties and defaults. Deployment properties control enablement and production profiles. See the [Spring Boot package guide](../../adapters/java/sendproof-spring-boot/README.md).

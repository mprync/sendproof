# TestBench.AspNetCore

Register the ASP.NET Core adapter alongside the host's OpenAPI and authentication services. `MapTestBench()` serves the embedded workbench at `/bench/` in Development by default. Use the fluent builder to set allowed environments, add OpenAPI documents, or require an authorization policy.

```csharp
using TestBench.AspNetCore;

builder.Services.AddTestBench()
    .WithApiName("Treasury API")
    .WithOpenApiUrl("/openapi/v1.json")
    .WithOpenApiDocument("Previous version", "/openapi/v0.json")
    .WithAuthProvider("Company sign in", "login", "/account/sign-in");

var app = builder.Build();
app.MapTestBench();
```

The adapter discovers authentication schemes with a display name. Cookie schemes offer the host's login page and remote schemes use the host's authentication challenge. Pass `DiscoverAuthSchemes(false)` to show only explicitly configured providers. All configured links are application-relative and use the request's `PathBase`. With `RequireAuthorization("Workbench")`, sign in through a host page before opening the workbench. The policy also applies to every preview alongside the operation's own authorization.

## Enable transaction previews

Register one `IPreviewProvider` in DI, such as `TestBench.EntityFrameworkCore`. Mark an operation with `.WithTestBenchPreview()` on a minimal API route or `[TestBenchPreview]` on an MVC action. Apply the attribute to a controller only when every action is eligible. Each marked operation must enlist its writes in the provider transaction and suppress external effects. Endpoint routing, authentication, authorization and parameter binding use the host application. The transaction starts immediately before the endpoint delegate.

External dispatchers can inject scoped `TestBenchPreview` to report a planned effect. Record a snapshot of the action, then return without dispatching when the method returns `true`.

```csharp
if (preview.TryRecordEmail("Send receipt", "payments@example.test", [recipient], [],
    "Payment received", $"Receipt for {paymentId}"))
{
    return;
}

await receipts.SendAsync(paymentId, cancellationToken);
```

Use `TryRecordHttp`, `TryRecordJob` and `TryRecordMessage` for the other conventional effects, or `TryRecordEffect` for custom kinds. During an observed send the recording methods return `false`, so the dispatcher delivers normally and the trace records `delivered: true`.

`AddTestBench` adds an `ILoggerProvider` with the alias `TestBench`. It captures structured logs during the authorized preview or observed operation and honors the host's log-level filters. `TryRecordLog` also accepts explicit messages. Capture limits bound entries, strings and payloads and the response indicates when data was clipped or omitted.

The operation and its response callbacks must keep their effects within the request and transaction scope. The host controls side effects in middleware that runs before the endpoint. Preview responses are buffered up to 1 MiB. Use ordinary buffered results on previewable endpoints. `HEAD` requests have no response body and are unavailable for preview.

## HTTP integration

`GET /bench/_api/capabilities` advertises available operations, OpenAPI documents and sign-in options. Preview uses the original operation's method, body and query at `/bench/_preview/<operation-path>` with `Prefer: tx=rollback`. Treat only a response with `rolledBack: true` as acknowledgment. Send to the original API URL. When `observedSend` is advertised for an operation, adding `Prefer: trace` can return an `X-TestBench-Trace` ID without changing commit behavior. Read that trace from `/bench/_api/traces/{id}` as the same authenticated user. The host must supply a stable `NameIdentifier` or `sub` claim. Traces expire after five minutes and share a bounded in-memory cache. Preview and observed send responses expose `Server-Timing`. For a host that uses `UsePathBase`, put it before explicit `UseRouting()` so endpoint routing can resolve the rewritten operation path.

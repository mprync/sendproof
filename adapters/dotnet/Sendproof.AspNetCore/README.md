# Sendproof.AspNetCore

Register the ASP.NET Core adapter alongside the host's OpenAPI and authentication services. `MapSendproof()` serves the embedded workbench at `/sendproof/` in Development by default. Use the fluent builder to set allowed environments, add OpenAPI documents, or require an authorization policy.

```csharp
using Sendproof.AspNetCore;

builder.Services.AddSendproof()
    .WithApiName("Store API")
    .WithOpenApiUrl("/openapi/v1.json")
    .WithOpenApiDocument("Previous version", "/openapi/v0.json")
    .WithAuthProvider("Company sign in", "login", "/account/sign-in");

var app = builder.Build();
app.MapSendproof();
```

The adapter discovers authentication schemes with a display name. Cookie schemes offer the host's login page and remote schemes use the host's authentication challenge. Pass `DiscoverAuthSchemes(false)` to show only explicitly configured providers. All configured links are application-relative and use the request's `PathBase`. With `RequireAuthorization("Workbench")`, sign in through a host page before opening the workbench. The policy also applies to every preview alongside the operation's own authorization.

## Enable transaction previews

Register one `IPreviewProvider` in DI, such as `Sendproof.EntityFrameworkCore`. Mark an operation with `.WithSendproofPreview()` on a minimal API route or `[SendproofPreview]` on an MVC action. Apply the attribute to a controller only when every action is eligible. Each marked operation must enlist its writes in the provider transaction and suppress external effects. Endpoint routing, authentication, authorization and parameter binding use the host application. The transaction starts immediately before the endpoint delegate.

External dispatchers can inject scoped `SendproofPreview` to report a planned effect. Record a snapshot of the action, then return without dispatching when the method returns `true`.

```csharp
if (preview.TryRecordEmail("Send receipt", "payments@example.test", [recipient], [],
    "Payment received", $"Receipt for {paymentId}"))
{
    return;
}

await receipts.SendAsync(paymentId, cancellationToken);
```

Use `TryRecordHttp`, `TryRecordJob` and `TryRecordMessage` for the other conventional effects, or `TryRecordEffect` for custom kinds. During an observed send the recording methods return `false`, so the dispatcher delivers normally and the trace records `delivered: true`.

`AddSendproof` adds an `ILoggerProvider` with the alias `Sendproof`. It captures structured logs during the authorized preview or observed operation and honors the host's log-level filters. `TryRecordLog` also accepts explicit messages. Capture limits bound entries, strings and payloads and the response indicates when data was clipped or omitted.

The operation and its response callbacks must keep their effects within the request and transaction scope. The host controls side effects in middleware that runs before the endpoint. Preview responses are buffered up to 1 MiB. Use ordinary buffered results on previewable endpoints. `HEAD` requests have no response body and are unavailable for preview.

## HTTP integration

`GET /sendproof/_api/capabilities` advertises available operations, OpenAPI documents and sign-in options. Preview uses the original operation's method, body and query at `/sendproof/_preview/<operation-path>` with `Prefer: tx=rollback`. Treat only a response with `rolledBack: true` as acknowledgment. Send to the original API URL. When `observedSend` is advertised for an operation, adding `Prefer: trace` can return an `X-Sendproof-Trace` ID without changing commit behavior. Read that trace from `/sendproof/_api/traces/{id}` as the same authenticated user. The host must supply a stable `NameIdentifier` or `sub` claim. Traces expire after five minutes and share a bounded in-memory cache. Preview and observed send responses expose `Server-Timing`. For a host that uses `UsePathBase`, put it before explicit `UseRouting()` so endpoint routing can resolve the rewritten operation path.

## Preview sessions

When capabilities report `previewSessions: true`, `POST /sendproof/_api/sessions` opens a session and every Preview that carries `Sendproof-Session: <id>` runs in it: the steps share one held transaction, so a later step sees an earlier step's rows, and nothing is committed. `POST /sendproof/_api/sessions/{id}/rewind` with `{ "step": n }` goes back to before step `n`, and `DELETE /sendproof/_api/sessions/{id}` rolls everything back. The protocol, its errors and its costs are in [spec/README.md, Preview sessions](../../../spec/README.md#preview-sessions).

A session is rolled back after five minutes unused or thirty minutes in all, and when the host stops. Change both limits with `.WithPreviewSessionLimits(idleTimeout, maxLifetime)` on `AddSendproof()`. Sessions are held in the process, four per owner and sixteen per host; an API on several instances needs sticky routing for the workbench.

The EF Core provider holds sessions on every relational database: SQLite, PostgreSQL, MySQL, MariaDB and SQL Server. It joins each step's request-scoped `DbContext` to the session's connection and transaction with EF Core's `SetDbConnection` and `UseTransaction`, and takes EF Core savepoints before each step. On SQL Server, which can't release a savepoint, a kept step proves the transaction is still the session's by `CURRENT_TRANSACTION_ID()`. A MySQL or MariaDB session keeps the process's Preview turn until it ends: other MySQL Previews in the process wait for it, and a second session fails to open after 5 seconds. The MongoDB EF Core provider has no savepoints, so its hosts report `previewSessions: false`. A custom `IPreviewProvider` doesn't hold sessions, so a host that uses one reports `false` too.

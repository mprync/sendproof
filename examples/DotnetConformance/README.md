# .NET conformance fixture

A disposable ASP.NET Core minimal API that implements the shared [conformance fixture contract](../../spec/conformance/fixture.md) with the `Sendproof.AspNetCore` and `Sendproof.EntityFrameworkCore` packages. The shared runner drives it over real HTTP; it is not a sample application (see `examples/TreasuryApi` for that).

Requirements: .NET SDK 10 (`net10.0`), NuGet access for the first restore, and a loopback port.

```sh
dotnet build examples/DotnetConformance/DotnetConformance.csproj -c Release
PORT=5371 BENCH_PATH_BASE=/tenant BENCH_SCENARIO=standard \
  dotnet examples/DotnetConformance/bin/Release/net10.0/DotnetConformance.dll
node tests/conformance/run.mjs dotnet-aspnetcore
```

## Configuration

| Variable | Meaning |
| --- | --- |
| `PORT` | Required. Listens on `http://127.0.0.1:$PORT`. |
| `BENCH_PATH_BASE` | Empty, or a mount such as `/tenant`. Requests outside the mount get 404. |
| `BENCH_SCENARIO` | `standard` (default), `disabled`, `no-provider` or `rollback-failure`. |
| `BENCH_TRACE_TTL_SECONDS` | Real-time observed-trace lifetime, default `5`. |

Invalid values stop the process at startup with a descriptive error. Each process creates a new SQLite file in the temp directory with one table, `items(id, name)`, and deletes it on shutdown.

## How it uses the adapter

- **Standard** runs in the `Development` environment, the only one the workbench enables by default. **Disabled** runs in `Production`, so `/sendproof` and previews are absent while the ordinary routes still work.
- **Preview provider**: `AddEntityFrameworkCore<FixtureDbContext>()`. **No-provider** omits it. **Rollback-failure** decorates the registered provider (`RollbackFailureProvider`): capture is real, but `RollbackAsync` throws. The transaction is never committed and disposal rolls it back.
- **Trace lifetime**: the adapter keeps traces for a fixed five minutes and takes its clock from dependency injection. The fixture registers a `TimeProvider` that runs 60 times faster by default (`ScaledTimeProvider`), so a trace expires after five real seconds. No adapter change or clock endpoint is needed; the manifest uses `traceTtlMs: 5000`.
- **Authentication**: cookie authentication. `admin@example.test` / `bench-fixture` signs in at `POST /auth/sign-in` (advertised as kind `cookie`). `/auth/personas` lists `admin` and `viewer` and switches to either for any signed-in user, which is acceptable only because this fixture holds no real data. The email is the stable subject that owns traces.
- **Effects and logs**: `POST /items` records an `email` effect through `SendproofPreview` (suppressed in Preview, delivered to an in-memory outbox otherwise) and logs `created:<id>` through `ILogger`. It also runs `SELECT @fixture_secret` so the adapter's secret-name redaction is visible in captured SQL.

## Choices the contract leaves open

- `POST /items/{id}/fail` inserts the item, then returns 409. With `?mode=exception` it throws, so Preview returns an unconfirmed 500.
- `POST /items/{id}/redirect` inserts nothing. It returns 302 with an inner `Set-Cookie`.
- `POST /items/{id}/capture` inserts 201 items (`<id>-0` to `<id>-200`), records 101 effects and logs 501 messages, which exceeds every default cap.
- `POST /items/{id}/large` inserts the item and returns about 1.5 MB, above the 1 MiB preview cap.
- Missing fields are reported by the handler as a 400 validation problem, not by the model binder. A binder failure is thrown outside the handler and would make a Preview unconfirmed instead of returning an inner 400.
- `DELETE` and `PATCH` of a missing item return 404; creating an existing id returns 409.

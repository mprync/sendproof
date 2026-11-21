# Installing Test Bench

Use the .NET 10 SDK and an ASP.NET Core application targeting `net10.0`. Install `TestBench.AspNetCore` to browse OpenAPI, edit requests and use Send. For database Preview, install `TestBench.EntityFrameworkCore`. It references the host adapter and the EF Core relational APIs. Your application supplies the EF Core database driver, connection configuration and scoped context.

## Install from a local release build

Build both packages with the commands in the [quick start](../README.md#packages). In the consuming solution, add the absolute path to the output folder to a solution-level `NuGet.Config`. Preserve the application's existing sources and mappings.

```xml
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    <add key="TestBenchLocal" value="/absolute/path/to/test-bench/artifacts/packages/nuget" />
  </packageSources>
</configuration>
```

From the consuming application directory, choose the package and version explicitly.

```sh
dotnet add package TestBench.EntityFrameworkCore --version 0.1.0-alpha.1
```

Once a version is listed on nuget.org, the same command works with that version and the public feed. Both Test Bench packages follow the same version.

## Start the workbench

Register `AddTestBench()` with the application's services, add `.AddEntityFrameworkCore<YourDbContext>()` for Preview, and map `app.MapTestBench()`. Start the application with its Development profile and open `/bench/`. See the [host adapter](../adapters/dotnet/TestBench.AspNetCore/README.md) for alternative document locations, sign-in methods, environment selection and authorization policies.

## Check the installation

Open an authenticated read operation and send it. For a transaction test, choose a write operation the host marked with `.WithTestBenchPreview()` or `[TestBenchPreview]`. Preview it, inspect its database changes, then read the affected resource independently. Repeat with **Send** against disposable data to check persistence. The [Treasury example](../examples/TreasuryApi/README.md) implements this flow against SQLite.

If a route is missing from Preview, check its opt-in metadata and whether the provider resolves a relational context. If the API rejects the request, check the signed-in user's permissions. External calls and writes through separate connections need application-specific handling. The [EF provider guide](../adapters/dotnet/TestBench.EntityFrameworkCore/README.md) describes these boundaries.

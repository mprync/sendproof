using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using TestBench.AspNetCore;
using TestBench.EntityFrameworkCore;

namespace DotnetConformance;

/// <summary>Builds the standalone conformance application for one scenario.</summary>
public static class FixtureApplication
{
    /// <summary>Creates the host, a new empty SQLite database and the full route table. The caller runs it.</summary>
    public static WebApplication Build(FixtureOptions options, string[] args)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            // The workbench is on only in Development by default. The "disabled" scenario relies on that default.
            EnvironmentName = options.Scenario == FixtureScenario.Disabled ? Environments.Production : Environments.Development
        });
        builder.WebHost.UseUrls($"http://127.0.0.1:{options.Port}");

        var databasePath = Path.Combine(Path.GetTempPath(), $"bench-conformance-{Guid.NewGuid():N}.db");
        builder.Services.AddDbContext<FixtureDbContext>(db => db.UseSqlite(
            new SqliteConnectionStringBuilder { DataSource = databasePath, Pooling = false }.ToString()));
        builder.Services.AddSingleton<FixtureOutbox>();
        builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
        builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(cookie =>
        {
            cookie.Cookie.Name = "bench-fixture";
            cookie.Events.OnRedirectToLogin = context => { context.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; };
            cookie.Events.OnRedirectToAccessDenied = context => { context.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; };
        });
        builder.Services.AddAuthorization();
        builder.Services.AddOpenApi(openApi => openApi.AddDocumentTransformer((document, _, _) =>
        {
            document.Info.Title = "Test Bench Conformance";
            return Task.CompletedTask;
        }));

        // The adapter keeps traces for a fixed five minutes and reads its clock from DI. A scaled clock gives the
        // runner a short real-time retention without any adapter change or test-only endpoint.
        builder.Services.AddSingleton<TimeProvider>(new ScaledTimeProvider(
            FixtureOptions.AdapterTraceLifetime / options.TraceTtl));
        var testBench = builder.Services.AddTestBench()
            .WithApiName("Test Bench Conformance")
            .WithAuthProvider("Password", "cookie", "/auth/sign-in")
            .WithAuthProvider("Personas", "personas", "/auth/personas");
        if (options.Scenario != FixtureScenario.NoProvider)
        {
            testBench.AddEntityFrameworkCore<FixtureDbContext>();
        }

        if (options.Scenario == FixtureScenario.RollbackFailure)
        {
            DecorateProviderWithRollbackFailure(builder.Services);
        }

        var app = builder.Build();
        using (var scope = app.Services.CreateScope())
        {
            var database = scope.ServiceProvider.GetRequiredService<FixtureDbContext>().Database;
            database.EnsureCreated();
            // Write-ahead logging is stored in the database file, so connections opened later (the fixture does not pool)
            // use it. The default rollback journal makes concurrent writers poll for the lock and fsync twice per commit.
            database.ExecuteSqlRaw("PRAGMA journal_mode=WAL");
        }

        app.Lifetime.ApplicationStopped.Register(() =>
        {
            foreach (var path in new[] { databasePath, databasePath + "-journal", databasePath + "-wal", databasePath + "-shm" })
            {
                try { File.Delete(path); } catch (IOException) { }
            }
        });

        if (options.PathBase.Length > 0)
        {
            // Enforce the mount: UsePathBase alone would also serve every route at the root.
            var mount = new PathString(options.PathBase);
            app.Use((context, next) =>
            {
                if (context.Request.Path.StartsWithSegments(mount)) return next(context);
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            });
            app.UsePathBase(mount);
        }

        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/ready", () => Results.Ok(new { status = "ready" })).ExcludeFromDescription();
        app.MapOpenApi();
        app.MapAuthEndpoints();
        app.MapItemEndpoints();
        app.MapTestBench();
        return app;
    }

    private static void DecorateProviderWithRollbackFailure(IServiceCollection services)
    {
        var registration = services.Single(service => service.ServiceType == typeof(IPreviewProvider));
        services.Remove(registration);
        // The EF provider type is internal to the adapter; construct it through DI exactly as the adapter would.
        services.AddScoped<IPreviewProvider>(provider => new RollbackFailureProvider(
            (IPreviewProvider)ActivatorUtilities.CreateInstance(provider, registration.ImplementationType!)));
    }
}

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;
using Sendproof.Journeys;

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

        var databasePath = Environment.GetEnvironmentVariable("BENCH_SQLITE_PATH") ??
            Path.Combine(Path.GetTempPath(), $"bench-conformance-{Guid.NewGuid():N}.db");
        // The runner picks the engine: SQLite (the default) uses a throwaway file; MySQL gets a fresh database to use.
        var mysql = Environment.GetEnvironmentVariable("BENCH_DATABASE") == "mysql";
        var mysqlConnection = mysql ? MySqlConnectionString(Environment.GetEnvironmentVariable("BENCH_DATABASE_URL")) : null;
        builder.Services.AddDbContext<FixtureDbContext>(db =>
        {
            if (mysqlConnection is not null) db.UseMySQL(mysqlConnection);
            else db.UseSqlite(new SqliteConnectionStringBuilder { DataSource = databasePath, Pooling = false }.ToString());
        });
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
            document.Info.Title = "Sendproof Conformance";
            return Task.CompletedTask;
        }));

        // The adapter keeps traces for a fixed five minutes and reads its clock from DI. A scaled clock gives the
        // runner a short real-time retention without any adapter change or test-only endpoint.
        builder.Services.AddSingleton<TimeProvider>(new ScaledTimeProvider(
            FixtureOptions.AdapterTraceLifetime / options.TraceTtl));
        var sendproof = builder.Services.AddSendproof()
            .WithApiName("Sendproof Conformance")
            .WithAuthProvider("Password", "cookie", "/auth/sign-in")
            .WithAuthProvider("Personas", "personas", "/auth/personas")
            .WithJourneys(Path.Combine(AppContext.BaseDirectory, "Journeys", "conformance.arazzo.json"));
        if (options.Scenario != FixtureScenario.NoProvider)
        {
            sendproof.AddEntityFrameworkCore<FixtureDbContext>();
        }

        // Data stores are hooked only when the runner passes their variables.
        var stores = FixtureStores.FromEnvironment();
        stores.Register(builder.Services, sendproof);

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
            if (!mysql) database.ExecuteSqlRaw("PRAGMA journal_mode=WAL");
            else SharedRuleEndpoints.CreateMySqlProcedures(database);
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
        app.MapSharedRuleEndpoints();
        stores.Map(app);
        app.MapSendproof();
        return app;
    }

    /// <summary>Turns the runner's <c>mysql://user:password@host:port/database</c> URL into a MySQL connection string.</summary>
    private static string MySqlConnectionString(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "mysql")
            throw new InvalidOperationException("BENCH_DATABASE_URL must be a mysql:// URL when BENCH_DATABASE is mysql.");
        var credentials = uri.UserInfo.Split(':', 2);
        return $"server={uri.Host};port={uri.Port};user={Uri.UnescapeDataString(credentials[0])};" +
            $"password={Uri.UnescapeDataString(credentials.ElementAtOrDefault(1) ?? "")};database={uri.AbsolutePath.TrimStart('/')};" +
            "SslMode=Disabled;AllowPublicKeyRetrieval=True";
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

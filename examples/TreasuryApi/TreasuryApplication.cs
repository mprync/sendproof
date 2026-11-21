using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using System.Text.Json.Serialization;
using TestBench.AspNetCore;
using TestBench.EntityFrameworkCore;

namespace TreasuryApi;

/// <summary>
/// Configures the disposable Treasury example for a host or an in-process test: SQLite, cookie sign-in,
/// the OpenAPI document, Test Bench with its Entity Framework Core preview, and every endpoint group.
/// </summary>
public static class TreasuryApplication
{
    /// <summary>Builds the application and initializes a new demo database.</summary>
    public static async Task<WebApplication> BuildAsync(WebApplicationBuilder builder)
    {
        var databasePath = Path.GetFullPath(builder.Configuration["DemoDatabasePath"]
            ?? Path.Combine(builder.Environment.ContentRootPath, "treasury-demo.db"));
        var isNewDatabase = false;
        try
        {
            using var file = new FileStream(databasePath, FileMode.CreateNew, FileAccess.Write);
            isNewDatabase = true;
        }
        catch (IOException) when (File.Exists(databasePath)) { }

        builder.Services.AddDbContext<TreasuryDbContext>(options => options.UseSqlite(
            new SqliteConnectionStringBuilder { DataSource = databasePath }.ToString()));
        builder.Services.AddSingleton<IPasswordHasher<DemoUser>, PasswordHasher<DemoUser>>();
        builder.Services.AddSingleton<DemoNotificationQueue>();
        // Cookie keys always live with the demo data, never in the machine-wide ~/.aspnet key ring,
        // so one unreadable key file elsewhere can't break sign-in. DemoKeyDirectory overrides it.
        var keyDirectory = Path.GetFullPath(builder.Configuration["DemoKeyDirectory"] is { Length: > 0 } configured
            ? configured
            : DefaultKeyDirectory(databasePath));
        builder.Services.AddDataProtection()
            .SetApplicationName("TreasuryApi")
            .PersistKeysToFileSystem(Directory.CreateDirectory(keyDirectory));

        builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(options =>
        {
            options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; };
            options.Events.OnRedirectToAccessDenied = context => { context.Response.StatusCode = 403; return Task.CompletedTask; };
        });
        builder.Services.AddAuthorization();
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            // Numbers are numbers (not also strings), and the discriminator of a polymorphic body may appear anywhere in it.
            options.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
            options.SerializerOptions.AllowOutOfOrderMetadataProperties = true;
        });
        // A lambda (not a method group) lets the OpenAPI source generator hook in the XML comments.
        builder.Services.AddOpenApi(options => TreasuryOpenApi.Configure(options));
        var testBench = builder.Services.AddTestBench().WithApiName("Acme Treasury API")
            .WithAuthProvider("Treasury session", "cookie", "/auth/login");
        if (builder.Environment.IsDevelopment())
            testBench.WithAuthProvider("Seeded accounts", "personas", "/auth/personas");
        testBench.AddEntityFrameworkCore<TreasuryDbContext>();

        var app = builder.Build();
        if (isNewDatabase)
        {
            using var scope = app.Services.CreateScope();
            await DemoData.SeedAsync(scope.ServiceProvider);
        }

        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapOpenApi();
        app.MapAuthenticationEndpoints();
        app.MapAccountEndpoints();
        app.MapBalanceEndpoints();
        app.MapCounterpartyEndpoints();
        app.MapPaymentEndpoints();
        app.MapApprovalEndpoints();
        app.MapFxEndpoints();
        app.MapStatementEndpoints();
        app.MapUserEndpoints();
        app.MapTestBench();
        return app;
    }

    /// <summary>The key folder beside a demo database: <c>treasury-demo.db</c> keeps its keys in <c>treasury-demo.keys</c>.</summary>
    public static string DefaultKeyDirectory(string databasePath) =>
        Path.Combine(Path.GetDirectoryName(databasePath)!, Path.GetFileNameWithoutExtension(databasePath) + ".keys");
}

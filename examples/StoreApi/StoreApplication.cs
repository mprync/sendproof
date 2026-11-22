using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using System.Text.Json.Serialization;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;

namespace StoreApi;

/// <summary>
/// Configures the disposable Acme Store example for a host or an in-process test: SQLite, cookie sign-in,
/// the OpenAPI document, Sendproof with its Entity Framework Core preview, the optional Redis, MongoDB and
/// DynamoDB stores, and every endpoint group.
/// </summary>
public static class StoreApplication
{
    /// <summary>Builds the application and initializes a new demo database.</summary>
    public static async Task<WebApplication> BuildAsync(WebApplicationBuilder builder)
    {
        var databasePath = Path.GetFullPath(builder.Configuration["DemoDatabasePath"]
            ?? Path.Combine(builder.Environment.ContentRootPath, "store-demo.db"));
        var isNewDatabase = false;
        try
        {
            using var file = new FileStream(databasePath, FileMode.CreateNew, FileAccess.Write);
            isNewDatabase = true;
        }
        catch (IOException) when (File.Exists(databasePath)) { }

        builder.Services.AddDbContext<StoreDbContext>(options => options.UseSqlite(
            new SqliteConnectionStringBuilder { DataSource = databasePath }.ToString()));
        builder.Services.AddSingleton<IPasswordHasher<DemoUser>, PasswordHasher<DemoUser>>();
        builder.Services.AddSingleton<DemoNotificationQueue>();
        // Cookie keys always live with the demo data, never in the machine-wide ~/.aspnet key ring,
        // so one unreadable key file elsewhere can't break sign-in. DemoKeyDirectory overrides it.
        var keyDirectory = Path.GetFullPath(builder.Configuration["DemoKeyDirectory"] is { Length: > 0 } configured
            ? configured
            : DefaultKeyDirectory(databasePath));
        builder.Services.AddDataProtection()
            .SetApplicationName("StoreApi")
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
        builder.Services.AddOpenApi(options => StoreOpenApi.Configure(options));
        var sendproof = builder.Services.AddSendproof().WithApiName("Acme Store API")
            .WithAuthProvider("Store session", "cookie", "/auth/login");
        if (builder.Environment.IsDevelopment())
            sendproof.WithAuthProvider("Seeded accounts", "personas", "/auth/personas");
        sendproof.AddEntityFrameworkCore<StoreDbContext>();
        // Redis, MongoDB and DynamoDB are optional: hooked only when DemoRedisUrl, DemoMongoUrl and DemoDynamoUrl are set.
        DemoStores.Add(builder.Services, sendproof, builder.Configuration);

        var app = builder.Build();
        using (var scope = app.Services.CreateScope())
        {
            if (isNewDatabase) await DemoData.SeedAsync(scope.ServiceProvider);
            // Each store fills itself only when empty, so an existing database still gets its history on first use.
            await scope.ServiceProvider.GetRequiredService<DemoStores>().SeedAsync(
                scope.ServiceProvider.GetRequiredService<StoreDbContext>(), app.Logger);
        }

        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapOpenApi();
        app.MapAuthenticationEndpoints();
        app.MapCatalogEndpoints();
        app.MapInventoryEndpoints();
        app.MapCustomerEndpoints();
        app.MapCartEndpoints();
        app.MapOrderEndpoints();
        app.MapPaymentEndpoints();
        app.MapShipmentEndpoints();
        app.MapCouponEndpoints();
        // Reviews are nested documents in MongoDB, so their operations exist only when the demo has that store.
        if (app.Services.GetRequiredService<DemoStores>().HasMongo) app.MapReviewEndpoints();
        app.MapUserEndpoints();
        app.MapSendproof();
        return app;
    }

    /// <summary>The key folder beside a demo database: <c>store-demo.db</c> keeps its keys in <c>store-demo.keys</c>.</summary>
    public static string DefaultKeyDirectory(string databasePath) =>
        Path.Combine(Path.GetDirectoryName(databasePath)!, Path.GetFileNameWithoutExtension(databasePath) + ".keys");
}

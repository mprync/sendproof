using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.EntityFrameworkCore;

namespace Sendproof.Journeys.Tests;

/// <summary>The parcel API on an in-memory test server, with a SQLite file of its own deleted afterwards.</summary>
internal sealed class ParcelHost : IAsyncDisposable
{
    private readonly string _path;

    private ParcelHost(string path, WebApplication app)
    {
        _path = path;
        App = app;
        Client = app.GetTestClient();
    }

    internal WebApplication App { get; }
    internal HttpClient Client { get; }

    /// <summary>Builds the app; <paramref name="journeys"/> registers the journeys under test.</summary>
    internal static async Task<ParcelHost> StartAsync(Action<SendproofBuilder> journeys, string environment = "Development", string? pathBase = null)
    {
        var path = Path.Combine(Path.GetTempPath(), $"parcels-{Guid.NewGuid():N}.db");
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = environment, ApplicationName = typeof(ParcelHost).Assembly.GetName().Name, ContentRootPath = AppContext.BaseDirectory,
            Args = ["--hostBuilder:reloadConfigOnChange=false"]
        });
        builder.WebHost.UseTestServer();
        builder.Services.AddDbContext<ParcelDbContext>(options => options.UseSqlite(new SqliteConnectionStringBuilder { DataSource = path }.ToString()));
        builder.Services.AddOpenApi();
        var sendproof = builder.Services.AddSendproof().WithApiName("Parcel API").InEnvironments(environment);
        sendproof.AddEntityFrameworkCore<ParcelDbContext>();
        journeys(sendproof);

        var app = builder.Build();
        using (var scope = app.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<ParcelDbContext>().Database.EnsureCreated();
        }

        if (pathBase is not null)
        {
            app.UsePathBase(pathBase);
        }

        app.UseRouting();
        app.MapOpenApi();
        ParcelEndpoints.Map(app);
        app.MapSendproof();
        try
        {
            await app.StartAsync();
        }
        catch
        {
            await app.DisposeAsync();
            Delete(path);
            throw;
        }

        return new ParcelHost(path, app);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await App.StopAsync();
        await App.DisposeAsync();
        Delete(_path);
    }

    private static void Delete(string path)
    {
        // Pooled connections keep the database file open, and Windows will not delete an open file.
        SqliteConnection.ClearAllPools();
        File.Delete(path);
    }
}

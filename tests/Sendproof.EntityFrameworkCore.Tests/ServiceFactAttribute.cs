using MongoDB.Bson;
using MongoDB.Driver;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// A fact that runs only when a compose service answers a real request. An open port is not enough: Docker accepts and
/// drops connections while a container starts. Start the services with
/// <c>docker compose -f tests/conformance/compose.yml up -d --wait mysql mongodb</c>.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ServiceFactAttribute : FactAttribute
{
    private static readonly Dictionary<string, string?> Probes = [];

    /// <summary>The MySQL root connection string of the compose service.</summary>
    internal static string MySqlRoot { get; } =
        $"server={Environment.GetEnvironmentVariable("BENCH_MYSQL_SERVER") ?? "127.0.0.1"};port={Environment.GetEnvironmentVariable("BENCH_MYSQL_PORT") ?? "53306"};user=root;password=bench_local;SslMode=Disabled;AllowPublicKeyRetrieval=True";

    /// <summary>The PostgreSQL connection string of the compose service, on its <c>postgres</c> database.</summary>
    internal static string PostgresRoot { get; } =
        $"Host={Environment.GetEnvironmentVariable("BENCH_POSTGRES_SERVER") ?? "127.0.0.1"};Port=55432;Username=bench;Password=bench_local;Timeout=5";

    /// <summary>The SQL Server <c>sa</c> connection string of the compose service.</summary>
    internal static string SqlServerRoot { get; } =
        $"Server={Environment.GetEnvironmentVariable("BENCH_SQLSERVER_SERVER") ?? "127.0.0.1,51433"};User Id=sa;Password=BenchLocal_2026!;Encrypt=False;TrustServerCertificate=True;Connect Timeout=5";

    /// <summary>The MongoDB replica set of the compose service.</summary>
    internal static string MongoUrl { get; } = Environment.GetEnvironmentVariable("BENCH_MONGODB_SERVER_URL") ?? "mongodb://127.0.0.1:57017/?directConnection=true";

    public ServiceFactAttribute(string service)
    {
        lock (Probes)
        {
            if (!Probes.TryGetValue(service, out var reason))
            {
                Probes[service] = reason = Probe(service);
            }

            Skip = reason;
        }
    }

    private static string? Probe(string service)
    {
        try
        {
            switch (service)
            {
                case "mysql":
                    using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                    using (var db = new DbContext(new DbContextOptionsBuilder().UseMySQL(MySqlRoot).Options))
                    {
                        db.Database.ExecuteSqlRaw("SELECT 1");
                    }

                    return null;
                case "postgres":
                    using (var db = new DbContext(new DbContextOptionsBuilder().UseNpgsql(PostgresRoot + ";Database=postgres").Options))
                    {
                        db.Database.ExecuteSqlRaw("SELECT 1");
                    }

                    return null;
                case "sqlserver":
                    using (var db = new DbContext(new DbContextOptionsBuilder().UseSqlServer(SqlServerRoot).Options))
                    {
                        db.Database.ExecuteSqlRaw("SELECT 1");
                    }

                    return null;
                case "mongodb":
                    var settings = MongoClientSettings.FromConnectionString(MongoUrl);
                    settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
                    new MongoClient(settings).GetDatabase("admin").RunCommand<BsonDocument>(new BsonDocument("hello", 1));
                    return null;
                default:
                    return $"Unknown service {service}";
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return $"{service} is not running ({error.GetType().Name}); start it with: docker compose -f tests/conformance/compose.yml up -d --wait {service}";
        }
    }
}

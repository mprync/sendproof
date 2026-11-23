using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sendproof.AspNetCore;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// A fact that runs only when a compose data-store service answers a real protocol request. An open port is not enough:
/// Docker accepts and drops connections while a container starts, so each probe sends a request and waits for a reply.
/// Start the services with <c>docker compose -f tests/conformance/compose.yml up -d --wait mongodb redis dynamodb</c>.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ServiceFactAttribute : FactAttribute
{
    private static readonly Dictionary<string, string?> Probes = [];

    public ServiceFactAttribute(string service)
    {
        Skip = Unavailable(service);
    }

    /// <summary>A fact that needs two services, such as MongoDB and Redis in one Preview.</summary>
    public ServiceFactAttribute(string service, string other)
    {
        Skip = Unavailable(service) ?? Unavailable(other);
    }

    internal static string? Unavailable(string service)
    {
        lock (Probes)
        {
            if (!Probes.TryGetValue(service, out var reason))
            {
                Probes[service] = reason = Probe(service);
            }

            return reason;
        }
    }

    private static string? Probe(string service)
    {
        try
        {
            switch (service)
            {
                case "redis":
                    using (var client = new TcpClient())
                    {
                        client.Connect(Services.RedisHost, Services.RedisPort);
                        var stream = client.GetStream();
                        stream.ReadTimeout = 2000;
                        stream.Write(System.Text.Encoding.ASCII.GetBytes($"*2\r\n$4\r\nAUTH\r\n${Services.RedisPassword.Length}\r\n{Services.RedisPassword}\r\n*1\r\n$4\r\nPING\r\n"));
                        var buffer = new byte[64];
                        var read = stream.Read(buffer, 0, buffer.Length);
                        return read > 0 && System.Text.Encoding.ASCII.GetString(buffer, 0, read).Contains("+OK") ? null : "Redis did not answer PING";
                    }

                case "mongodb":
                    {
                        var settings = global::MongoDB.Driver.MongoClientSettings.FromConnectionString(Services.MongoUrl);
                        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
                        var client = new global::MongoDB.Driver.MongoClient(settings);
                        client.GetDatabase("admin").RunCommand<global::MongoDB.Bson.BsonDocument>(new global::MongoDB.Bson.BsonDocument("hello", 1));
                        return null;
                    }

                case "dynamodb":
                    {
                        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                        using var response = http.GetAsync(Services.DynamoUrl).GetAwaiter().GetResult();
                        return response.IsSuccessStatusCode || (int)response.StatusCode < 500 ? null : "DynamoDB Local did not answer";
                    }

                case "cassandra":
                    using (var client = new TcpClient())
                    {
                        // An OPTIONS frame (native protocol v4); a ready node answers with SUPPORTED.
                        var (host, port) = Services.CassandraEndpoint;
                        client.Connect(host, port);
                        var stream = client.GetStream();
                        stream.ReadTimeout = 3000;
                        stream.Write([0x04, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00]);
                        var buffer = new byte[16];
                        return stream.Read(buffer, 0, buffer.Length) >= 9 && buffer[4] == 0x06 ? null : "Cassandra did not answer OPTIONS";
                    }

                case "opensearch":
                    {
                        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                        using var response = http.GetAsync(Services.OpenSearchUrl + "/_cluster/health?wait_for_status=yellow&timeout=2s").GetAwaiter().GetResult();
                        return response.IsSuccessStatusCode ? null : "OpenSearch did not answer";
                    }

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

/// <summary>A theory that runs only when a compose data-store service answers, like <see cref="ServiceFactAttribute"/>.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class ServiceTheoryAttribute : TheoryAttribute
{
    public ServiceTheoryAttribute(string service)
    {
        Skip = ServiceFactAttribute.Unavailable(service);
    }
}

/// <summary>The compose services' addresses (tests/conformance/compose.yml), overridable like the conformance runner's.</summary>
internal static class Services
{
    internal static string RedisHost { get; } = Environment.GetEnvironmentVariable("BENCH_REDIS_HOST") ?? "127.0.0.1";
    internal static int RedisPort { get; } = int.TryParse(Environment.GetEnvironmentVariable("BENCH_REDIS_PORT"), out var port) ? port : 56379;
    internal const string RedisPassword = "bench_redis_local";
    internal static string MongoUrl { get; } = Environment.GetEnvironmentVariable("BENCH_MONGODB_SERVER_URL") ?? "mongodb://127.0.0.1:57017/?directConnection=true";
    internal static string DynamoUrl { get; } = Environment.GetEnvironmentVariable("BENCH_DYNAMODB_SERVER_URL") ?? "http://127.0.0.1:58000";
    internal static (string Host, int Port) CassandraEndpoint { get; } = Environment.GetEnvironmentVariable("BENCH_CASSANDRA_SERVER") is { Length: > 0 } server
        ? (server.Split(':')[0], int.Parse(server.Split(':')[1], System.Globalization.CultureInfo.InvariantCulture))
        : ("127.0.0.1", 59042);
    internal static string OpenSearchUrl { get; } = Environment.GetEnvironmentVariable("BENCH_OPENSEARCH_SERVER_URL") ?? "http://127.0.0.1:59200";
    internal static string Fresh(string prefix = "tb") => $"{prefix}_{Guid.NewGuid():N}"[..16];
}

/// <summary>An ASP.NET Core test host with Sendproof, a store registration and routes, driven over a test server.</summary>
internal sealed class TestApp(WebApplication app, HttpClient client) : IAsyncDisposable
{
    internal HttpClient Client => client;

    internal IServiceProvider Services => app.Services;

    /// <summary>Starts a host. <paramref name="stores"/> registers clients and hooks; <paramref name="map"/> adds the routes.</summary>
    internal static async Task<TestApp> StartAsync(Action<IServiceCollection, SendproofBuilder> stores, Action<WebApplication> map)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = ["--hostBuilder:reloadConfigOnChange=false"],
            EnvironmentName = "Development"
        });
        builder.WebHost.UseTestServer();
        // Set BENCH_TEST_LOG=1 to see why a Preview answered 500.
        if (Environment.GetEnvironmentVariable("BENCH_TEST_LOG") == "1")
        {
            builder.Logging.AddConsole().SetMinimumLevel(LogLevel.Error);
        }
        else
        {
            builder.Logging.SetMinimumLevel(LogLevel.Critical);
        }
        builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
        builder.Services.AddAuthentication("test").AddCookie("test");
        builder.Services.AddAuthorization();
        var bench = builder.Services.AddSendproof().WithApiName("Stores");
        stores(builder.Services, bench);
        var app = builder.Build();
        app.MapPost("/signin", async (HttpContext context) =>
        {
            await context.SignInAsync("test", new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                [new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, "robin")], "test")));
            return Results.NoContent();
        }).AllowAnonymous();
        map(app);
        app.MapSendproof();
        await app.StartAsync();
        app.GetTestServer().PreserveExecutionContext = true;
        var http = app.GetTestClient();
        http.Timeout = TimeSpan.FromSeconds(30);
        return new TestApp(app, http);
    }

    /// <summary>Sends a Preview of an operation and returns the raw response.</summary>
    internal Task<HttpResponseMessage> PreviewAsync(string method, string path, object? body = null)
    {
        var request = new HttpRequestMessage(new HttpMethod(method), "/sendproof/_preview" + path);
        request.Headers.Add("Prefer", "tx=rollback");
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return client.SendAsync(request);
    }

    /// <summary>Sends an observed Send (<c>Prefer: trace</c>) as a signed-in user and returns the response and its trace.</summary>
    internal async Task<(HttpResponseMessage Response, JsonElement Trace)> ObservedAsync(string method, string path, object? body = null)
    {
        using var signIn = await client.PostAsync("/signin", null);
        var cookie = signIn.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
        var request = new HttpRequestMessage(new HttpMethod(method), path);
        request.Headers.Add("Cookie", cookie);
        request.Headers.Add("Prefer", "trace");
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        var response = await client.SendAsync(request);
        var id = Assert.Single(response.Headers.GetValues("X-Sendproof-Trace"));
        using var traceRequest = new HttpRequestMessage(HttpMethod.Get, $"/sendproof/_api/traces/{id}");
        traceRequest.Headers.Add("Cookie", cookie);
        using var traceResponse = await client.SendAsync(traceRequest);
        return (response, await traceResponse.Content.ReadFromJsonAsync<JsonElement>());
    }

    internal async Task<JsonElement> CapabilitiesAsync() => await client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities");

    public async ValueTask DisposeAsync()
    {
        client.Dispose();
        await app.DisposeAsync();
    }
}

/// <summary>Assertions on the blocked-Preview problem body and the unconfirmed responses.</summary>
internal static class Expect
{
    /// <summary>A blocked Preview: 409 problem+json, never a confirmation, naming the store and the refused command.</summary>
    internal static async Task<JsonElement> BlockedAsync(HttpResponseMessage response, string store, string operation)
    {
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"), "A blocked Preview must not claim a rollback.");
        Assert.False(response.Headers.Contains("Set-Cookie"));
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("preview_unavailable", problem.GetProperty("code").GetString());
        Assert.Equal(store, problem.GetProperty("store").GetString());
        Assert.Equal(operation, problem.GetProperty("operation").GetString(), ignoreCase: true);
        Assert.False(problem.GetProperty("rolledBack").GetBoolean());
        return problem;
    }

    /// <summary>A Preview the server refused without confirming anything.</summary>
    internal static void Unconfirmed(HttpResponseMessage response, HttpStatusCode expected)
    {
        Assert.Equal(expected, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"), "An unconfirmed Preview must not claim a rollback.");
    }

    /// <summary>A confirmed Preview: 200, rolled back.</summary>
    internal static async Task<JsonElement> ConfirmedAsync(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"Expected a confirmed Preview, got {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        Assert.Equal("tx=rollback", Assert.Single(response.Headers.GetValues("Preference-Applied")));
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(envelope.GetProperty("rolledBack").GetBoolean());
        return envelope;
    }

    /// <summary>The <c>Db</c> log entries of an envelope or trace for one store (and one operation).</summary>
    internal static JsonElement[] DbEntries(JsonElement capture, string system, string? operation = null) =>
        [.. capture.GetProperty("logs").EnumerateArray().Where(entry => entry.GetProperty("level").GetString() == "Db" &&
            entry.GetProperty("db").GetProperty("system").GetString() == system &&
            (operation is null || string.Equals(entry.GetProperty("db").GetProperty("operation").GetString(), operation, StringComparison.OrdinalIgnoreCase)))];
}

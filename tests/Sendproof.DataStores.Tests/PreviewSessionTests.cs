using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using global::MongoDB.Bson;
using global::MongoDB.Driver;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.MongoDB;
using Sendproof.Redis;
using StackExchange.Redis;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// Preview sessions over MongoDB on a real replica set (spec/README.md "Preview sessions"): one client session and
/// transaction across the steps, undo and rewind by writing back each step's before images, a guarded Redis write that
/// undoes only its step, and <c>session_failed</c> once the server has ended the transaction.
/// </summary>
public sealed class PreviewSessionTests
{
    [Fact]
    public async Task UnreachableMongoFailsSessionOpenQuickly()
    {
        var settings = MongoClientSettings.FromConnectionString("mongodb://127.0.0.1:1/?directConnection=true");
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(30);
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton<IMongoClient>(_ => new MongoClient(settings));
            bench.AddMongoDB();
        }, _ => { });
        var watch = System.Diagnostics.Stopwatch.StartNew();
        using var response = await app.Client.PostAsync("/sendproof/_api/sessions", null);
        await SessionProblemAsync(response, HttpStatusCode.Conflict, "session_failed");
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(7), $"Open took {watch.Elapsed}.");
    }

    [Fact]
    public async Task RedisGuardDoesNotAcquireAConnectionWhenOpeningASession()
    {
        var attempts = 0;
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton<IConnectionMultiplexer>(_ =>
            {
                attempts++;
                throw new InvalidOperationException("Redis is unavailable");
            });
            bench.AddRedis();
        }, _ => { });
        using var response = await app.Client.PostAsync("/sendproof/_api/sessions", null);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(0, attempts);
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString();
        using var ended = await app.Client.DeleteAsync($"/sendproof/_api/sessions/{id}");
        Assert.Equal(HttpStatusCode.NoContent, ended.StatusCode);
    }

    [Fact]
    public async Task ClientFactoryFailureReturnsSessionFailed()
    {
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton<IMongoClient>(_ => throw new InvalidOperationException("Client unavailable"));
            bench.AddMongoDB();
        }, _ => { });
        using var response = await app.Client.PostAsync("/sendproof/_api/sessions", null);
        await SessionProblemAsync(response, HttpStatusCode.Conflict, "session_failed");
    }

    [ServiceFact("mongodb")]
    public async Task StepsShareOneMongoTransactionRewindAndRollBack()
    {
        await using var fixture = await Fixture.StartAsync(redis: false);
        Assert.True((await fixture.App.CapabilitiesAsync()).GetProperty("previewSessions").GetBoolean());
        var id = await fixture.OpenAsync();

        var created = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders", new { id = "o1" }));
        Assert.Equal(1, Step(created));
        var insert = Assert.Single(created.GetProperty("changes").EnumerateArray());
        Assert.Equal(("insert", "mongodb"), (insert.GetProperty("operation").GetString(), insert.GetProperty("store").GetString()));
        Assert.Null(await fixture.FindAsync("o1"));

        // Step 2 sees step 1's uncommitted document.
        var read = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "GET", "/orders/o1"));
        Assert.Equal((2, "new"), (Step(read), read.GetProperty("body").GetProperty("status").GetString()));

        // Step 3 ships it; its change's before is the document as step 1 left it.
        var shipped = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders/o1/ship"));
        var update = Assert.Single(shipped.GetProperty("changes").EnumerateArray());
        Assert.Equal("update", update.GetProperty("operation").GetString());
        Assert.Equal("new", update.GetProperty("before").GetProperty("status").GetString());
        Assert.Equal("shipped", update.GetProperty("after").GetProperty("status").GetString());

        // Rewinding to step 3 puts the document back as it was before it; the re-run reads that.
        Assert.Equal(HttpStatusCode.NoContent, (await fixture.RewindAsync(id, 3)).StatusCode);
        var reread = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "GET", "/orders/o1"));
        Assert.Equal((3, "new"), (Step(reread), reread.GetProperty("body").GetProperty("status").GetString()));

        // Step 4 deletes it; rewinding to step 1 removes even step 1's insert.
        var deleted = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "DELETE", "/orders/o1"));
        Assert.Equal("delete", Assert.Single(deleted.GetProperty("changes").EnumerateArray()).GetProperty("operation").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await fixture.RewindAsync(id, 1)).StatusCode);
        var empty = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "GET", "/orders"));
        Assert.Equal(1, Step(empty));
        Assert.Empty(empty.GetProperty("body").EnumerateArray());

        // Insert again, end the session: nothing was ever committed.
        await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders", new { id = "o2" }));
        Assert.Equal(HttpStatusCode.NoContent, (await fixture.EndAsync(id)).StatusCode);
        Assert.Null(await fixture.FindAsync("o1"));
        Assert.Null(await fixture.FindAsync("o2"));
        await SessionProblemAsync(await fixture.PreviewAsync(id, "GET", "/orders"), HttpStatusCode.NotFound, "session_not_found");

        // A single Preview still aborts its own transaction.
        await Expect.ConfirmedAsync(await fixture.App.PreviewAsync("POST", "/orders", new { id = "o3" }));
        Assert.Null(await fixture.FindAsync("o3"));
    }

    [ServiceFact("mongodb", "redis")]
    public async Task ABlockedRedisWriteUndoesOnlyItsStep()
    {
        await using var fixture = await Fixture.StartAsync(redis: true);
        var id = await fixture.OpenAsync();
        await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders", new { id = "o1" }));

        // Step 2 inserts a document, then writes to Redis: blocked, and its MongoDB insert is written back out.
        await Expect.BlockedAsync(await fixture.PreviewAsync(id, "POST", "/orders/o2/cache"), "redis", "SET");
        var listed = await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "GET", "/orders"));
        Assert.Equal(2, Step(listed));
        Assert.Equal(["o1"], listed.GetProperty("body").EnumerateArray().Select(order => order.GetString()));
        Assert.False(await fixture.Redis!.GetDatabase().KeyExistsAsync(fixture.Prefix + "o2"));

        await fixture.EndAsync(id);
        Assert.Null(await fixture.FindAsync("o1"));
    }

    [ServiceFact("mongodb")]
    public async Task ATransactionTheServerEndedFailsTheSession()
    {
        await using var fixture = await Fixture.StartAsync(redis: false);
        var id = await fixture.OpenAsync();
        await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders", new { id = "o1" }));

        // What the server does at transactionLifetimeLimitSeconds: the transaction is gone.
        await fixture.KillServerSessionAsync(id);
        var problem = await SessionProblemAsync(await fixture.PreviewAsync(id, "GET", "/orders/o1"), HttpStatusCode.Conflict, "session_failed");
        Assert.Contains("transactionLifetimeLimitSeconds", problem.GetProperty("detail").GetString());
        await SessionProblemAsync(await fixture.PreviewAsync(id, "GET", "/orders/o1"), HttpStatusCode.NotFound, "session_not_found");
        Assert.Null(await fixture.FindAsync("o1"));
    }

    [ServiceFact("mongodb")]
    public async Task HostShutdownAbortsTheSessionsTransaction()
    {
        var fixture = await Fixture.StartAsync(redis: false);
        try
        {
            var id = await fixture.OpenAsync();
            await Expect.ConfirmedAsync(await fixture.PreviewAsync(id, "POST", "/orders", new { id = "o1" }));
            await fixture.App.DisposeAsync();
            Assert.Null(await fixture.FindAsync("o1"));
        }
        finally
        {
            await fixture.DropAsync();
        }
    }

    private static int Step(JsonElement envelope) => envelope.GetProperty("session").GetProperty("step").GetInt32();

    private static async Task<JsonElement> SessionProblemAsync(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Assert.True(response.StatusCode == status, $"Expected {(int)status} {code}, got {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        Assert.False(response.Headers.Contains("Preference-Applied"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, problem.GetProperty("code").GetString());
        return problem;
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required IMongoClient Raw { get; init; }
        internal required string Database { get; init; }
        internal required string Prefix { get; init; }
        internal IConnectionMultiplexer? Redis { get; init; }

        private IMongoCollection<BsonDocument> Orders => Raw.GetDatabase(Database).GetCollection<BsonDocument>("orders");

        internal static async Task<Fixture> StartAsync(bool redis)
        {
            var database = Services.Fresh("tb");
            var prefix = Services.Fresh("tb") + ":";
            var options = new ConfigurationOptions
            {
                EndPoints = { { Services.RedisHost, Services.RedisPort } },
                Password = Services.RedisPassword,
                AbortOnConnectFail = false
            };
            var raw = new MongoClient(Services.MongoUrl);
            // The collection exists before the session, as a real database's would: creating one inside a transaction is a
            // separate matter.
            await raw.GetDatabase(database).CreateCollectionAsync("orders");
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton<IMongoClient>(_ => new MongoClient(Services.MongoUrl));
                bench.AddMongoDB();
                if (redis)
                {
                    services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(options));
                    bench.AddRedis();
                }
            }, app => Map(app, database, prefix));
            return new Fixture
            {
                App = app, Raw = raw, Database = database, Prefix = prefix,
                Redis = redis ? await ConnectionMultiplexer.ConnectAsync(options) : null
            };
        }

        internal async Task<string> OpenAsync()
        {
            using var response = await App.Client.PostAsync("/sendproof/_api/sessions", null);
            Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
            return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        }

        internal Task<HttpResponseMessage> PreviewAsync(string session, string method, string path, object? body = null)
        {
            var request = new HttpRequestMessage(new HttpMethod(method), "/sendproof/_preview" + path);
            request.Headers.Add("Prefer", "tx=rollback");
            request.Headers.Add("Sendproof-Session", session);
            if (body is not null)
            {
                request.Content = JsonContent.Create(body);
            }

            return App.Client.SendAsync(request);
        }

        internal Task<HttpResponseMessage> RewindAsync(string session, int step) =>
            App.Client.PostAsJsonAsync($"/sendproof/_api/sessions/{session}/rewind", new { step });

        internal Task<HttpResponseMessage> EndAsync(string session) => App.Client.DeleteAsync($"/sendproof/_api/sessions/{session}");

        /// <summary>Kills the session's server session, which aborts its transaction on the server.</summary>
        internal async Task KillServerSessionAsync(string id)
        {
            var sessions = App.Services.GetRequiredService<PreviewSessionStore>();
            Assert.Null(sessions.TryEnter(id, new SessionOwner(null, ""), out var session));
            var held = Assert.Single(session.Parts.OfType<MongoHeldPreview>());
            await sessions.ExitAsync(session);
            var lsid = held.State.Session.WrappedCoreSession.ServerSession.Id;
            await Raw.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("killSessions", new BsonArray { lsid }));
        }

        internal async Task<BsonDocument?> FindAsync(string id) => await (await Orders.FindAsync(new BsonDocument("_id", id))).FirstOrDefaultAsync();

        internal async Task DropAsync()
        {
            await Raw.DropDatabaseAsync(Database);
            Raw.Dispose();
            Redis?.Dispose();
        }

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            await DropAsync();
        }
    }

    private sealed record OrderInput(string Id);

    private static void Map(WebApplication app, string database, string prefix)
    {
        static IMongoCollection<BsonDocument> Orders(IMongoClient client, string database) =>
            client.GetDatabase(database).GetCollection<BsonDocument>("orders");

        app.MapGet("/orders", async (IMongoClient client) =>
            (await (await Orders(client, database).FindAsync(FilterDefinition<BsonDocument>.Empty)).ToListAsync())
                .Select(order => order["_id"].AsString)).WithSendproofPreview();
        app.MapGet("/orders/{id}", async (string id, IMongoClient client) =>
            await (await Orders(client, database).FindAsync(new BsonDocument("_id", id))).FirstOrDefaultAsync() is { } order
                ? Results.Ok(new { id, status = order["status"].AsString })
                : Results.NotFound()).WithSendproofPreview();
        app.MapPost("/orders", async (OrderInput input, IMongoClient client) =>
        {
            await Orders(client, database).InsertOneAsync(new BsonDocument { { "_id", input.Id }, { "status", "new" } });
            return Results.Created($"/orders/{input.Id}", new { input.Id });
        }).WithSendproofPreview();
        app.MapPost("/orders/{id}/ship", async (string id, IMongoClient client) =>
        {
            await Orders(client, database).UpdateOneAsync(new BsonDocument("_id", id), new BsonDocument("$set", new BsonDocument("status", "shipped")));
            return Results.Ok();
        }).WithSendproofPreview();
        app.MapDelete("/orders/{id}", async (string id, IMongoClient client) =>
        {
            await Orders(client, database).DeleteOneAsync(new BsonDocument("_id", id));
            return Results.NoContent();
        }).WithSendproofPreview();
        app.MapPost("/orders/{id}/cache", async (string id, IMongoClient client, IConnectionMultiplexer redis) =>
        {
            await Orders(client, database).InsertOneAsync(new BsonDocument { { "_id", id }, { "status", "new" } });
            await redis.GetDatabase().StringSetAsync(prefix + id, "cached");
            return Results.Created();
        }).WithSendproofPreview();
    }
}

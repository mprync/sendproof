using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.Cassandra;
using Xunit;
using CassandraCluster = global::Cassandra.Cluster;
using CassandraSession = global::Cassandra.ISession;
using CassandraCqlCluster = global::Cassandra.ICluster;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The Cassandra write guard against the compose <c>cassandra</c> service (heavy-stores profile): reads, prepared statements,
/// batches, lightweight transactions, DDL and the mapper are refused before they are sent, derived sessions and clusters stay
/// guarded, and a registration that would let a write through stops the host from starting.
/// Start it with <c>docker compose -f tests/conformance/compose.yml --profile heavy-stores up -d --wait cassandra</c>.
/// </summary>
public sealed class CassandraTests
{
    private static CassandraCqlCluster NewCluster() =>
        CassandraCluster.Builder().AddContactPoint(Services.CassandraEndpoint.Host).WithPort(Services.CassandraEndpoint.Port).Build();

    [global::Cassandra.Mapping.Attributes.Table("tickets")]
    private sealed class Ticket
    {
        [global::Cassandra.Mapping.Attributes.PartitionKey] public string Id { get; set; } = "";
        public string? Status { get; set; }
        public int Hits { get; set; }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required CassandraSession Admin { get; init; }
        internal required CassandraCqlCluster Cluster { get; init; }
        internal required string Keyspace { get; init; }
        internal required Gates Gates { get; init; }

        /// <summary><paramref name="hooked"/> false is the hook removed: the store is listed, but the session is the raw one.</summary>
        internal static async Task<Fixture> StartAsync(bool hooked = true, Action<IServiceCollection, SendproofBuilder>? after = null, bool registerCluster = false)
        {
            var keyspace = Services.Fresh("tb");
            var cluster = NewCluster();
            var admin = await cluster.ConnectAsync();
            await admin.ExecuteAsync(new global::Cassandra.SimpleStatement(
                $"CREATE KEYSPACE {keyspace} WITH replication = {{'class': 'SimpleStrategy', 'replication_factor': 1}}"));
            await admin.ExecuteAsync(new global::Cassandra.SimpleStatement($"CREATE TABLE {keyspace}.tickets (id text PRIMARY KEY, status text, hits int)"));
            var gates = new Gates();
            var app = await TestApp.StartAsync((services, bench) =>
            {
                var appCluster = NewCluster();
                if (registerCluster)
                {
                    services.AddSingleton(appCluster);
                }

                services.AddSingleton<CassandraSession>(_ => appCluster.Connect(keyspace));
                if (hooked)
                {
                    bench.AddCassandra(cassandra => cassandra.WithName("tickets"));
                }
                else
                {
                    services.AddSingleton<IPreviewDataStore>(new CassandraStore(bench.Capture, "tickets", new HashSet<string>()));
                }

                after?.Invoke(services, bench);
            }, app =>
            {
                Map(app);
                gates.Map(app);
            });
            return new Fixture { App = app, Admin = admin, Cluster = cluster, Keyspace = keyspace, Gates = gates };
        }

        internal async Task SeedAsync(string id, string status, int hits) => await Admin.ExecuteAsync(
            new global::Cassandra.SimpleStatement($"INSERT INTO {Keyspace}.tickets (id, status, hits) VALUES (?, ?, ?)", id, status, hits));

        internal async Task<global::Cassandra.Row?> TicketAsync(string id) => (await Admin.ExecuteAsync(
            new global::Cassandra.SimpleStatement($"SELECT id, status, hits FROM {Keyspace}.tickets WHERE id = ?", id))).FirstOrDefault();

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            try { await Admin.ExecuteAsync(new global::Cassandra.SimpleStatement($"DROP KEYSPACE IF EXISTS {Keyspace}")); } catch (Exception) { /* best effort */ }
            Admin.Dispose();
            Cluster.Shutdown();
        }
    }

    private static void Map(WebApplication app)
    {
        app.MapGet("/tickets/{id}", async (string id, CassandraSession session) =>
        {
            var prepared = await session.PrepareAsync("SELECT id, status, hits FROM tickets WHERE id = ?");
            var row = (await session.ExecuteAsync(prepared.Bind(id))).FirstOrDefault();
            return row is null ? Results.NotFound() : Results.Ok(new { id = row.GetValue<string>("id"), hits = row.GetValue<int>("hits") });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/touch", async (string id, CassandraSession session) =>
        {
            await session.ExecuteAsync(new global::Cassandra.SimpleStatement("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", id));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/prepared-write", async (string id, CassandraSession session) =>
        {
            // A prepared INSERT is classified by the text it was prepared from, not by being an EXECUTE.
            var prepared = await session.PrepareAsync("INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)");
            await session.ExecuteAsync(prepared.Bind(id, "new", 1));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/close", async (string id, CassandraSession session) =>
        {
            // A logged batch holding a lightweight transaction.
            var batch = new global::Cassandra.BatchStatement().Add(new global::Cassandra.SimpleStatement("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS", id));
            await session.ExecuteAsync(batch);
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/empty-batch", async (CassandraSession session) =>
        {
            await session.ExecuteAsync(new global::Cassandra.BatchStatement());
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/ddl", (string id, CassandraSession session) =>
        {
            session.Execute("TRUNCATE tickets");
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/two-statements", (string id, CassandraSession session) =>
        {
            session.Execute("SELECT * FROM tickets; DELETE FROM tickets WHERE id = 'seeded'");
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/derived", async (string id, CassandraSession session) =>
        {
            // session.Cluster is the driver's way to a new session: it must hand out guarded handles.
            var other = await session.Cluster.ConnectAsync(session.Keyspace);
            await other.ExecuteAsync(new global::Cassandra.SimpleStatement("DELETE FROM tickets WHERE id = ?", id));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/via-cluster", async (string id, IServiceProvider services) =>
        {
            var session = await services.GetRequiredService<CassandraCqlCluster>().ConnectAsync(services.GetRequiredService<CassandraSession>().Keyspace);
            await session.ExecuteAsync(new global::Cassandra.SimpleStatement("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", id));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/mapper", async (string id, CassandraSession session) =>
        {
            await new global::Cassandra.Mapping.Mapper(session).InsertAsync(new Ticket { Id = id, Status = "mapped", Hits = 1 });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/tickets/{id}/swallow", async (string id, CassandraSession session) =>
        {
            try { await session.ExecuteAsync(new global::Cassandra.SimpleStatement("DELETE FROM tickets WHERE id = ?", id)); } catch (PreviewWriteBlockedException) { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
    }

    [ServiceFact("cassandra")]
    public async Task APreparedReadRunsAndIsLoggedWithoutItsValues()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("seeded", "open", 3);
        var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/tickets/seeded"));
        Assert.Equal(3, envelope.GetProperty("body").GetProperty("hits").GetInt32());
        var entry = Assert.Single(Expect.DbEntries(envelope, "cassandra", "SELECT"));
        Assert.Equal("tickets", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.Equal(f.Keyspace, entry.GetProperty("db").GetProperty("namespace").GetString());
        Assert.Equal("SELECT id, status, hits FROM tickets WHERE id = ?", entry.GetProperty("db").GetProperty("statement").GetString());
    }

    [ServiceTheory("cassandra")]
    [InlineData("/tickets/blocked/touch", "INSERT")]
    [InlineData("/tickets/blocked/prepared-write", "INSERT")]
    [InlineData("/tickets/seeded/close", "BATCH")]
    [InlineData("/tickets/seeded/empty-batch", "BATCH")]
    [InlineData("/tickets/seeded/ddl", "TRUNCATE")]
    [InlineData("/tickets/seeded/two-statements", "SELECT")]
    [InlineData("/tickets/seeded/derived", "DELETE")]
    [InlineData("/tickets/blocked/mapper", "INSERT")]
    [InlineData("/tickets/seeded/swallow", "DELETE")]
    public async Task EveryWritePathIsRefusedBeforeItIsSent(string path, string operation)
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("seeded", "open", 3);
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", path), "cassandra", operation);
        Assert.Equal("Preview unavailable: this operation writes to Cassandra", problem.GetProperty("detail").GetString());
        Assert.Null(await f.TicketAsync("blocked"));
        var seeded = await f.TicketAsync("seeded");
        Assert.Equal(("open", 3), (seeded!.GetValue<string>("status"), seeded.GetValue<int>("hits")));
    }

    [ServiceFact("cassandra")]
    public async Task AClusterRegisteredInTheContainerHandsOutGuardedSessions()
    {
        await using var f = await Fixture.StartAsync(registerCluster: true);
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/tickets/blocked/via-cluster"), "cassandra", "INSERT");
        Assert.Null(await f.TicketAsync("blocked"));
        // Outside a Preview the same guarded session writes normally.
        using var response = await f.App.Client.PostAsync("/tickets/plain/via-cluster", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(await f.TicketAsync("plain"));
    }

    [ServiceFact("cassandra")]
    public async Task ARegistrationAfterAddCassandraStopsTheHostFromStarting()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Fixture.StartAsync(
            after: (services, _) => services.AddSingleton<CassandraSession>(_ => NewCluster().Connect())));
        Assert.Contains("registered again after AddCassandra", error.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync((_, bench) => bench.AddCassandra(), _ => { }));
    }

    [ServiceFact("cassandra")]
    public async Task AWriteWithNoRequestIsRefusedBeforeItIsSentAndBlocksTheOpenPreviewUnlessDetached()
    {
        await using var f = await Fixture.StartAsync();
        var session = f.App.Services.GetRequiredService<CassandraSession>();

        // A writer that lost the request context (a spawned task, a batching timer) while a Preview is open.
        f.Gates.Reset();
        var pending = f.App.PreviewAsync("POST", "/hold");
        await f.Gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var refused = await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => Gates.Detached(() =>
            session.ExecuteAsync(new global::Cassandra.SimpleStatement("INSERT INTO tickets (id, status, hits) VALUES ('bg', 'x', 1)"))));
        Assert.Equal("cassandra", refused.Store);
        f.Gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "cassandra", "INSERT");
        Assert.Null(await f.TicketAsync("bg"));

        // Detached work is never refused, and leaves the Preview alone.
        f.Gates.Reset();
        pending = f.App.PreviewAsync("POST", "/hold");
        await f.Gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Gates.Detached(async () =>
        {
            using var _ = DetachedWork.Begin();
            await session.ExecuteAsync(new global::Cassandra.SimpleStatement("INSERT INTO tickets (id, status, hits) VALUES ('job', 'x', 1)"));
        });
        f.Gates.Release.SetResult();
        await Expect.ConfirmedAsync(await pending);
        Assert.NotNull(await f.TicketAsync("job"));
    }

    [ServiceFact("cassandra")]
    public async Task ObservedSendWritesOnceAndTracesTheStatementWithoutItsLiterals()
    {
        await using var f = await Fixture.StartAsync();
        var (response, trace) = await f.App.ObservedAsync("POST", "/tickets/sent/touch");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var entry = Assert.Single(Expect.DbEntries(trace, "cassandra", "INSERT"));
        Assert.Equal("INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.Equal(1, (await f.TicketAsync("sent"))!.GetValue<int>("hits"));
    }

    [ServiceFact("cassandra")]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: without AddCassandra's decorator the same writes are sent and the Preview is "confirmed".
        await using var f = await Fixture.StartAsync(hooked: false);
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/tickets/unhooked/touch")).StatusCode);
        Assert.NotNull(await f.TicketAsync("unhooked"));
    }

    [ServiceFact("cassandra")]
    public async Task DiscoveryListsCassandraInGuardMode()
    {
        await using var f = await Fixture.StartAsync();
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("cassandra", "tickets", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
    }
}

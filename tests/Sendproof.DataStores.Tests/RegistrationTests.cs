using System.Reflection;
using System.Text;
using Elastic.Clients.Elasticsearch;
using Google.Cloud.Firestore;
using Google.Cloud.Firestore.V1;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.DependencyInjection;
using OpenSearch.Client;
using OpenSearch.Net;
using Sendproof.AspNetCore;
using Sendproof.Cassandra;
using Sendproof.CosmosDb;
using Sendproof.Elasticsearch;
using Sendproof.Firestore;
using Sendproof.OpenSearch;
using Xunit;
using CassandraSession = global::Cassandra.ISession;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// Every way a batch-two client can sit in the container is either guarded or stops the host from starting: a keyed
/// registration, an earlier registration of the same service (reachable through <c>IEnumerable&lt;T&gt;</c>), a client registered
/// by its class or a derived class, and the lower-level clients a store's client is built on. None of these needs a service.
/// </summary>
public sealed class RegistrationTests
{
    /// <summary>A Cassandra session that records the calls it gets and answers each with an empty result, so nothing is sent.</summary>
    public class FakeSession : DispatchProxy
    {
        internal List<string> Calls { get; } = [];

        internal static (CassandraSession Session, FakeSession Fake) Create()
        {
            var session = DispatchProxy.Create<CassandraSession, FakeSession>();
            return (session, (FakeSession)(object)session);
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            var method = targetMethod!;
            lock (Calls) Calls.Add(method.Name);
            if (method.ReturnType == typeof(Task<global::Cassandra.RowSet>)) return Task.FromResult(new global::Cassandra.RowSet());
            if (method.ReturnType == typeof(global::Cassandra.RowSet)) return new global::Cassandra.RowSet();
            if (method.ReturnType == typeof(string)) return "bench";
            return method.ReturnType.IsValueType && method.ReturnType != typeof(void) ? Activator.CreateInstance(method.ReturnType) : null;
        }
    }

    private static readonly global::Cassandra.SimpleStatement Insert = new("INSERT INTO tickets (id, status, hits) VALUES ('x', 'new', 1)");

    [Fact]
    public async Task EveryRegistrationOfACassandraSessionIsGuardedIncludingKeyedAndEarlierOnes()
    {
        var (first, firstFake) = FakeSession.Create();
        var (second, secondFake) = FakeSession.Create();
        var (keyed, keyedFake) = FakeSession.Create();
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(first);
            services.AddSingleton(second);
            services.AddKeyedSingleton("audit", keyed);
            bench.AddCassandra();
        }, app => app.MapPost("/all", async (IServiceProvider services) =>
        {
            var refused = 0;
            foreach (var session in services.GetServices<CassandraSession>().Append(services.GetRequiredKeyedService<CassandraSession>("audit")))
            {
                try { await session.ExecuteAsync(Insert); } catch (PreviewWriteBlockedException) { refused++; }
            }

            return Results.Ok(refused);
        }).AllowAnonymous().WithSendproofPreview());

        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/all"), "cassandra", "INSERT");
        Assert.All(new[] { firstFake, secondFake, keyedFake }, fake => Assert.DoesNotContain("ExecuteAsync", fake.Calls));
    }

    [Fact]
    public async Task ACassandraClusterRegisteredByItsClassStopsTheHostFromStarting()
    {
        // Cluster.Connect on the class would hand out raw sessions, and a class can't be decorated.
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(global::Cassandra.Cluster.Builder().AddContactPoint("127.0.0.1").Build());
            services.AddSingleton(FakeSession.Create().Session);
            bench.AddCassandra();
        }, _ => { }));
        Assert.Contains("Cluster", error.Message);
        Assert.Contains("ICluster", error.Message);
    }

    [Fact]
    public async Task AKeyedElasticsearchClientIsGuarded()
    {
        var wire = new SearchTests.RecordingInvoker();
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(SearchTests.NewElasticClient(new SearchTests.RecordingInvoker()));
            services.AddKeyedSingleton("logs", SearchTests.NewElasticClient(wire));
            bench.AddElasticsearch();
        }, app => app.MapPost("/log", async ([FromKeyedServices("logs")] ElasticsearchClient logs) =>
        {
            await logs.IndexAsync(new Dictionary<string, object> { ["a"] = 1 }, i => i.Index("logs"));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview());

        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/log"), "elasticsearch", "index");
        Assert.Empty(wire.Sent);
    }

    private sealed class AuditClient(ElasticsearchClientSettings settings) : ElasticsearchClient(settings);

    public static IEnumerable<object[]> Unguardable() =>
    [
        ["a derived Elasticsearch client", (Action<IServiceCollection, SendproofBuilder>)((services, bench) =>
        {
            services.AddSingleton(SearchTests.NewElasticClient(new SearchTests.RecordingInvoker()));
            services.AddSingleton(new AuditClient(new ElasticsearchClientSettings(new Uri("http://node-a:9200"))));
            bench.AddElasticsearch();
        }), "AuditClient"],
        ["the Elasticsearch transport", (Action<IServiceCollection, SendproofBuilder>)((services, bench) =>
        {
            var client = SearchTests.NewElasticClient(new SearchTests.RecordingInvoker());
            services.AddSingleton(client);
            services.AddSingleton<Elastic.Transport.ITransport>(client.Transport);
            bench.AddElasticsearch();
        }), "ITransport"],
        ["the OpenSearch low-level client", (Action<IServiceCollection, SendproofBuilder>)((services, bench) =>
        {
            services.AddSingleton<IOpenSearchClient>(SearchTests.NewOpenSearchClient(new SearchTests.RecordingConnection()));
            services.AddSingleton<IOpenSearchLowLevelClient>(new OpenSearchLowLevelClient(new global::OpenSearch.Net.ConnectionConfiguration(new Uri("http://node-a:9200"))));
            bench.AddOpenSearch();
        }), "IOpenSearchLowLevelClient"],
        ["a keyed Cosmos DB client built without the guard", (Action<IServiceCollection, SendproofBuilder>)((services, bench) =>
        {
            bench.AddCosmosDb();
            services.AddSingleton(provider => NewCosmosClient(new CosmosClientOptions().WithSendproofGuard(provider)));
            services.AddKeyedSingleton("archive", (_, _) => NewCosmosClient(new CosmosClientOptions()));
        }), "archive"],
        ["the generated Firestore gRPC client", (Action<IServiceCollection, SendproofBuilder>)((services, bench) =>
        {
            var transport = new FirestoreTests.FakeInvoker();
            services.AddSingleton(FirestoreDb.Create("bench", new FirestoreClientBuilder { CallInvoker = transport }.Build()));
            services.AddSingleton(new Google.Cloud.Firestore.V1.Firestore.FirestoreClient(transport));
            bench.AddFirestore();
        }), "FirestoreClient"]
    ];

    private static CosmosClient NewCosmosClient(CosmosClientOptions options) =>
        new("https://fake.documents.azure.com:443/", Convert.ToBase64String(Encoding.UTF8.GetBytes("bench-key-bench-key-bench-key-xx")), options);

    [Theory]
    [MemberData(nameof(Unguardable))]
    public async Task AClientTheGuardCantCoverStopsTheHostFromStarting(string what, Action<IServiceCollection, SendproofBuilder> register, string named)
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync(register, _ => { }));
        Assert.True(error.Message.Contains(named, StringComparison.Ordinal), $"{what}: {error.Message}");
    }

    [Fact]
    public async Task ARegisteredFirestoreClientIsGuardedAndADatabaseBuiltOnItIsCheckedOnce()
    {
        var transport = new FirestoreTests.FakeInvoker();
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(new FirestoreClientBuilder { CallInvoker = transport }.Build());
            services.AddSingleton(provider => FirestoreDb.Create("bench", provider.GetRequiredService<FirestoreClient>()));
            bench.AddFirestore();
        }, app =>
        {
            app.MapPost("/raw", async (FirestoreClient client) =>
            {
                await client.CommitAsync(new CommitRequest
                {
                    Database = "projects/bench/databases/(default)",
                    Writes = { new Write { Delete = "projects/bench/databases/(default)/documents/orders/o-1" } }
                });
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapGet("/read", async (FirestoreDb db) =>
            {
                var snapshot = await db.Collection("orders").Document("o-1").GetSnapshotAsync();
                return Results.Ok(snapshot.Exists);
            }).AllowAnonymous().WithSendproofPreview();
        });

        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/raw"), "firestore", "Commit");
        Assert.DoesNotContain("Commit", transport.Methods);
        var envelope = await Expect.ConfirmedAsync(await app.PreviewAsync("GET", "/read"));
        Assert.Single(Expect.DbEntries(envelope, "firestore", "BatchGetDocuments"));
    }
}

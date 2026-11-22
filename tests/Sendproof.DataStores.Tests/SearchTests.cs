using System.Net;
using System.Text;
using Elastic.Clients.Elasticsearch;
using Elastic.Transport;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using OpenSearch.Client;
using OpenSearch.Net;
using Sendproof.AspNetCore;
using Sendproof.Elasticsearch;
using Sendproof.OpenSearch;
using Xunit;
using Endpoint = Elastic.Transport.Endpoint;
using OsStringResponse = global::OpenSearch.Net.StringResponse;
using PostData = Elastic.Transport.PostData;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The Elasticsearch and OpenSearch write guards over in-memory connections that record what reaches the wire: a refusal happens
/// above the connection pool and the retry logic (in the client's transport), so a refused write never marks a node dead or is
/// retried, and the same writes reach the wire when the hook is removed.
/// </summary>
public sealed class SearchTests
{
    private static readonly string[] Nodes = ["http://node-a:9200", "http://node-b:9200"];

    // ---- Elasticsearch ----

    /// <summary>An invoker in front of an in-memory one that records every request that reaches it.</summary>
    internal sealed class RecordingInvoker : IRequestInvoker
    {
        private readonly InMemoryRequestInvoker _inner = new(Encoding.UTF8.GetBytes("""{"took":1,"hits":{"hits":[{"_id":"1","_source":{"title":"Seeded"}}]},"result":"updated"}"""),
            headers: new Dictionary<string, IEnumerable<string>> { ["x-elastic-product"] = ["Elasticsearch"] });

        internal List<string> Sent { get; } = [];

        public ResponseFactory ResponseFactory => _inner.ResponseFactory;

        public TResponse Request<TResponse>(Endpoint endpoint, BoundConfiguration boundConfiguration, PostData? postData) where TResponse : TransportResponse, new()
        {
            lock (Sent) Sent.Add(endpoint.Method + " " + endpoint.PathAndQuery);
            return _inner.Request<TResponse>(endpoint, boundConfiguration, postData);
        }

        public Task<TResponse> RequestAsync<TResponse>(Endpoint endpoint, BoundConfiguration boundConfiguration, PostData? postData, CancellationToken cancellationToken) where TResponse : TransportResponse, new()
        {
            lock (Sent) Sent.Add(endpoint.Method + " " + endpoint.PathAndQuery);
            return _inner.RequestAsync<TResponse>(endpoint, boundConfiguration, postData, cancellationToken);
        }

        public void Dispose() { }
    }

    internal static ElasticsearchClient NewElasticClient(RecordingInvoker invoker) => new(new ElasticsearchClientSettings(
        new StaticNodePool(Nodes.Select(node => new Uri(node))), invoker).DisablePing());

    private sealed class ElasticFixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required RecordingInvoker Wire { get; init; }
        internal required ElasticsearchClient Client { get; init; }

        internal TaskCompletionSource<Exception?> Late { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal static async Task<ElasticFixture> StartAsync(bool hooked = true)
        {
            var wire = new RecordingInvoker();
            var client = NewElasticClient(wire);
            var late = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton(client);
                if (hooked)
                {
                    bench.AddElasticsearch(search => search.WithName("articles"));
                }
                else
                {
                    services.AddSingleton<IPreviewDataStore>(new ElasticsearchStore(bench.Capture, "articles", new HashSet<string>()));
                }
            }, app =>
            {
                app.MapGet("/articles/{id}", async (string id, ElasticsearchClient search) =>
                {
                    // A read sent as a POST: the method alone must not decide.
                    var reply = await search.SearchAsync<Dictionary<string, object>>(s => s.Indices("articles").Query(q => q.Ids(i => i.Values(id))));
                    return Results.Ok(reply.Hits.Count);
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/touch", async (string id, ElasticsearchClient search) =>
                {
                    await search.UpdateAsync<Dictionary<string, object>, Dictionary<string, object>>("articles", id, u => u.Doc(new Dictionary<string, object> { ["views"] = 1 }));
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/hide", async (string id, ElasticsearchClient search) =>
                {
                    // _update_by_query is a POST with a query, like a search.
                    try { await search.UpdateByQueryAsync<Dictionary<string, object>>("articles", u => u.Query(q => q.Ids(i => i.Values(id)))); } catch (PreviewWriteBlockedException) { }
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/derived", async (string id, ElasticsearchClient search) =>
                {
                    // Namespaced clients share the transport.
                    await search.Indices.DeleteAsync("articles");
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/late", (string id, ElasticsearchClient search) =>
                {
                    // Started inside the Preview, writes after it ended: it still carries the Preview's context.
                    _ = Task.Run(async () =>
                    {
                        await Task.Delay(300);
                        try { await search.IndexAsync(new Dictionary<string, object> { ["late"] = id }, i => i.Index("articles")); late.SetResult(null); }
                        catch (Exception error) { late.SetResult(error); }
                    });
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/bulk", (string id, ElasticsearchClient search) =>
                {
                    // BulkAll queues documents and sends them from its own tasks, with back-off retries.
                    var observable = search.BulkAll(new[] { new Dictionary<string, object> { ["title"] = id } }, b => b.Index("articles").Size(1).MaxDegreeOfParallelism(1).BackOffRetries(3).BackOffTime(TimeSpan.FromSeconds(1)));
                    observable.Wait(TimeSpan.FromSeconds(20), _ => { });
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
            });
            var fixture = new ElasticFixture { App = app, Wire = wire, Client = client };
            late.Task.ContinueWith(task => fixture.Late.SetResult(task.Result), TaskScheduler.Default);
            return fixture;
        }

        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    [Fact]
    public async Task ElasticsearchReadsRunAndWritesAreRefusedBeforeTheyAreSent()
    {
        await using var f = await ElasticFixture.StartAsync();
        var read = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        var entry = Assert.Single(Expect.DbEntries(read, "elasticsearch", "search"));
        Assert.Equal("articles", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.DoesNotContain("seeded", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.Contains(f.Wire.Sent, sent => sent.Contains("articles/_search", StringComparison.Ordinal));

        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "elasticsearch", "update");
        Assert.Equal("Preview unavailable: this operation writes to Elasticsearch", problem.GetProperty("detail").GetString());
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/seeded/hide"), "elasticsearch", "update_by_query");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/x/derived"), "elasticsearch", "indices.delete");
        Assert.DoesNotContain(f.Wire.Sent, sent => !sent.Contains("articles/_search", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ElasticsearchRefusalHappensAboveThePoolSoNoNodeIsMarkedDeadAndTheNextReadRuns()
    {
        await using var f = await ElasticFixture.StartAsync();
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "elasticsearch", "update");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "elasticsearch", "update");
        var pool = f.Client.ElasticsearchClientSettings.NodePool;
        Assert.All(pool.Nodes, node => Assert.True(node.IsAlive, "A refused write must not take a node out of rotation."));
        // Nothing reached the wire for the refused writes, so there was nothing to retry; the next reads go to both nodes in turn.
        Assert.Empty(f.Wire.Sent);
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        Assert.Equal(2, f.Wire.Sent.Count);
    }

    [Fact]
    public async Task ElasticsearchBulkHelpersAndTheRegistrationAreGuarded()
    {
        await using var f = await ElasticFixture.StartAsync();
        var guarded = f.App.Services.GetRequiredService<ElasticsearchClient>();
        // The registered client is not the one the host built: it is a guarded one sharing its settings.
        Assert.NotSame(f.Client, guarded);
        Assert.Same(guarded, f.App.Services.GetRequiredService<ElasticsearchStore>().Guard(guarded));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync(
            (services, bench) =>
            {
                services.AddSingleton(NewElasticClient(new RecordingInvoker()));
                bench.AddElasticsearch();
                services.AddSingleton(NewElasticClient(new RecordingInvoker()));
            }, _ => { }));
        Assert.Contains("registered again after AddElasticsearch", error.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync((_, bench) => bench.AddElasticsearch(), _ => { }));
    }

    [Fact]
    public async Task AnElasticsearchWriteSentAfterItsPreviewEndedIsStillRefused()
    {
        await using var f = await ElasticFixture.StartAsync();
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/articles/a-1/late")).StatusCode);
        Assert.IsType<PreviewWriteBlockedException>(await f.Late.Task.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Empty(f.Wire.Sent);
    }

    [Fact]
    public async Task AnElasticsearchBulkHelperIsRefusedWithoutBeingRetried()
    {
        await using var f = await ElasticFixture.StartAsync();
        var started = DateTime.UtcNow;
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/queued/bulk"), "elasticsearch", "bulk");
        // The helper retries with a one second back-off; a refusal that reached it as a retryable error would take several seconds.
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(10), "The bulk helper must not retry a refused write.");
        Assert.Empty(f.Wire.Sent);
    }

    [Fact]
    public async Task ElasticsearchGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: without AddElasticsearch's decorator the same writes reach the wire and the Preview is "confirmed".
        await using var f = await ElasticFixture.StartAsync(hooked: false);
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/articles/unhooked/touch")).StatusCode);
        Assert.Contains(f.Wire.Sent, sent => sent.Contains("_update/unhooked", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ElasticsearchWriteWithNoRequestIsRefusedBeforeItIsSent()
    {
        var gates = new Gates();
        var wire = new RecordingInvoker();
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(NewElasticClient(wire));
            bench.AddElasticsearch();
        }, gates.Map);
        var client = app.Services.GetRequiredService<ElasticsearchClient>();
        gates.Reset();
        var pending = app.PreviewAsync("POST", "/hold");
        await gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // A bulk indexer's background thread: the write is refused when it is queued on the thread that sends it, not retried.
        var refused = await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => Gates.Detached(() => client.IndexAsync(new Dictionary<string, object> { ["a"] = 1 }, i => i.Index("articles"))));
        Assert.Equal("elasticsearch", refused.Store);
        gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "elasticsearch", "index");
        Assert.Empty(wire.Sent);
    }

    // ---- OpenSearch ----

    internal sealed class RecordingConnection : InMemoryConnection
    {
        internal RecordingConnection() : base(Encoding.UTF8.GetBytes("""{"took":1,"hits":{"hits":[{"_id":"1","_source":{"title":"Seeded"}}]},"result":"updated","items":[]}""")) { }

        internal List<string> Sent { get; } = [];

        public override TResponse Request<TResponse>(RequestData requestData)
        {
            lock (Sent) Sent.Add(requestData.Method + " " + requestData.PathAndQuery);
            return base.Request<TResponse>(requestData);
        }

        public override Task<TResponse> RequestAsync<TResponse>(RequestData requestData, CancellationToken cancellationToken)
        {
            lock (Sent) Sent.Add(requestData.Method + " " + requestData.PathAndQuery);
            return base.RequestAsync<TResponse>(requestData, cancellationToken);
        }
    }

    internal sealed class Doc
    {
        public string? Title { get; set; }
    }

    internal static OpenSearchClient NewOpenSearchClient(RecordingConnection connection) => new(new ConnectionSettings(
        new StaticConnectionPool(Nodes.Select(node => new Uri(node))), connection).DisablePing().SniffOnStartup(false).DefaultIndex("articles"));

    private sealed class OpenSearchFixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required RecordingConnection Wire { get; init; }
        internal required OpenSearchClient Client { get; init; }

        internal static async Task<OpenSearchFixture> StartAsync(bool hooked = true)
        {
            var wire = new RecordingConnection();
            var client = NewOpenSearchClient(wire);
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton<IOpenSearchClient>(client);
                if (hooked)
                {
                    bench.AddOpenSearch(search => search.WithName("articles"));
                }
                else
                {
                    services.AddSingleton<IPreviewDataStore>(new OpenSearchStore(bench.Capture, "articles", new HashSet<string>()));
                }
            }, app =>
            {
                app.MapGet("/articles/{id}", async (string id, IOpenSearchClient search) =>
                {
                    var reply = await search.SearchAsync<Doc>(s => s.Index("articles").Query(q => q.Ids(i => i.Values(id))));
                    return Results.Ok(reply.Hits.Count);
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/touch", async (string id, IOpenSearchClient search) =>
                {
                    await search.UpdateAsync<Doc, object>(id, u => u.Index("articles").Doc(new { views = 1 }));
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/hide", async (string id, IOpenSearchClient search) =>
                {
                    try { await search.UpdateByQueryAsync<Doc>(u => u.Index("articles").Query(q => q.Ids(i => i.Values(id)))); } catch (PreviewWriteBlockedException) { }
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/low-level", async (string id, IOpenSearchClient search) =>
                {
                    // The low-level client shares the transport.
                    await search.LowLevel.DeleteAsync<OsStringResponse>("articles", id);
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
                app.MapPost("/articles/{id}/bulk", (string id, IOpenSearchClient search) =>
                {
                    // A bulk helper queues documents and sends them from its own tasks, with retries: the refusal has to
                    // reach the caller instead of being retried until the helper gives up.
                    var observable = search.BulkAll(new[] { new Doc { Title = id } }, b => b.Index("articles").Size(1).MaxDegreeOfParallelism(1).BackOffRetries(3).BackOffTime("1s"));
                    observable.Wait(TimeSpan.FromSeconds(20), _ => { });
                    return Results.Ok();
                }).AllowAnonymous().WithSendproofPreview();
            });
            return new OpenSearchFixture { App = app, Wire = wire, Client = client };
        }

        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    [Fact]
    public async Task OpenSearchReadsRunAndWritesAreRefusedBeforeTheyAreSent()
    {
        await using var f = await OpenSearchFixture.StartAsync();
        var read = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        var entry = Assert.Single(Expect.DbEntries(read, "opensearch", "search"));
        Assert.Equal("articles", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.DoesNotContain("seeded", entry.GetProperty("db").GetProperty("statement").GetString());

        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "opensearch", "update");
        Assert.Equal("Preview unavailable: this operation writes to OpenSearch", problem.GetProperty("detail").GetString());
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/seeded/hide"), "opensearch", "update_by_query");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/x/low-level"), "opensearch", "delete");
        Assert.DoesNotContain(f.Wire.Sent, sent => !sent.Contains("articles/_search", StringComparison.Ordinal));
    }

    [Fact]
    public async Task OpenSearchRefusalHappensAboveThePoolSoNoNodeIsMarkedDeadAndTheNextReadRuns()
    {
        await using var f = await OpenSearchFixture.StartAsync();
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "opensearch", "update");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/blocked/touch"), "opensearch", "update");
        Assert.All(f.Client.ConnectionSettings.ConnectionPool.Nodes, node => Assert.True(node.IsAlive, "A refused write must not take a node out of rotation."));
        Assert.Empty(f.Wire.Sent);
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/articles/seeded"));
        Assert.Equal(2, f.Wire.Sent.Count);
    }

    [Fact]
    public async Task AnOpenSearchBulkHelperIsRefusedWithoutBeingRetriedAndTheWholeClassOfClientsIsRegistered()
    {
        await using var f = await OpenSearchFixture.StartAsync();
        var started = DateTime.UtcNow;
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/articles/queued/bulk"), "opensearch", "bulk");
        // The helper retries with a one second back-off; a refusal that reached it as a retryable error would take several seconds.
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(10), "The bulk helper must not retry a refused write.");
        Assert.Empty(f.Wire.Sent);

        // A client registered by its class, and one registered again later.
        var classWire = new RecordingConnection();
        await using var byClass = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(NewOpenSearchClient(classWire));
            bench.AddOpenSearch();
        }, app => app.MapPost("/touch", async (OpenSearchClient search) =>
        {
            await search.IndexDocumentAsync(new Doc { Title = "x" });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview());
        await Expect.BlockedAsync(await byClass.PreviewAsync("POST", "/touch"), "opensearch", "index");
        Assert.Empty(classWire.Sent);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync(
            (services, bench) => { services.AddSingleton<IOpenSearchClient>(NewOpenSearchClient(new RecordingConnection())); bench.AddOpenSearch(); services.AddSingleton<IOpenSearchClient>(NewOpenSearchClient(new RecordingConnection())); }, _ => { }));
        Assert.Contains("registered again after AddOpenSearch", error.Message);
    }

    [Fact]
    public async Task OpenSearchGuardChecksFailWhenTheHookIsRemoved()
    {
        await using var f = await OpenSearchFixture.StartAsync(hooked: false);
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/articles/unhooked/touch")).StatusCode);
        Assert.Contains(f.Wire.Sent, sent => sent.Contains("_update/unhooked", StringComparison.Ordinal));
    }

    [Fact]
    public async Task OpenSearchWriteWithNoRequestIsRefusedBeforeItIsSent()
    {
        var gates = new Gates();
        var wire = new RecordingConnection();
        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton<IOpenSearchClient>(NewOpenSearchClient(wire));
            bench.AddOpenSearch();
        }, gates.Map);
        var client = app.Services.GetRequiredService<IOpenSearchClient>();
        gates.Reset();
        var pending = app.PreviewAsync("POST", "/hold");
        await gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var refused = await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => Gates.Detached(() => client.IndexDocumentAsync(new Doc { Title = "bg" })));
        Assert.Equal("opensearch", refused.Store);
        gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "opensearch", "index");
        Assert.Empty(wire.Sent);
    }

    [Fact]
    public async Task BothSearchStoresAreListedInGuardModeUnderTheirOwnNames()
    {
        await using var es = await ElasticFixture.StartAsync();
        var store = Assert.Single((await es.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("elasticsearch", "articles", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
        await using var os = await OpenSearchFixture.StartAsync();
        store = Assert.Single((await os.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("opensearch", "articles", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
    }
}

using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.CosmosDb;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// An in-memory Cosmos DB gateway for the real SDK in gateway mode: it answers the account, container and partition-key-range
/// reads the SDK makes before an item request, and stores items. The partition-key-range feed answers 304 Not Modified once the
/// SDK sends back the ETag it was given, which is how the SDK knows it has every range; a feed that always answered 200 would
/// make it read the feed forever.
/// </summary>
internal sealed class FakeCosmosGateway : HttpMessageHandler
{
    internal const string Endpoint = "https://fake.documents.azure.com:443/";
    private const string DatabaseRid = "pLJdAA==";
    private const string ContainerRid = "pLJdAOlEdl4=";
    private const string RangesEtag = "\"pk-1\"";
    private readonly Dictionary<string, JsonObject> _items = [];

    /// <summary>Every item request that reached the gateway: method, path and whether it was a batch.</summary>
    internal List<string> ItemRequests { get; } = [];

    /// <summary>Every request that reached the gateway with a method other than GET, on any resource.</summary>
    internal List<string> NotGets { get; } = [];

    internal void Seed(string id, JsonObject item)
    {
        lock (_items) _items[id] = item;
    }

    internal bool Has(string id)
    {
        lock (_items) return _items.ContainsKey(id);
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath.Trim('/');
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (request.Method != HttpMethod.Get)
        {
            lock (NotGets) NotGets.Add($"{request.Method} /{path}");
        }

        if (segments.Length == 0)
        {
            return Json(HttpStatusCode.OK, Account());
        }

        if (segments is [_, _, _, _, "pkranges"])
        {
            if (request.Headers.TryGetValues("If-None-Match", out var etags) && etags.Contains(RangesEtag))
            {
                return Json(HttpStatusCode.NotModified, null, RangesEtag);
            }

            return Json(HttpStatusCode.OK, $$"""
                {"_rid":"{{ContainerRid}}","PartitionKeyRanges":[{"_rid":"pLJdAOlEdl4CAAAAAAAAUA==","id":"0","_etag":"\"0\"","minInclusive":"","maxExclusive":"FF","ridPrefix":0,"_self":"dbs/{{DatabaseRid}}/colls/{{ContainerRid}}/pkranges/pLJdAOlEdl4CAAAAAAAAUA==/","throughputFraction":1,"status":"online","parents":[],"_ts":1,"_lsn":1}],"_count":1}
                """, RangesEtag);
        }

        if (segments is ["dbs", _, "colls", _])
        {
            return Json(HttpStatusCode.OK, $$$"""
                {"id":"orders","_rid":"{{{ContainerRid}}}","_self":"dbs/{{{DatabaseRid}}}/colls/{{{ContainerRid}}}/","_etag":"\"c-1\"","_ts":1,"partitionKey":{"paths":["/id"],"kind":"Hash","version":2},"indexingPolicy":{"indexingMode":"consistent","automatic":true,"includedPaths":[{"path":"/*"}],"excludedPaths":[]},"geospatialConfig":{"type":"Geography"}}
                """);
        }

        if (segments is ["dbs", _] && request.Method == HttpMethod.Get)
        {
            return Json(HttpStatusCode.OK, $$"""{"id":"shop","_rid":"{{DatabaseRid}}","_self":"dbs/{{DatabaseRid}}/","_etag":"\"d-1\"","_ts":1}""");
        }

        if (segments is ["dbs", _, "colls", _, "docs", ..])
        {
            var batch = request.Headers.TryGetValues("x-ms-cosmos-is-batch-request", out var flags) && flags.Any(flag => flag.Equals("true", StringComparison.OrdinalIgnoreCase));
            lock (ItemRequests) ItemRequests.Add($"{request.Method} /{path}{(batch ? " batch" : "")}");
            if (batch)
            {
                // The guard must refuse a batch before it gets here; answer as a service that can't take it.
                return Json(HttpStatusCode.BadRequest, """{"code":"BadRequest","message":"The fake gateway does not run batches."}""");
            }

            if (segments.Length == 6 && request.Method == HttpMethod.Get)
            {
                lock (_items)
                {
                    return _items.TryGetValue(segments[5], out var found)
                        ? Json(HttpStatusCode.OK, found.ToJsonString())
                        : Json(HttpStatusCode.NotFound, """{"code":"NotFound","message":"Entity with the specified id does not exist in the system."}""");
                }
            }

            if (segments.Length == 5 && request.Method == HttpMethod.Post)
            {
                var item = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!.AsObject();
                item["_rid"] = "pLJdAOlEdl4BAAAAAAAAAA==";
                item["_etag"] = "\"i-1\"";
                item["_ts"] = 1;
                lock (_items) _items[item["id"]!.GetValue<string>()] = item;
                return Json(HttpStatusCode.Created, item.ToJsonString());
            }

            if (segments.Length == 6 && request.Method == HttpMethod.Delete)
            {
                lock (_items) _items.Remove(segments[5]);
                return Json(HttpStatusCode.NoContent, null);
            }
        }

        return Json(HttpStatusCode.NotFound, """{"code":"NotFound","message":"The fake gateway does not serve this path."}""");
    }

    private static string Account() => $$"""
        {"_self":"","id":"fake","_rid":"fake.documents.azure.com","media":"//media/","addresses":"//addresses/","_dbs":"//dbs/",
         "writableLocations":[{"name":"Local","databaseAccountEndpoint":"{{Endpoint}}"}],
         "readableLocations":[{"name":"Local","databaseAccountEndpoint":"{{Endpoint}}"}],
         "enableMultipleWriteLocations":false,
         "userReplicationPolicy":{"asyncReplication":false,"minReplicaSetSize":1,"maxReplicasetSize":4},
         "userConsistencyPolicy":{"defaultConsistencyLevel":"Session"},
         "systemReplicationPolicy":{"minReplicaSetSize":1,"maxReplicasetSize":4},
         "readPolicy":{"primaryReadCoefficient":1,"secondaryReadCoefficient":1},
         "queryEngineConfiguration":"{\"maxSqlQueryInputLength\":262144,\"maxJoinsPerSqlQuery\":5,\"maxLogicalAndPerSqlQuery\":500,\"maxLogicalOrPerSqlQuery\":500,\"maxUdfRefPerSqlQuery\":10,\"maxInExpressionItemsCount\":16000,\"queryMaxInMemorySortDocumentCount\":500,\"maxQueryRequestTimeoutFraction\":0.9,\"sqlAllowNonFiniteNumbers\":false,\"sqlAllowAggregateFunctions\":true,\"sqlAllowSubQuery\":true,\"sqlAllowScalarSubQuery\":true,\"allowNewKeywords\":true,\"sqlAllowLike\":false,\"sqlAllowGroupByClause\":true,\"maxSpatialQueryCells\":12,\"spatialMaxGeometryPointCount\":256,\"sqlDisableOptimizationFlags\":0,\"sqlAllowTop\":true,\"enableSpatialIndexing\":true}"}
        """;

    private static HttpResponseMessage Json(HttpStatusCode status, string? body, string? etag = null)
    {
        var response = new HttpResponseMessage(status);
        if (body is not null)
        {
            response.Content = new StringContent(body, Encoding.UTF8, "application/json");
        }
        else
        {
            response.Content = new ByteArrayContent([]);
        }

        response.Headers.TryAddWithoutValidation("x-ms-activity-id", Guid.NewGuid().ToString());
        response.Headers.TryAddWithoutValidation("x-ms-request-charge", "1");
        response.Headers.TryAddWithoutValidation("x-ms-session-token", "0:1#1");
        if (etag is not null)
        {
            response.Headers.TryAddWithoutValidation("etag", etag);
        }

        return response;
    }
}

/// <summary>
/// The Cosmos DB guard on the real SDK, in gateway mode against <see cref="FakeCosmosGateway"/>: a request handler built into the
/// client's own pipeline sees every item request before it is sent, and bulk mode, which queues operations and sends them as
/// batches from the SDK's own dispatcher, is refused without hanging the caller.
/// </summary>
public sealed class CosmosDbSdkTests
{
    private sealed record Order(string id, string status);

    private static CosmosClient NewClient(FakeCosmosGateway gateway, CosmosClientOptions options)
    {
        options.ConnectionMode = ConnectionMode.Gateway;
        options.LimitToEndpoint = true;
        options.HttpClientFactory = () => new HttpClient(gateway, disposeHandler: false);
        return new CosmosClient(FakeCosmosGateway.Endpoint, Convert.ToBase64String(Encoding.UTF8.GetBytes("bench-key-bench-key-bench-key-xx")), options);
    }

    private static Task<TestApp> StartAsync(FakeCosmosGateway gateway, bool bulk = false) => TestApp.StartAsync(
        (services, bench) =>
        {
            bench.AddCosmosDb(cosmos => cosmos.WithName("orders"));
            services.AddSingleton(provider => NewClient(gateway, new CosmosClientOptions { AllowBulkExecution = bulk }.WithSendproofGuard(provider)));
        },
        app =>
        {
            Container Orders(CosmosClient client) => client.GetContainer("shop", "orders");
            app.MapGet("/orders/{id}", async (string id, CosmosClient client) =>
            {
                var order = await Orders(client).ReadItemAsync<Order>(id, new PartitionKey(id));
                return Results.Ok(order.Resource);
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/orders/{id}", async (string id, CosmosClient client) =>
            {
                await Orders(client).CreateItemAsync(new Order(id, "new"), new PartitionKey(id));
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/orders/{id}/swallow", async (string id, CosmosClient client) =>
            {
                try { await Orders(client).CreateItemAsync(new Order(id, "new"), new PartitionKey(id)); } catch (PreviewWriteBlockedException) { }
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
        });

    [Fact]
    public async Task TheRealSdkReadsThroughTheGuardAndAWriteIsRefusedBeforeItIsSent()
    {
        var gateway = new FakeCosmosGateway();
        gateway.Seed("o-1", new JsonObject { ["id"] = "o-1", ["status"] = "open" });
        await using var app = await StartAsync(gateway);

        var envelope = await Expect.ConfirmedAsync(await app.PreviewAsync("GET", "/orders/o-1"));
        Assert.Equal("open", envelope.GetProperty("body").GetProperty("status").GetString());
        var entry = Assert.Single(Expect.DbEntries(envelope, "cosmosdb", "Read"));
        Assert.Equal("orders", entry.GetProperty("db").GetProperty("target").GetString());

        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/orders/o-2/swallow"), "cosmosdb", "Create");
        Assert.DoesNotContain(gateway.ItemRequests, sent => sent.StartsWith("POST", StringComparison.Ordinal));
        Assert.False(gateway.Has("o-2"));

        // Outside a Preview the same client writes.
        using var response = await app.Client.PostAsync("/orders/o-3", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(gateway.Has("o-3"));
    }

    /// <summary>Each write path of the SDK, by the operation the guard reports for it.</summary>
    private static readonly Dictionary<string, Func<Container, Task>> WritePaths = new()
    {
        ["upsert"] = orders => orders.UpsertItemAsync(new Order("o-1", "new"), new PartitionKey("o-1")),
        ["replace"] = orders => orders.ReplaceItemAsync(new Order("o-1", "new"), "o-1", new PartitionKey("o-1")),
        ["patch"] = orders => orders.PatchItemAsync<Order>("o-1", new PartitionKey("o-1"), [PatchOperation.Set("/status", "paid")]),
        ["delete"] = orders => orders.DeleteItemAsync<Order>("o-1", new PartitionKey("o-1")),
        ["batch"] = orders => orders.CreateTransactionalBatch(new PartitionKey("o-1")).ReadItem("o-1").ExecuteAsync(),
        ["sproc"] = orders => orders.Scripts.ExecuteStoredProcedureAsync<string>("touch", new PartitionKey("o-1"), []),
        ["sproc-create"] = orders => orders.Scripts.CreateStoredProcedureAsync(new Microsoft.Azure.Cosmos.Scripts.StoredProcedureProperties("touch", "function () {}")),
        ["trigger"] = orders => orders.ReadItemAsync<Order>("o-1", new PartitionKey("o-1"), new ItemRequestOptions { PreTriggers = ["stamp"] }),
        ["container-delete"] = orders => orders.DeleteContainerAsync()
    };

    [Theory]
    [InlineData("upsert", "Upsert")]
    [InlineData("replace", "Replace")]
    [InlineData("patch", "Patch")]
    [InlineData("delete", "Delete")]
    [InlineData("batch", "Batch")]
    [InlineData("sproc", "ExecuteJavaScript")]
    [InlineData("sproc-create", "Create")]
    [InlineData("trigger", "Read")]
    [InlineData("container-delete", "Delete")]
    public async Task EveryRealSdkWritePathIsRefusedBeforeItIsSent(string path, string operation)
    {
        var gateway = new FakeCosmosGateway();
        gateway.Seed("o-1", new JsonObject { ["id"] = "o-1", ["status"] = "open" });
        await using var app = await TestApp.StartAsync(
            (services, bench) =>
            {
                bench.AddCosmosDb();
                services.AddSingleton(provider => NewClient(gateway, new CosmosClientOptions().WithSendproofGuard(provider)));
            },
            app => app.MapPost("/op/{name}", async (string name, CosmosClient client) =>
            {
                await WritePaths[name](client.GetContainer("shop", "orders"));
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview());

        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/op/" + path), "cosmosdb", operation);
        Assert.Empty(gateway.NotGets);
        Assert.True(gateway.Has("o-1"));
    }

    /// <summary>
    /// Sends one bulk-mode create outside a Preview and says what became of it. The fake gateway doesn't run batches, so a batch
    /// that reached it comes back as a <see cref="CosmosException"/>: "sent" means the guard let it through.
    /// </summary>
    private static async Task<string> PlainBulkCreateAsync(TestApp app, string id)
    {
        using var response = await app.Client.PostAsync($"/orders/{id}/outcome", null);
        return await response.Content.ReadAsStringAsync();
    }

    private static Task<TestApp> StartBulkAsync(FakeCosmosGateway gateway, Gates gates) => TestApp.StartAsync(
        (services, bench) =>
        {
            bench.AddCosmosDb();
            services.AddSingleton(provider => NewClient(gateway, new CosmosClientOptions { AllowBulkExecution = true }.WithSendproofGuard(provider)));
        },
        app =>
        {
            app.MapPost("/orders/{id}/swallow", async (string id, CosmosClient client) =>
            {
                try { await client.GetContainer("shop", "orders").CreateItemAsync(new Order(id, "new"), new PartitionKey(id)); } catch (PreviewWriteBlockedException) { }
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/orders/{id}/outcome", async (string id, CosmosClient client) =>
            {
                try
                {
                    await client.GetContainer("shop", "orders").CreateItemAsync(new Order(id, "new"), new PartitionKey(id));
                    return "created";
                }
                catch (PreviewWriteBlockedException) { return "refused"; }
                catch (CosmosException) { return "sent"; }
            }).AllowAnonymous();
            gates.Map(app);
        });

    /// <summary>
    /// Bulk mode queues item operations without passing them through the request handlers and sends them as one batch from the
    /// SDK's dispatcher, in the context of whichever request created it. When an ordinary request created it, a Preview's bulk
    /// write used to carry that request's context and be sent. Now the batch is refused while the Preview is open, the caller
    /// gets the refusal at once instead of waiting on retries, nothing reaches the service, and the next ordinary bulk write is
    /// sent as before.
    /// </summary>
    [Fact]
    public async Task ABulkModeWriteInAPreviewIsRefusedWithoutHangingEvenWhenAnOrdinaryRequestStartedTheDispatcher()
    {
        var gateway = new FakeCosmosGateway();
        await using var app = await StartBulkAsync(gateway, new Gates());
        Assert.Equal("sent", await PlainBulkCreateAsync(app, "plain-1"));
        Assert.Single(gateway.ItemRequests);

        var started = DateTime.UtcNow;
        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/orders/p-1/swallow"), "cosmosdb", "Batch");
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(10), "The bulk caller must get the refusal, not wait on retries.");
        Assert.Single(gateway.ItemRequests);

        Assert.Equal("sent", await PlainBulkCreateAsync(app, "plain-2"));
        Assert.Equal(2, gateway.ItemRequests.Count);
    }

    /// <summary>
    /// When a Preview created the dispatcher, every later batch ran in that Preview's context, which stays marked as a Preview,
    /// so every ordinary bulk write was refused for as long as the process ran. Now an ordinary write after the Preview is sent.
    /// </summary>
    [Fact]
    public async Task ABulkModeDispatcherStartedByAPreviewDoesNotRefuseOrdinaryWritesAfterIt()
    {
        var gateway = new FakeCosmosGateway();
        await using var app = await StartBulkAsync(gateway, new Gates());
        await Expect.BlockedAsync(await app.PreviewAsync("POST", "/orders/p-1/swallow"), "cosmosdb", "Batch");
        Assert.Empty(gateway.ItemRequests);
        Assert.Equal("sent", await PlainBulkCreateAsync(app, "plain-1"));
        Assert.Single(gateway.ItemRequests);
    }

    /// <summary>
    /// A batch can carry any caller's operations, so while a Preview is open an ordinary request's bulk write is refused too
    /// (as a write with no request is), and the open Preview answers 409.
    /// </summary>
    [Fact]
    public async Task WhileAPreviewIsOpenEveryBulkBatchIsRefusedAndBlocksIt()
    {
        var gateway = new FakeCosmosGateway();
        var gates = new Gates();
        await using var app = await StartBulkAsync(gateway, gates);
        gates.Reset();
        var pending = app.PreviewAsync("POST", "/hold");
        await gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("refused", await PlainBulkCreateAsync(app, "plain-1"));
        gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "cosmosdb", "Batch");
        Assert.Empty(gateway.ItemRequests);
    }
}

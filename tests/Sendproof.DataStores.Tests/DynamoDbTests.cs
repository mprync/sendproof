using System.Net;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.DataModel;
using Amazon.DynamoDBv2.Model;
using Amazon.Runtime;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.DynamoDB;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The DynamoDB write guard against DynamoDB Local (compose service): reads, writes, PartiQL, batches and the
/// object-persistence context are refused before they are signed or sent, and credentials never reach a capture.
/// </summary>
public sealed class DynamoDbTests
{
    private const string SecretKey = "benchDynamoSecretValue";

    private static AmazonDynamoDBClient NewClient() => new(new BasicAWSCredentials("benchlocal", SecretKey),
        new AmazonDynamoDBConfig { ServiceURL = Services.DynamoUrl, AuthenticationRegion = "us-east-1" });

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required AmazonDynamoDBClient Reader { get; init; }
        internal required string Table { get; init; }

        /// <summary>
        /// <paramref name="beforeRegistration"/> is a client created before the guard is registered, the way a host that
        /// built its client at startup would: it is not covered.
        /// </summary>
        internal static async Task<Fixture> StartAsync(Action<DynamoStoreBuilder>? configure = null, bool hooked = true)
        {
            var table = Services.Fresh("tb");
            var earlier = NewClient();
            await earlier.CreateTableAsync(new CreateTableRequest
            {
                TableName = table,
                KeySchema = [new KeySchemaElement("id", KeyType.HASH)],
                AttributeDefinitions = [new AttributeDefinition("id", ScalarAttributeType.S)],
                BillingMode = BillingMode.PAY_PER_REQUEST
            });
            var app = await TestApp.StartAsync((services, bench) =>
            {
                if (hooked)
                {
                    bench.AddDynamoDB(dynamo =>
                    {
                        dynamo.WithName("orders");
                        configure?.Invoke(dynamo);
                    });
                }

                else
                {
                    // The hook removed: the store is listed (so a Preview can run) but no pipeline handler is installed.
                    services.AddSingleton<IPreviewDataStore>(new DynamoStore("orders"));
                }

                // Created after AddDynamoDB: the guard is in its pipeline.
                services.AddSingleton<IAmazonDynamoDB>(_ => NewClient());
            }, app => Map(app, table, earlier));
            return new Fixture { App = app, Reader = earlier, Table = table };
        }

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            try { await Reader.DeleteTableAsync(Table); } catch (AmazonDynamoDBException) { }
            Reader.Dispose();
        }

        internal async Task<Dictionary<string, AttributeValue>?> ItemAsync(string id) =>
            (await Reader.GetItemAsync(Table, new() { ["id"] = new AttributeValue { S = id } }, consistentRead: true)).Item is { Count: > 0 } item ? item : null;

        internal Task SeedAsync(string id, string status, int hits) => Reader.PutItemAsync(Table, new()
        {
            ["id"] = new AttributeValue { S = id }, ["status"] = new AttributeValue { S = status }, ["hits"] = new AttributeValue { N = hits.ToString() }
        });
    }

    [DynamoDBTable("overridden")]
    private sealed class Order
    {
        [DynamoDBHashKey("id")] public string Id { get; set; } = "";
        [DynamoDBProperty("status")] public string Status { get; set; } = "";
    }

    private static void Map(WebApplication app, string table, AmazonDynamoDBClient earlier)
    {
        static object Shape(Dictionary<string, AttributeValue> item) =>
            new { id = item["id"].S, status = item.TryGetValue("status", out var status) ? status.S : null, hits = item.TryGetValue("hits", out var hits) ? int.Parse(hits.N) : 0 };

        app.MapGet("/orders/{id}", async (string id, IAmazonDynamoDB dynamo) =>
        {
            var response = await dynamo.GetItemAsync(table, new() { ["id"] = new AttributeValue { S = id } }, consistentRead: true);
            return response.Item is { Count: > 0 } ? Results.Ok(Shape(response.Item)) : Results.NotFound();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/touch", async (string id, IAmazonDynamoDB dynamo) =>
        {
            var response = await dynamo.UpdateItemAsync(new UpdateItemRequest
            {
                TableName = table,
                Key = new() { ["id"] = new AttributeValue { S = id } },
                UpdateExpression = "ADD hits :one SET #s = if_not_exists(#s, :new)",
                ExpressionAttributeNames = new() { ["#s"] = "status" },
                ExpressionAttributeValues = new() { [":one"] = new AttributeValue { N = "1" }, [":new"] = new AttributeValue { S = "new" } },
                ReturnValues = ReturnValue.ALL_NEW
            });
            return Results.Ok(Shape(response.Attributes));
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/cancel", async (string id, IAmazonDynamoDB dynamo) =>
        {
            await dynamo.ExecuteStatementAsync(new ExecuteStatementRequest
            {
                Statement = $"UPDATE \"{table}\" SET status = 'cancelled' WHERE id = ?",
                Parameters = [new AttributeValue { S = id }]
            });
            return Results.Ok(new { id, status = "cancelled" });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapGet("/orders/{id}/select", async (string id, IAmazonDynamoDB dynamo) =>
        {
            var response = await dynamo.ExecuteStatementAsync(new ExecuteStatementRequest { Statement = $"SELECT * FROM \"{table}\" WHERE id = '{id}'" });
            return Results.Ok(new { count = response.Items.Count });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapDelete("/orders/{id}", async (string id, IAmazonDynamoDB dynamo) =>
        {
            await dynamo.DeleteItemAsync(table, new() { ["id"] = new AttributeValue { S = id } });
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to DynamoDB", "dynamodb");
        app.MapPost("/orders/{id}/batch", async (string id, string kind, IAmazonDynamoDB dynamo) =>
        {
            var item = new Dictionary<string, AttributeValue> { ["id"] = new AttributeValue { S = id } };
            if (kind == "batchWrite")
            {
                await dynamo.BatchWriteItemAsync(new BatchWriteItemRequest { RequestItems = new() { [table] = [new WriteRequest(new PutRequest(item))] } });
            }
            else if (kind == "transactWrite")
            {
                await dynamo.TransactWriteItemsAsync(new TransactWriteItemsRequest
                {
                    TransactItems = [new TransactWriteItem { ConditionCheck = new ConditionCheck { TableName = table, Key = item, ConditionExpression = "attribute_not_exists(id)" } }]
                });
            }
            else
            {
                await dynamo.TransactGetItemsAsync(new TransactGetItemsRequest { TransactItems = [new TransactGetItem { Get = new Get { TableName = table, Key = item } }] });
            }

            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/conditional", async (string id, IAmazonDynamoDB dynamo) =>
        {
            // A conditional write whose condition will fail is still a write: it is refused, not sent.
            try
            {
                await dynamo.PutItemAsync(new PutItemRequest
                {
                    TableName = table, Item = new() { ["id"] = new AttributeValue { S = id } },
                    ConditionExpression = "attribute_exists(id)"
                });
            }
            catch (PreviewWriteBlockedException) { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/context", async (string id, string mode, IAmazonDynamoDB dynamo) =>
        {
            using var context = new DynamoDBContextBuilder().WithDynamoDBClient(() => dynamo).Build();
            var config = new LoadConfig { OverrideTableName = table };
            if (mode == "save")
            {
                await context.SaveAsync(new Order { Id = id, Status = "saved" }, new SaveConfig { OverrideTableName = table });
                return Results.Ok();
            }

            var order = await context.LoadAsync<Order>(id, config);
            return order is null ? Results.NotFound() : Results.Ok(new { order.Id, order.Status });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/describe", async (IAmazonDynamoDB dynamo) =>
        {
            try { await dynamo.DescribeBackupAsync(new DescribeBackupRequest { BackupArn = "arn:aws:dynamodb:us-east-1:000000000000:table/x/backup/01" }); }
            catch (AmazonDynamoDBException) { /* DynamoDB Local doesn't know backups: the point is that it was sent. */ }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/early", async (string id) =>
        {
            // A client created before the guard was registered: not covered, so this write is neither blocked nor rolled back.
            await earlier.PutItemAsync(table, new() { ["id"] = new AttributeValue { S = id }, ["status"] = new AttributeValue { S = "early" } });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
    }

    [ServiceFact("dynamodb")]
    public async Task AReadRunsAndIsLoggedWithoutCredentials()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("seeded", "open", 3);
        var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/orders/seeded"));
        Assert.Equal("open", envelope.GetProperty("body").GetProperty("status").GetString());
        var entry = Assert.Single(Expect.DbEntries(envelope, "dynamodb", "GetItem"));
        Assert.Equal(f.Table, entry.GetProperty("db").GetProperty("target").GetString());
        Assert.Equal(1, entry.GetProperty("db").GetProperty("rowsAffected").GetInt32());
        var text = envelope.GetRawText();
        Assert.DoesNotContain(SecretKey, text);
        Assert.DoesNotContain("AWS4-HMAC-SHA256", text);
        Assert.DoesNotContain("benchlocal", text);
    }

    [ServiceFact("dynamodb")]
    public async Task UpdateItemIsRefusedBeforeItIsSentWhateverItsReturnValues()
    {
        await using var f = await Fixture.StartAsync();
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/blocked/touch"), "dynamodb", "UpdateItem");
        Assert.Equal("Preview unavailable: this operation writes to DynamoDB", problem.GetProperty("detail").GetString());
        Assert.Null(await f.ItemAsync("blocked"));
    }

    [ServiceFact("dynamodb")]
    public async Task PartiqlSelectRunsButUpdateIsARefusedWriteAndLiteralsNeverReachTheLog()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("seeded", "open", 3);
        var read = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/orders/seeded/select"));
        Assert.Equal(1, read.GetProperty("body").GetProperty("count").GetInt32());
        var entry = Assert.Single(Expect.DbEntries(read, "dynamodb", "ExecuteStatement"));
        Assert.Equal($"SELECT * FROM \"{f.Table}\" WHERE id = ?", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.DoesNotContain("'seeded'", read.GetRawText());

        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/seeded/cancel"), "dynamodb", "ExecuteStatement");
        Assert.Equal("open", (await f.ItemAsync("seeded"))!["status"].S);
    }

    [ServiceFact("dynamodb")]
    public async Task BatchesTransactionsAndConditionalWritesAreWritesButTransactGetIsARead()
    {
        await using var f = await Fixture.StartAsync();
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/b1/batch?kind=batchWrite"), "dynamodb", "BatchWriteItem");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/b2/batch?kind=transactWrite"), "dynamodb", "TransactWriteItems");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/b3/conditional"), "dynamodb", "PutItem");
        Assert.Null(await f.ItemAsync("b1"));
        Assert.Null(await f.ItemAsync("b3"));
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/orders/b4/batch?kind=transactGet"));
    }

    [ServiceFact("dynamodb")]
    public async Task TheObjectPersistenceContextSharesTheClientSoItIsGuardedToo()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("ctx", "stored", 1);
        var loaded = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/orders/ctx/context?mode=load"));
        Assert.Equal("stored", loaded.GetProperty("body").GetProperty("status").GetString());
        var response = await f.App.PreviewAsync("POST", "/orders/saved/context?mode=save");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Null(await f.ItemAsync("saved"));
    }

    [ServiceFact("dynamodb")]
    public async Task HostDeclaredReadsAreSentButOnlyByExactActionName()
    {
        await using var blocked = await Fixture.StartAsync();
        await Expect.BlockedAsync(await blocked.App.PreviewAsync("POST", "/orders/x/describe"), "dynamodb", "DescribeBackup");
        await using var allowed = await Fixture.StartAsync(dynamo => dynamo.TreatAsRead("DescribeBackup"));
        var envelope = await Expect.ConfirmedAsync(await allowed.App.PreviewAsync("POST", "/orders/x/describe"));
        Assert.Single(Expect.DbEntries(envelope, "dynamodb", "DescribeBackup"));
        Assert.Throws<ArgumentException>(() => new DynamoStoreBuilder().TreatAsRead("Describe*"));
    }

    [ServiceFact("dynamodb")]
    public async Task AClientCreatedBeforeTheRegistrationIsNotCovered()
    {
        // The documented limit: the guard is a pipeline handler added to clients created after AddDynamoDB.
        await using var f = await Fixture.StartAsync();
        var response = await f.App.PreviewAsync("POST", "/orders/early/early");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("early", (await f.ItemAsync("early"))!["status"].S);
    }

    [ServiceFact("dynamodb")]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: without AddDynamoDB the same write is sent and the Preview is "confirmed".
        await using var f = await Fixture.StartAsync(hooked: false);
        var response = await f.App.PreviewAsync("POST", "/orders/unhooked/touch");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(await f.ItemAsync("unhooked"));
    }

    [ServiceFact("dynamodb")]
    public async Task DiscoveryListsDynamoDbInGuardModeAndTheMarkedRouteNeverRuns()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync("seeded", "open", 3);
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("dynamodb", "orders", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
        Assert.Equal("Preview unavailable: this operation writes to DynamoDB", Assert.Single(capabilities.GetProperty("previewUnavailable").EnumerateArray()).GetProperty("reason").GetString());
        Expect.Unconfirmed(await f.App.PreviewAsync("DELETE", "/orders/seeded"), HttpStatusCode.Conflict);
        Assert.NotNull(await f.ItemAsync("seeded"));
        Assert.DoesNotContain(SecretKey, capabilities.GetRawText());
    }

    [ServiceFact("dynamodb")]
    public async Task ObservedSendWritesOnceAndTracesTheAction()
    {
        await using var f = await Fixture.StartAsync();
        var (response, trace) = await f.App.ObservedAsync("POST", "/orders/sent/touch");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(Expect.DbEntries(trace, "dynamodb", "UpdateItem"));
        Assert.Equal("1", (await f.ItemAsync("sent"))!["hits"].N);
    }

    [Fact]
    public void ThePartiqlSanitizerKeepsIdentifiersAndNeverALiteral()
    {
        Assert.Equal("INSERT INTO \"t\" VALUE {?: ?}", DataStoreGuard.SanitizePartiql("INSERT INTO \"t\" VALUE {'id': 'x''y'}"));
    }
}

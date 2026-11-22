using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using OpenSearch.Client;
using OpenSearch.Net;
using Sendproof.AspNetCore;
using Sendproof.Cassandra;
using Sendproof.DynamoDB;
using Sendproof.OpenSearch;
using Sendproof.MongoDB;
using Sendproof.Redis;
using StackExchange.Redis;

namespace DotnetConformance;

/// <summary>
/// The data stores of the conformance contract (spec/conformance/fixture.md "Data store routes"). Each store is hooked only
/// when the runner passes its variables, so the standard and alternate scenarios run without any store service. The routes
/// use the clients exactly as an application would: MongoDB through the registered <c>IMongoClient</c>, Redis through the
/// registered <c>IConnectionMultiplexer</c> and DynamoDB through the registered <c>IAmazonDynamoDB</c>.
/// </summary>
internal sealed record FixtureStores(string? MongoUrl, string? RedisUrl, string RedisPrefix, string? DynamoUrl, string? DynamoTable, string Region,
    string? CassandraContactPoint = null, string? CassandraKeyspace = null, string? OpenSearchUrl = null, string? OpenSearchIndex = null)
{
    private const string AdminRole = "admin";

    /// <summary>Reads the store variables the runner sets; a store without its variable is not hooked.</summary>
    internal static FixtureStores FromEnvironment()
    {
        static string? Variable(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : null;
        return new FixtureStores(Variable("BENCH_MONGODB_URL"), Variable("BENCH_REDIS_URL"), Variable("BENCH_REDIS_PREFIX") ?? "",
            Variable("BENCH_DYNAMODB_URL"), Variable("BENCH_DYNAMODB_TABLE"), Variable("AWS_REGION") ?? "us-east-1",
            Variable("BENCH_CASSANDRA_CONTACT_POINT"), Variable("BENCH_CASSANDRA_KEYSPACE"), Variable("BENCH_OPENSEARCH_URL"), Variable("BENCH_OPENSEARCH_INDEX"));
    }

    /// <summary>Whether a guarded store is hooked, which is what the mixed SQL-and-store route needs.</summary>
    internal bool HasGuardedStores => RedisUrl is not null || DynamoUrl is not null || CassandraContactPoint is not null || OpenSearchUrl is not null;

    /// <summary>Registers each configured client first, then hooks it, as the adapter's setup requires.</summary>
    internal void Register(IServiceCollection services, SendproofBuilder sendproof)
    {
        if (MongoUrl is not null)
        {
            services.AddSingleton<IMongoClient>(_ => new MongoClient(MongoUrl));
            sendproof.AddMongoDB(mongo => mongo.WithName("catalog"));
        }

        if (RedisUrl is not null)
        {
            var url = new Uri(RedisUrl);
            var options = new ConfigurationOptions { AbortOnConnectFail = false, ConnectTimeout = 5000, Password = Uri.UnescapeDataString(url.UserInfo.Split(':', 2).Last()) };
            options.EndPoints.Add(url.Host, url.Port);
            services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(options));
            sendproof.AddRedis(redis => redis.WithName("cache"));
        }

        if (DynamoUrl is not null)
        {
            // Registered after AddDynamoDB so the client is created with the guard in its pipeline. The credentials come
            // from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
            sendproof.AddDynamoDB(dynamo => dynamo.WithName("orders"));
            services.AddSingleton<IAmazonDynamoDB>(_ => new AmazonDynamoDBClient(new AmazonDynamoDBConfig { ServiceURL = DynamoUrl, AuthenticationRegion = Region }));
        }

        if (CassandraContactPoint is not null)
        {
            // The session is registered first and connects on first use, so the app starts without waiting for Cassandra.
            var (host, port) = (CassandraContactPoint.Split(':')[0], int.Parse(CassandraContactPoint.Split(':')[1], System.Globalization.CultureInfo.InvariantCulture));
            services.AddSingleton<global::Cassandra.ISession>(_ => global::Cassandra.Cluster.Builder().AddContactPoint(host).WithPort(port).Build().Connect(CassandraKeyspace));
            sendproof.AddCassandra(cassandra => cassandra.WithName("tickets"));
        }

        if (OpenSearchUrl is not null)
        {
            services.AddSingleton<IOpenSearchClient>(_ => new OpenSearchClient(new ConnectionSettings(new Uri(OpenSearchUrl))));
            sendproof.AddOpenSearch(search => search.WithName("articles"));
        }
    }

    /// <summary>Maps the routes of every hooked store.</summary>
    internal void Map(WebApplication app)
    {
        if (MongoUrl is not null) MapMongo(app, new MongoUrlBuilder(MongoUrl).DatabaseName ?? "test");
        if (RedisUrl is not null) MapRedis(app);
        if (DynamoUrl is not null) MapDynamo(app);
        if (CassandraContactPoint is not null) MapCassandra(app);
        if (OpenSearchUrl is not null) MapOpenSearch(app);
        if (HasGuardedStores) MapMixed(app);
    }

    private static object Shape(BsonDocument document) => new
    {
        id = document["_id"].AsString,
        name = document["name"].AsString,
        city = document.TryGetValue("profile", out var profile) && profile.AsBsonDocument.TryGetValue("city", out var city) ? city.AsString : null
    };

    private static bool Text(string? value) => !string.IsNullOrEmpty(value) && value.Length <= 150;

    // ---- MongoDB (preview mode) ----

    private static void MapMongo(WebApplication app, string database)
    {
        static IMongoCollection<BsonDocument> Documents(IMongoClient client, string database) =>
            client.GetDatabase(database).GetCollection<BsonDocument>("documents");

        app.MapGet("/documents/{id}", async (string id, IMongoClient client) =>
            await (await Documents(client, database).FindAsync(new BsonDocument("_id", id))).FirstOrDefaultAsync() is { } document
                ? Results.Ok(Shape(document))
                : Results.NotFound())
            .RequireAuthorization().WithSendproofPreview().WithSummary("Get a document");

        app.MapPost("/documents", async (CreateDocumentRequest body, IMongoClient client, ILogger<CreateDocumentRequest> logger) =>
        {
            if (!Text(body.Id) || !Text(body.Name) || !Text(body.City) || !Text(body.Password)) return Results.BadRequest();
            var document = new BsonDocument
            {
                { "_id", body.Id }, { "name", body.Name }, { "profile", new BsonDocument("city", body.City) },
                { "password_hash", "hashed:" + body.Password }
            };
            await Documents(client, database).InsertOneAsync(document);
            logger.LogInformation("created-document:{DocumentId}", body.Id);
            return Results.Created($"/documents/{Uri.EscapeDataString(body.Id!)}", Shape(document));
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Create a document");

        app.MapPatch("/documents/{id}", async (string id, UpdateDocumentRequest body, IMongoClient client) =>
        {
            var update = new List<UpdateDefinition<BsonDocument>>();
            if (body.Name is not null) update.Add(Builders<BsonDocument>.Update.Set("name", body.Name));
            if (body.City is not null) update.Add(Builders<BsonDocument>.Update.Set("profile.city", body.City));
            if (update.Count == 0 || !new[] { body.Name, body.City }.Where(value => value is not null).All(Text)) return Results.BadRequest();
            var documents = Documents(client, database);
            if ((await documents.UpdateOneAsync(new BsonDocument("_id", id), Builders<BsonDocument>.Update.Combine(update))).MatchedCount == 0)
                return Results.NotFound();
            return Results.Ok(Shape(await (await documents.FindAsync(new BsonDocument("_id", id))).FirstAsync()));
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Update a document");

        app.MapPost("/documents/archive", async (IMongoClient client) =>
        {
            // $out can't run inside a transaction: the adapter blocks it before it is sent.
            var pipeline = PipelineDefinition<BsonDocument, BsonDocument>.Create(
                new BsonDocument("$match", new BsonDocument()), new BsonDocument("$out", "documents_archive"));
            await (await Documents(client, database).AggregateAsync(pipeline)).ToListAsync();
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Archive the documents");

        app.MapDelete("/documents/{id}", async (string id, IMongoClient client) =>
        {
            await Documents(client, database).DeleteOneAsync(new BsonDocument("_id", id));
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to MongoDB", "mongodb")
            .WithSummary("Delete a document");
    }

    // ---- Redis (guard mode) ----

    private void MapRedis(WebApplication app)
    {
        var prefix = RedisPrefix;
        string Key(string name) => $"{prefix}counter:{name}";

        app.MapGet("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            var value = await redis.GetDatabase().StringGetAsync(Key(key));
            return value.IsNull ? Results.NotFound() : Results.Ok(new { key, value = (long)value });
        }).RequireAuthorization().WithSendproofPreview().WithSummary("Read a counter");

        app.MapPost("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
            Results.Ok(new { key, value = await redis.GetDatabase().StringIncrementAsync(Key(key)) }))
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Increment a counter");

        app.MapPost("/counters/{key}/take", async (string key, IConnectionMultiplexer redis) =>
        {
            // Store errors are swallowed on purpose: the blocked mark, not the response, decides a Preview.
            RedisValue value = RedisValue.Null;
            try { value = await redis.GetDatabase().StringGetDeleteAsync(Key(key)); } catch (Exception) { /* reported as not found */ }
            return value.IsNull ? Results.NotFound() : Results.Ok(new { key, value = (long)value });
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Take a counter");

        app.MapDelete("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            await redis.GetDatabase().KeyDeleteAsync(Key(key));
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to Redis", "redis")
            .WithSummary("Delete a counter");
    }

    // ---- DynamoDB (guard mode) ----

    private static object Order(Dictionary<string, AttributeValue> item) => new
    {
        id = item["id"].S,
        status = item.TryGetValue("status", out var status) ? status.S : null,
        hits = item.TryGetValue("hits", out var hits) ? int.Parse(hits.N) : 0
    };

    private static Task<UpdateItemResponse> Touch(IAmazonDynamoDB dynamo, string table, string id) => dynamo.UpdateItemAsync(new Amazon.DynamoDBv2.Model.UpdateItemRequest
    {
        TableName = table,
        Key = new() { ["id"] = new AttributeValue { S = id } },
        UpdateExpression = "ADD hits :one SET #s = if_not_exists(#s, :new)",
        ExpressionAttributeNames = new() { ["#s"] = "status" },
        ExpressionAttributeValues = new() { [":one"] = new AttributeValue { N = "1" }, [":new"] = new AttributeValue { S = "new" } },
        ReturnValues = ReturnValue.ALL_NEW
    });

    private void MapDynamo(WebApplication app)
    {
        var table = DynamoTable!;

        app.MapGet("/orders/{id}", async (string id, IAmazonDynamoDB dynamo) =>
        {
            var response = await dynamo.GetItemAsync(table, new() { ["id"] = new AttributeValue { S = id } }, consistentRead: true);
            return response.Item is { Count: > 0 } ? Results.Ok(Order(response.Item)) : Results.NotFound();
        }).RequireAuthorization().WithSendproofPreview().WithSummary("Read an order");

        app.MapPost("/orders/{id}/touch", async (string id, IAmazonDynamoDB dynamo) => Results.Ok(Order((await Touch(dynamo, table, id)).Attributes)))
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Touch an order");

        app.MapPost("/orders/{id}/cancel", async (string id, IAmazonDynamoDB dynamo) =>
        {
            await dynamo.ExecuteStatementAsync(new ExecuteStatementRequest
            {
                Statement = $"UPDATE \"{table}\" SET status = 'cancelled' WHERE id = ?",
                Parameters = [new AttributeValue { S = id }]
            });
            return Results.Ok(new { id, status = "cancelled" });
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Cancel an order");

        app.MapDelete("/orders/{id}", async (string id, IAmazonDynamoDB dynamo) =>
        {
            await dynamo.DeleteItemAsync(table, new() { ["id"] = new AttributeValue { S = id } });
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to DynamoDB", "dynamodb")
            .WithSummary("Delete an order");
    }

    // ---- Cassandra (guard mode) ----

    private static async Task<global::Cassandra.Row?> Ticket(global::Cassandra.ISession session, string id)
    {
        // The read is a prepared statement: the hook classifies the execution by the text it was prepared from.
        var prepared = await session.PrepareAsync("SELECT id, status, hits FROM tickets WHERE id = ?");
        return (await session.ExecuteAsync(prepared.Bind(id))).FirstOrDefault();
    }

    private static Task TouchTicket(global::Cassandra.ISession session, string id) =>
        session.ExecuteAsync(new global::Cassandra.SimpleStatement("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)", id));

    private static void MapCassandra(WebApplication app)
    {
        app.MapGet("/tickets/{id}", async (string id, global::Cassandra.ISession session) =>
            await Ticket(session, id) is { } row
                ? Results.Ok(new { id = row.GetValue<string>("id"), status = row.GetValue<string>("status"), hits = row.GetValue<int>("hits") })
                : Results.NotFound())
            .RequireAuthorization().WithSendproofPreview().WithSummary("Read a ticket");

        app.MapPost("/tickets/{id}/touch", async (string id, global::Cassandra.ISession session) =>
        {
            await TouchTicket(session, id);
            return Results.Ok(new { id, status = "new", hits = 1 });
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Touch a ticket");

        app.MapPost("/tickets/{id}/close", async (string id, global::Cassandra.ISession session) =>
        {
            // A logged batch holding a lightweight transaction: a write even though its condition could fail.
            var batch = new global::Cassandra.BatchStatement().Add(new global::Cassandra.SimpleStatement("UPDATE tickets SET status = 'closed' WHERE id = ? IF EXISTS", id));
            await session.ExecuteAsync(batch);
            return Results.Ok(new { id, status = "closed" });
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Close a ticket");

        app.MapDelete("/tickets/{id}", async (string id, global::Cassandra.ISession session) =>
        {
            await session.ExecuteAsync(new global::Cassandra.SimpleStatement("DELETE FROM tickets WHERE id = ?", id));
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to Cassandra", "cassandra")
            .WithSummary("Delete a ticket");
    }

    // ---- OpenSearch (guard mode) ----

    private static string Json(object value) => System.Text.Json.JsonSerializer.Serialize(value);

    private static async Task<object?> TouchArticle(IOpenSearchClient search, string index, string id)
    {
        var reply = await search.LowLevel.UpdateAsync<StringResponse>(index, id, PostData.String(Json(new Dictionary<string, object>
        {
            ["script"] = new { source = "ctx._source.views += params.step", lang = "painless", @params = new { step = 1 } },
            ["upsert"] = new { title = "Untitled", views = 1 },
            ["_source"] = true
        })), new UpdateRequestParameters { Refresh = Refresh.True });
        using var document = System.Text.Json.JsonDocument.Parse(reply.Body);
        var source = document.RootElement.GetProperty("get").GetProperty("_source");
        return new { id, title = source.GetProperty("title").GetString(), views = source.GetProperty("views").GetInt32() };
    }

    private void MapOpenSearch(WebApplication app)
    {
        var index = OpenSearchIndex!;

        app.MapGet("/articles/{id}", async (string id, IOpenSearchClient search) =>
        {
            // A read sent as a POST to _search: the method alone must not decide.
            var reply = await search.LowLevel.SearchAsync<StringResponse>(index, PostData.String(Json(new { query = new { ids = new { values = new[] { id } } }, size = 1 })));
            using var document = System.Text.Json.JsonDocument.Parse(reply.Body);
            var hits = document.RootElement.GetProperty("hits").GetProperty("hits");
            if (hits.GetArrayLength() == 0) return Results.NotFound();
            var source = hits[0].GetProperty("_source");
            return Results.Ok(new { id, title = source.GetProperty("title").GetString(), views = source.GetProperty("views").GetInt32() });
        }).RequireAuthorization().WithSendproofPreview().WithSummary("Read an article");

        app.MapPost("/articles/{id}/touch", async (string id, IOpenSearchClient search) => Results.Ok(await TouchArticle(search, index, id)))
            .RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Touch an article");

        app.MapPost("/articles/{id}/hide", async (string id, IOpenSearchClient search) =>
        {
            // _update_by_query is a POST with a query, like a search. Store errors are swallowed on purpose: the blocked mark decides.
            try
            {
                var reply = await search.LowLevel.UpdateByQueryAsync<StringResponse>(index, PostData.String(Json(new
                {
                    query = new { ids = new { values = new[] { id } } },
                    script = new { source = "ctx._source.hidden = true", lang = "painless" }
                })), new UpdateByQueryRequestParameters { Refresh = Refresh.True });
                using var document = System.Text.Json.JsonDocument.Parse(reply.Body);
                return document.RootElement.GetProperty("updated").GetInt32() > 0 ? Results.Ok(new { id, hidden = true }) : Results.NotFound();
            }
            catch (Exception)
            {
                return Results.NotFound();
            }
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Hide an article");

        app.MapDelete("/articles/{id}", async (string id, IOpenSearchClient search) =>
        {
            await search.LowLevel.DeleteAsync<StringResponse>(index, id, new DeleteRequestParameters { Refresh = Refresh.True });
            return Results.NoContent();
        }).RequireAuthorization(policy => policy.RequireRole(AdminRole))
            .WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to OpenSearch", "opensearch")
            .WithSummary("Delete an article");
    }

    // ---- SQL and a guarded store ----

    private void MapMixed(WebApplication app) => app.MapPost("/items/{id}/remember", async (string id, [FromQuery] string? store, RememberRequest body,
        FixtureDbContext db, IServiceProvider services) =>
    {
        if (!Text(body.Name) || store is not ("redis" or "dynamodb" or "cassandra" or "opensearch")) return Results.BadRequest();
        db.Items.Add(new Item { Id = id, Name = body.Name! });
        await db.SaveChangesAsync();
        if (store == "redis")
            await services.GetRequiredService<IConnectionMultiplexer>().GetDatabase().StringIncrementAsync($"{RedisPrefix}counter:item-{id}");
        else if (store == "cassandra")
            await TouchTicket(services.GetRequiredService<global::Cassandra.ISession>(), "item-" + id);
        else if (store == "opensearch")
            await TouchArticle(services.GetRequiredService<IOpenSearchClient>(), OpenSearchIndex!, "item-" + id);
        else
            await Touch(services.GetRequiredService<IAmazonDynamoDB>(), DynamoTable!, "item-" + id);
        return Results.Created($"/items/{Uri.EscapeDataString(id)}", new ItemResponse(id, body.Name!));
    }).RequireAuthorization(policy => policy.RequireRole(AdminRole)).WithSendproofPreview().WithSummary("Insert an item, then write a guarded store");
}

/// <summary>Body of <c>POST /documents</c>.</summary>
public sealed record CreateDocumentRequest(string? Id, string? Name, string? City, string? Password);

/// <summary>Body of <c>PATCH /documents/{id}</c>.</summary>
public sealed record UpdateDocumentRequest(string? Name, string? City);

/// <summary>Body of <c>POST /items/{id}/remember</c>.</summary>
public sealed record RememberRequest(string? Name);

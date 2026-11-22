using System.Globalization;
using System.Text.Json;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Runtime;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using Sendproof.AspNetCore;
using Sendproof.DynamoDB;
using Sendproof.MongoDB;
using Sendproof.Redis;
using StackExchange.Redis;

namespace StoreApi;

/// <summary>
/// The optional data stores of the demo, each configured with a URL (<c>DemoRedisUrl</c>, <c>DemoMongoUrl</c>,
/// <c>DemoDynamoUrl</c>, or the environment variable of the same name) and simply absent when its URL is not set, so
/// the demo runs on SQLite alone. When present, each client is registered in the container and hooked by Sendproof.
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item><description><b>Redis</b> (<c>cache</c>, mode <c>guard</c>): price quotes <c>quote:{id}</c> for 15 minutes and the
/// hourly order counters <c>ratelimit:orders:{email}</c>. A Preview may read them; it cannot write them.</description></item>
/// <item><description><b>MongoDB</b> (<c>store</c>, mode <c>preview</c>): <c>order_events</c>, <c>order_timelines</c> and
/// <c>product_reviews</c>. Writes run in a transaction that a Preview aborts.</description></item>
/// <item><description><b>DynamoDB</b> (<c>idempotency</c>, mode <c>guard</c>): the <c>idempotency</c> table of order keys. A
/// Preview may read it; the write that remembers a key happens only on Send.</description></item>
/// </list>
/// </remarks>
public sealed class DemoStores
{
    /// <summary>The MongoDB database used when the URL names none.</summary>
    internal const string DefaultMongoDatabase = "store";

    /// <summary>How long a cached price quote lives.</summary>
    internal static readonly TimeSpan QuoteLifetime = TimeSpan.FromMinutes(15);

    /// <summary>How many orders a customer may place in a rolling hour.</summary>
    internal const int OrdersPerHour = 10;

    /// <summary>The DynamoDB table of remembered idempotency keys.</summary>
    internal const string IdempotencyTable = "idempotency";

    private readonly IConnectionMultiplexer? _redis;
    private readonly IMongoDatabase? _mongo;
    private readonly IAmazonDynamoDB? _dynamo;

    /// <summary>Creates the hooks over whichever clients the container holds.</summary>
    public DemoStores(IServiceProvider services)
    {
        _redis = services.GetService<IConnectionMultiplexer>();
        _mongo = services.GetService<IMongoClient>()?.GetDatabase(services.GetRequiredService<DemoStoreSettings>().MongoDatabase);
        _dynamo = services.GetService<IAmazonDynamoDB>();
    }

    /// <summary>Whether quotes and order counters live in Redis (so quoting cannot be previewed).</summary>
    internal bool HasRedis => _redis is not null;

    /// <summary>Whether order history and reviews live in MongoDB.</summary>
    internal bool HasMongo => _mongo is not null;

    /// <summary>Whether idempotency keys are remembered in DynamoDB.</summary>
    internal bool HasDynamo => _dynamo is not null;

    // ---- Redis ----

    /// <summary>Caches a quote for its 15 minutes of validity. A cache that is down never stops a quote.</summary>
    internal async Task CacheQuoteAsync(PriceQuote quote)
    {
        if (_redis is null) return;
        try
        {
            await _redis.GetDatabase().StringSetAsync($"quote:{quote.Id}", JsonSerializer.Serialize(quote), QuoteLifetime);
        }
        catch (RedisException)
        {
        }
    }

    /// <summary>Reads a cached quote, or <c>null</c> when Redis is not configured, is down, or the quote expired.</summary>
    internal async Task<PriceQuote?> ReadQuoteAsync(string id)
    {
        if (_redis is null) return null;
        try
        {
            var json = await _redis.GetDatabase().StringGetAsync($"quote:{id}");
            return json.HasValue ? JsonSerializer.Deserialize<PriceQuote>(json.ToString()) : null;
        }
        catch (Exception exception) when (exception is RedisException or JsonException)
        {
            return null;
        }
    }

    /// <summary>The orders a customer placed in the current hour, or 0 when Redis is not configured.</summary>
    internal async Task<long> OrdersThisHourAsync(string email)
    {
        if (_redis is null) return 0;
        try
        {
            var value = await _redis.GetDatabase().StringGetAsync($"ratelimit:orders:{email}");
            return value.HasValue && long.TryParse(value.ToString(), out var count) ? count : 0;
        }
        catch (RedisException)
        {
            return 0;
        }
    }

    /// <summary>Counts an order against the customer's hour. Writes to Redis, so it runs on Send only.</summary>
    internal async Task CountOrderAsync(string email)
    {
        if (_redis is null) return;
        try
        {
            var database = _redis.GetDatabase();
            var key = $"ratelimit:orders:{email}";
            if (await database.StringIncrementAsync(key) == 1) await database.KeyExpireAsync(key, TimeSpan.FromHours(1));
        }
        catch (RedisException)
        {
        }
    }

    /// <summary>
    /// Adds redemptions to a coupon's counter with <c>INCRBY coupon:redemptions:{code}</c> and returns the new total, or
    /// <c>null</c> when Redis is not configured or is down. This is a Redis write, so a Preview is stopped before it is sent.
    /// </summary>
    internal async Task<long?> CountRedemptionsAsync(string code, int count)
    {
        if (_redis is null) return null;
        try
        {
            return await _redis.GetDatabase().StringIncrementAsync($"coupon:redemptions:{code}", count);
        }
        catch (RedisException)
        {
            return null;
        }
    }

    // ---- DynamoDB ----

    /// <summary>The request hash remembered for an idempotency key, or <c>null</c> when DynamoDB has none (or is not configured).</summary>
    internal async Task<string?> ReadIdempotencyAsync(string key)
    {
        if (_dynamo is null) return null;
        try
        {
            var response = await _dynamo.GetItemAsync(new GetItemRequest
            {
                TableName = IdempotencyTable, Key = new() { ["pk"] = new AttributeValue($"order#{key}") }, ConsistentRead = true
            });
            return response.Item is { Count: > 0 } item && item.TryGetValue("requestHash", out var hash) ? hash.S : null;
        }
        catch (Exception exception) when (exception is AmazonServiceException or AmazonClientException or HttpRequestException)
        {
            return null;
        }
    }

    /// <summary>Remembers an idempotency key for a day. Writes to DynamoDB, so it runs on Send only.</summary>
    internal async Task RememberIdempotencyAsync(string key, string requestHash, Guid orderId)
    {
        if (_dynamo is null) return;
        try
        {
            await _dynamo.PutItemAsync(new PutItemRequest
            {
                TableName = IdempotencyTable,
                Item = new()
                {
                    ["pk"] = new AttributeValue($"order#{key}"), ["requestHash"] = new AttributeValue(requestHash),
                    ["orderId"] = new AttributeValue(orderId.ToString()),
                    ["createdAt"] = new AttributeValue(DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture)),
                    ["ttl"] = new AttributeValue { N = DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture) }
                }
            });
        }
        catch (Exception exception) when (exception is AmazonServiceException or AmazonClientException or HttpRequestException)
        {
        }
    }

    // ---- MongoDB ----

    /// <summary>One order history document, oldest event first, or <c>null</c> when MongoDB is not configured or has none.</summary>
    internal async Task<BsonDocument?> TimelineAsync(Guid orderId) =>
        _mongo is null ? null : await _mongo.GetCollection<BsonDocument>("order_timelines")
            .Find(new BsonDocument("_id", orderId.ToString())).FirstOrDefaultAsync();

    /// <summary>
    /// Records events on an order: one <c>order_events</c> document per event, and the order's <c>order_timelines</c>
    /// document (created by the first event) with the events appended.
    /// </summary>
    internal async Task RecordOrderEventsAsync(Guid orderId, string number, string status, ActorReference actor,
        IReadOnlyList<(string Type, DateTimeOffset At, string Summary)> events)
    {
        if (_mongo is null || events.Count == 0) return;
        var who = new BsonDocument { { "email", actor.Email }, { "name", actor.Name } };
        var documents = events.Select(e => new BsonDocument
        {
            { "type", e.Type }, { "at", e.At.UtcDateTime }, { "actor", who }, { "status", status }, { "summary", e.Summary }
        }).ToList();
        await _mongo.GetCollection<BsonDocument>("order_events").InsertManyAsync(documents.Select(d => new BsonDocument(d)
        {
            { "_id", ObjectId.GenerateNewId() }, { "orderId", orderId.ToString() }, { "number", number }
        }));
        await _mongo.GetCollection<BsonDocument>("order_timelines").UpdateOneAsync(
            new BsonDocument("_id", orderId.ToString()),
            Builders<BsonDocument>.Update.Set("number", number).Set("updatedAt", events[^1].At.UtcDateTime).PushEach("events", documents),
            new UpdateOptions { IsUpsert = true });
    }

    /// <summary>A product's reviews document, or <c>null</c> when MongoDB is not configured or the product has none.</summary>
    internal async Task<BsonDocument?> ReviewsAsync(Guid productId) =>
        _mongo is null ? null : await _mongo.GetCollection<BsonDocument>("product_reviews")
            .Find(new BsonDocument("_id", productId.ToString())).FirstOrDefaultAsync();

    /// <summary>
    /// Appends a review to a product's document (created on the first review) and refreshes its average, count and
    /// star distribution. Returns the new average and count so SQL can keep them on the product.
    /// </summary>
    internal async Task<(double Average, int Count)> AddReviewAsync(Guid productId, BsonDocument review)
    {
        var collection = _mongo!.GetCollection<BsonDocument>("product_reviews");
        var existing = await collection.Find(new BsonDocument("_id", productId.ToString())).FirstOrDefaultAsync();
        var ratings = existing?["reviews"].AsBsonArray.Select(r => r["rating"].ToInt32()).ToList() ?? [];
        ratings.Add(review["rating"].ToInt32());
        var average = Math.Round(ratings.Average(), 1);
        var distribution = new BsonArray(Enumerable.Range(1, 5).Reverse().Select(stars => new BsonDocument
        {
            { "stars", stars }, { "count", ratings.Count(r => r == stars) }
        }));
        await collection.UpdateOneAsync(new BsonDocument("_id", productId.ToString()),
            Builders<BsonDocument>.Update.Set("average", average).Set("count", ratings.Count).Set("distribution", distribution)
                .PushEach("reviews", [review], position: 0),
            new UpdateOptions { IsUpsert = true });
        return (average, ratings.Count);
    }

    /// <summary>Counts a helpful vote on a review. Returns <c>false</c> when the review does not exist.</summary>
    internal async Task<bool> VoteReviewAsync(Guid productId, string reviewId)
    {
        var result = await _mongo!.GetCollection<BsonDocument>("product_reviews").UpdateOneAsync(
            new BsonDocument { { "_id", productId.ToString() }, { "reviews._id", reviewId } },
            Builders<BsonDocument>.Update.Inc("reviews.$.helpfulVotes", 1));
        return result.MatchedCount > 0;
    }

    // ---- Seeding and registration ----

    /// <summary>
    /// Fills the stores a new demo shows on its first day: order counters and sample quotes in Redis, an event history
    /// for every seeded order and the reviews of every seeded product in MongoDB, and a few remembered keys in DynamoDB.
    /// Runs once, while no request is open, and never stops the application from starting when a store is down.
    /// </summary>
    internal async Task SeedAsync(StoreDbContext db, ILogger logger)
    {
        using var _ = DetachedWork.Begin();
        try
        {
            if (_redis is not null) await SeedRedisAsync(db);
            if (_dynamo is not null) await SeedDynamoAsync(db);
            if (_mongo is not null) await SeedMongoAsync(db);
        }
        catch (Exception exception) when (exception is RedisException or MongoException or AmazonServiceException
            or AmazonClientException or TimeoutException or HttpRequestException)
        {
            logger.LogWarning("The demo data stores could not be filled: {Message}", exception.Message);
        }
    }

    private async Task SeedRedisAsync(StoreDbContext db)
    {
        var redis = _redis!.GetDatabase();
        foreach (var coupon in await db.Coupons.AsNoTracking().ToListAsync())
            if (!await redis.KeyExistsAsync($"coupon:redemptions:{coupon.Code}"))
                await redis.StringSetAsync($"coupon:redemptions:{coupon.Code}", coupon.Redeemed);
        var customers = await db.Customers.AsNoTracking().OrderBy(c => c.Email).ToListAsync();
        foreach (var customer in customers)
        {
            // A few recent orders each; the reseller is at the limit, so ordering as them answers 429.
            var count = customer.Email.StartsWith("liam.reseller", StringComparison.Ordinal) ? OrdersPerHour : customer.Email.Length % 3;
            if (!await redis.KeyExistsAsync($"ratelimit:orders:{customer.Email}"))
                await redis.StringSetAsync($"ratelimit:orders:{customer.Email}", count, TimeSpan.FromHours(1));
        }
    }

    private async Task SeedDynamoAsync(StoreDbContext db)
    {
        var tables = await _dynamo!.ListTablesAsync();
        if (!tables.TableNames.Contains(IdempotencyTable))
        {
            await _dynamo.CreateTableAsync(new CreateTableRequest
            {
                TableName = IdempotencyTable, BillingMode = BillingMode.PAY_PER_REQUEST,
                KeySchema = [new KeySchemaElement("pk", KeyType.HASH)],
                AttributeDefinitions = [new AttributeDefinition("pk", ScalarAttributeType.S)]
            });
        }
        foreach (var order in await db.Orders.AsNoTracking().Where(o => o.IdempotencyKey != null).OrderByDescending(o => o.PlacedAt).Take(12).ToListAsync())
            await RememberIdempotencyAsync(order.IdempotencyKey!, order.RequestHash ?? "", order.Id);
    }

    private async Task SeedMongoAsync(StoreDbContext db)
    {
        var timelines = _mongo!.GetCollection<BsonDocument>("order_timelines");
        if (await timelines.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty) == 0)
        {
            var customers = await db.Customers.AsNoTracking().ToDictionaryAsync(c => c.Id);
            var orders = await db.Orders.AsNoTracking().OrderBy(o => o.PlacedAt).ToListAsync();
            var shipments = (await db.Shipments.AsNoTracking().ToListAsync()).ToLookup(s => s.OrderId);
            foreach (var order in orders)
            {
                var customer = customers[order.CustomerId];
                var actor = new ActorReference { Email = customer.Email, Name = $"{customer.FirstName} {customer.LastName}" };
                var events = new List<(string, DateTimeOffset, string)>
                {
                    ("Order.Placed", order.PlacedAt, $"Order {order.Number} placed for {order.Total.ToString("N2", CultureInfo.InvariantCulture)} {order.Currency}."),
                    ("Payment.Authorized", order.PlacedAt.AddSeconds(4), "The payment provider authorised the payment.")
                };
                if (order.Status is not OrderStatus.Pending and not OrderStatus.Cancelled)
                    events.Add(("Payment.Captured", order.PlacedAt.AddMinutes(2), "The payment was captured."));
                foreach (var shipment in shipments[order.Id])
                    events.Add(("Shipment.Created", shipment.ShippedAt, $"Shipped with {shipment.Carrier}, tracking {shipment.TrackingNumber}."));
                if (order.Status == OrderStatus.Delivered)
                    events.Add(("Order.Delivered", shipments[order.Id].Max(s => s.DeliveredAt) ?? order.UpdatedAt, "Delivered to the customer."));
                if (order.Status == OrderStatus.Cancelled)
                    events.Add(("Order.Cancelled", order.UpdatedAt, $"Cancelled: {order.CancelReason ?? "no reason given"}."));
                await RecordOrderEventsAsync(order.Id, order.Number, order.Status.ToString(), actor, events);
            }
        }

        var reviews = _mongo.GetCollection<BsonDocument>("product_reviews");
        if (await reviews.CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty) == 0)
            foreach (var document in ReviewSeed.Create(await db.Products.AsNoTracking().OrderBy(p => p.Slug).ToListAsync()))
                await reviews.InsertOneAsync(document);
    }

    /// <summary>
    /// Registers the clients for the stores whose URLs are configured and hooks them into Sendproof. Registers
    /// <see cref="DemoStores"/> in every case, so handlers never depend on whether a store is present.
    /// </summary>
    internal static void Add(IServiceCollection services, SendproofBuilder sendproof, IConfiguration configuration)
    {
        var redisUrl = configuration["DemoRedisUrl"];
        var mongoUrl = configuration["DemoMongoUrl"];
        var dynamoUrl = configuration["DemoDynamoUrl"];
        if (!string.IsNullOrWhiteSpace(redisUrl))
        {
            var uri = new Uri(redisUrl);
            var options = new ConfigurationOptions { AbortOnConnectFail = false, ConnectTimeout = 3000, SyncTimeout = 3000, AsyncTimeout = 3000 };
            options.EndPoints.Add(uri.Host, uri.IsDefaultPort ? 6379 : uri.Port);
            var password = Uri.UnescapeDataString(uri.UserInfo.Split(':', 2).Last());
            if (password.Length > 0) options.Password = password;
            services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(options));
            sendproof.AddRedis(redis => redis.WithName("cache"));
        }

        var database = DefaultMongoDatabase;
        if (!string.IsNullOrWhiteSpace(mongoUrl))
        {
            var url = new MongoUrl(mongoUrl);
            database = url.DatabaseName ?? DefaultMongoDatabase;
            var settings = MongoClientSettings.FromUrl(url);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            services.AddSingleton<IMongoClient>(_ => new MongoClient(settings));
            sendproof.AddMongoDB(mongo => mongo.WithName("store"));
        }

        if (!string.IsNullOrWhiteSpace(dynamoUrl))
        {
            // DynamoDB Local accepts any well-formed credentials. The client is created lazily, after AddDynamoDB has
            // hooked the SDK, so the Preview guard is on its pipeline.
            sendproof.AddDynamoDB(dynamo => dynamo.WithName("idempotency"));
            services.AddSingleton<IAmazonDynamoDB>(_ => new AmazonDynamoDBClient(new BasicAWSCredentials("local", "local"),
                new AmazonDynamoDBConfig { ServiceURL = dynamoUrl, AuthenticationRegion = "eu-west-1", MaxErrorRetry = 1, Timeout = TimeSpan.FromSeconds(3) }));
        }

        services.AddSingleton(new DemoStoreSettings(database));
        services.AddSingleton<DemoStores>();
    }
}

/// <summary>The MongoDB database name the demo writes to.</summary>
/// <param name="MongoDatabase">The database.</param>
internal sealed record DemoStoreSettings(string MongoDatabase);

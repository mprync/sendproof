using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using Sendproof.AspNetCore;
using Sendproof.MongoDB;
using Sendproof.Redis;
using StackExchange.Redis;

namespace TreasuryApi;

/// <summary>
/// The optional data stores of the demo: Redis for cached FX quotes and approval limits, MongoDB for the approvals
/// audit trail. Each is configured with a URL (<c>DemoRedisUrl</c>, <c>DemoMongoUrl</c>, or the environment variable of
/// the same name) and is simply absent when its URL is not set, so the demo runs on SQLite alone. When present, each
/// client is registered in the container and hooked by Sendproof, so a Preview blocks Redis writes and runs MongoDB
/// writes in a transaction it aborts.
/// </summary>
public sealed class DemoStores
{
    /// <summary>The MongoDB database used when the URL names none.</summary>
    internal const string DefaultMongoDatabase = "treasury";

    /// <summary>How long a cached FX quote lives; the same 30 seconds the quote is valid for.</summary>
    internal static readonly TimeSpan QuoteLifetime = TimeSpan.FromSeconds(30);

    private readonly IConnectionMultiplexer? _redis;
    private readonly IMongoDatabase? _mongo;

    /// <summary>Creates the hooks over whichever clients the container holds.</summary>
    public DemoStores(IServiceProvider services)
    {
        _redis = services.GetService<IConnectionMultiplexer>();
        _mongo = services.GetService<IMongoClient>()?.GetDatabase(services.GetRequiredService<DemoStoreSettings>().MongoDatabase);
    }

    /// <summary>Whether FX quotes are cached in Redis (and therefore cannot be previewed).</summary>
    internal bool HasRedis => _redis is not null;

    /// <summary>Whether approval decisions are recorded in MongoDB.</summary>
    internal bool HasMongo => _mongo is not null;

    /// <summary>The audit events of one payment, oldest first, or <c>null</c> when MongoDB is not configured.</summary>
    internal async Task<BsonDocument?> SnapshotAsync(Guid paymentId) =>
        _mongo is null ? null : await _mongo.GetCollection<BsonDocument>("approval_snapshots")
            .Find(new BsonDocument("_id", paymentId.ToString())).FirstOrDefaultAsync();

    /// <summary>Caches a quote for its 30 seconds of validity, keyed by the deal it prices.</summary>
    internal async Task CacheQuoteAsync(FxQuote quote)
    {
        if (_redis is null) return;
        var key = $"fx:quote:{quote.Pair}:{quote.Side}:{quote.Type}:{quote.ValueDate:yyyy-MM-dd}";
        try
        {
            await _redis.GetDatabase().StringSetAsync(key, JsonSerializer.Serialize(quote), QuoteLifetime);
        }
        catch (RedisException)
        {
            // A cache that is down never stops a quote.
        }
    }

    /// <summary>
    /// Records an approval decision: an <c>audit_events</c> document, and the payment's <c>approval_snapshots</c> document
    /// (created on the first decision) with the decision appended. Reads the reviewer's approval limit from Redis when
    /// it is configured, so the trail says whether the amount was within it.
    /// </summary>
    internal async Task RecordDecisionAsync(PaymentRecord payment, PaymentApprovalRecord approval)
    {
        if (_mongo is null) return;
        var limit = await ReadLimitAsync(approval.ActorEmail, payment);
        var amount = new BsonDocument { { "value", payment.Amount.ToString(CultureInfo.InvariantCulture) }, { "currency", payment.Currency.ToString() } };
        var actor = new BsonDocument { { "email", approval.ActorEmail }, { "name", approval.ActorName } };
        var decision = new BsonDocument
        {
            { "decision", approval.Decision.ToString() }, { "actor", actor }, { "at", approval.DecidedAt.UtcDateTime },
            { "comment", approval.Comment is null ? BsonNull.Value : approval.Comment },
        };
        if (limit is { } within) decision["withinLimit"] = within;
        var paymentInfo = new BsonDocument
        {
            { "id", payment.Id.ToString() }, { "number", payment.Number }, { "amount", amount }, { "status", payment.Status.ToString() },
        };
        await _mongo.GetCollection<BsonDocument>("audit_events").InsertOneAsync(new BsonDocument
        {
            { "_id", approval.Id.ToString() }, { "type", $"Payment.{approval.Decision}" }, { "at", approval.DecidedAt.UtcDateTime },
            { "actor", actor }, { "payment", paymentInfo },
        });
        await _mongo.GetCollection<BsonDocument>("approval_snapshots").UpdateOneAsync(
            new BsonDocument("_id", payment.Id.ToString()),
            Builders<BsonDocument>.Update.Set("payment", paymentInfo).Set("updatedAt", approval.DecidedAt.UtcDateTime).Push("decisions", decision),
            new UpdateOptions { IsUpsert = true });
    }

    /// <summary>
    /// Whether the reviewer's per-payment limit in Redis covers the payment, or <c>null</c> when Redis is not
    /// configured, has no limit for them, or the limit is in another currency. The limits are a Redis hash,
    /// <c>limits:approvals:{email}</c>, with the fields <c>perPayment</c> and <c>currency</c>.
    /// </summary>
    private async Task<bool?> ReadLimitAsync(string email, PaymentRecord payment)
    {
        if (_redis is null) return null;
        try
        {
            var values = await _redis.GetDatabase().HashGetAsync($"limits:approvals:{email}", ["perPayment", "currency"]);
            if (!values[0].HasValue || values[1] != payment.Currency.ToString()) return null;
            return decimal.TryParse(values[0].ToString(), CultureInfo.InvariantCulture, out var limit) ? payment.Amount <= limit : null;
        }
        catch (RedisException)
        {
            return null;
        }
    }

    /// <summary>
    /// Fills the stores a new demo shows on its first day: an approval limit per approver in Redis, and an audit trail in
    /// MongoDB for every seeded payment that has a decision. Runs once, while no request is open, and never stops the
    /// application from starting when a store is down.
    /// </summary>
    internal async Task SeedAsync(TreasuryDbContext db, ILogger logger)
    {
        using var _ = DetachedWork.Begin();
        try
        {
            if (_redis is not null)
            {
                var redis = _redis.GetDatabase();
                foreach (var (email, limit) in new[] { ("ben.approver@acme.dev", 1_000_000), ("devi.approver@acme.dev", 1_000_000), ("ada.admin@acme.dev", 5_000_000) })
                    await redis.HashSetAsync($"limits:approvals:{email}", [new HashEntry("perPayment", limit), new HashEntry("currency", "EUR")]);
            }

            if (_mongo is not null && await _mongo.GetCollection<BsonDocument>("approval_snapshots").CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty) == 0)
            {
                var payments = (await db.Payments.ToListAsync()).ToDictionary(p => p.Id);
                var approvals = (await db.PaymentApprovals.ToListAsync())
                    .Where(a => payments.ContainsKey(a.PaymentId)).OrderBy(a => a.DecidedAt).ToList();
                foreach (var approval in approvals)
                    await RecordDecisionAsync(payments[approval.PaymentId], approval);
            }
        }
        catch (Exception exception) when (exception is RedisException or MongoException or TimeoutException)
        {
            logger.LogWarning("The demo data stores could not be filled: {Message}", exception.Message);
        }
    }

    /// <summary>
    /// Registers the clients for the stores whose URLs are configured and hooks them into Sendproof. Registers
    /// <see cref="DemoStores"/> in every case, so handlers never depend on whether a store is present.
    /// </summary>
    internal static void Add(IServiceCollection services, SendproofBuilder sendproof, IConfiguration configuration)
    {
        var redisUrl = configuration["DemoRedisUrl"];
        var mongoUrl = configuration["DemoMongoUrl"];
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
            sendproof.AddMongoDB(mongo => mongo.WithName("treasury"));
        }

        services.AddSingleton(new DemoStoreSettings(database));
        services.AddSingleton<DemoStores>();
    }
}

/// <summary>The MongoDB database name the demo writes to.</summary>
/// <param name="MongoDatabase">The database.</param>
internal sealed record DemoStoreSettings(string MongoDatabase);

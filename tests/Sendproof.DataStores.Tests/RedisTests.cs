using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.Redis;
using StackExchange.Redis;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The Redis write guard against a real Redis (compose service): reads, writes, <c>GETDEL</c>, batches, transactions,
/// <c>Execute</c> and scripts are refused before any byte is sent, read back through an unhooked connection.
/// </summary>
public sealed class RedisTests
{
    private static ConfigurationOptions Options => new()
    {
        EndPoints = { { Services.RedisHost, Services.RedisPort } },
        Password = Services.RedisPassword,
        AbortOnConnectFail = false,
        ConnectTimeout = 3000,
        ConnectRetry = 1
    };

    /// <summary>A host with a guarded multiplexer, a raw (unhooked) one for reading back, and a fresh key prefix.</summary>
    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required IConnectionMultiplexer Raw { get; init; }
        internal required string Prefix { get; init; }
        internal IDatabase Db => Raw.GetDatabase();

        internal static async Task<Fixture> StartAsync(bool hooked = true, Action<RedisStoreBuilder>? configure = null)
        {
            var raw = await ConnectionMultiplexer.ConnectAsync(Options);
            var prefix = Services.Fresh("tb") + ":";
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(Options));
                if (hooked)
                {
                    bench.AddRedis(redis =>
                    {
                        redis.WithName("cache");
                        configure?.Invoke(redis);
                    });
                }
                else
                {
                    // The hook removed: the store is listed but the multiplexer is never wrapped.
                    bench.AddRedis(redis => redis.WithoutDecoratingTheRegisteredMultiplexer());
                }
            }, app => Map(app, prefix));
            return new Fixture { App = app, Raw = raw, Prefix = prefix };
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var key in Raw.GetServer(Raw.GetEndPoints()[0]).Keys(pattern: Prefix + "*"))
            {
                await Raw.GetDatabase().KeyDeleteAsync(key);
            }

            await App.DisposeAsync();
            await Raw.DisposeAsync();
        }
    }

    private static void Map(WebApplication app, string prefix)
    {
        string Key(string name) => prefix + "counter:" + name;

        app.MapGet("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            var value = await redis.GetDatabase().StringGetAsync(Key(key));
            return value.IsNull ? Results.NotFound() : Results.Ok(new { key, value = (long)value });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
            Results.Ok(new { key, value = await redis.GetDatabase().StringIncrementAsync(Key(key)) })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/counters/{key}/take", async (string key, IConnectionMultiplexer redis) =>
        {
            // Store errors are swallowed on purpose: the blocked mark, not the response, decides a Preview.
            RedisValue value = RedisValue.Null;
            try { value = await redis.GetDatabase().StringGetDeleteAsync(Key(key)); } catch (PreviewWriteBlockedException) { }
            return value.IsNull ? Results.NotFound() : Results.Ok(new { key, value = (long)value });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapDelete("/counters/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            await redis.GetDatabase().KeyDeleteAsync(Key(key));
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to Redis", "redis");

        app.MapPost("/pipeline/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            var batch = redis.GetDatabase().CreateBatch();
            var read = batch.StringGetAsync(Key(key));
            try { _ = batch.StringSetAsync(Key(key + "-written"), "x"); } catch (PreviewWriteBlockedException) { }
            batch.Execute();
            await read;
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/multi/{key}", async (string key, IConnectionMultiplexer redis) =>
        {
            var transaction = redis.GetDatabase().CreateTransaction();
            _ = transaction.StringGetAsync(Key(key));
            try { _ = transaction.StringIncrementAsync(Key(key + "-incr")); } catch (PreviewWriteBlockedException) { }
            await transaction.ExecuteAsync();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/execute/{command}", async (string command, string? key, IConnectionMultiplexer redis) =>
        {
            var result = await redis.GetDatabase().ExecuteAsync(command, key is null ? [] : [Key(key)]);
            return Results.Ok(new { result = result.ToString() });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/execute-incrby/{key}", async (string key, IConnectionMultiplexer redis) =>
            Results.Ok(new { result = (await redis.GetDatabase().ExecuteAsync("INCRBY", [Key(key), 3])).ToString() })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/execute-encoding/{key}", async (string key, IConnectionMultiplexer redis) =>
            Results.Ok(new { result = (await redis.GetDatabase().ExecuteAsync("OBJECT", ["ENCODING", Key(key)])).ToString() })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/script", async (string readOnly, IConnectionMultiplexer redis) =>
        {
            var db = redis.GetDatabase();
            var result = readOnly == "yes"
                ? await db.ScriptEvaluateReadOnlyAsync("return 1")
                : await db.ScriptEvaluateAsync("return redis.call('INCR', KEYS[1])", [(RedisKey)Key("scripted")]);
            return Results.Ok(new { result = result.ToString() });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/memory-doctor", async (IConnectionMultiplexer redis) =>
            Results.Ok(new { result = (await redis.GetDatabase().ExecuteAsync("MEMORY", "DOCTOR")).ToString() })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/publish", async (IConnectionMultiplexer redis) =>
            Results.Ok(new { receivers = await redis.GetSubscriber().PublishAsync(RedisChannel.Literal("c"), "m") })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/server-flush", (IConnectionMultiplexer redis) =>
        {
            redis.GetServer(redis.GetEndPoints()[0]).FlushDatabase();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/derived/{via}", async (string via, IConnectionMultiplexer redis) =>
        {
            // Every handle points back at its multiplexer: that one must be the guarded decorator, not the real connection.
            var multiplexer = via switch
            {
                "database" => redis.GetDatabase().Multiplexer,
                "batch" => redis.GetDatabase().CreateBatch().Multiplexer,
                "server" => redis.GetServer(redis.GetEndPoints()[0]).Multiplexer,
                _ => redis.GetSubscriber().Multiplexer
            };
            await multiplexer.GetDatabase().StringSetAsync(Key("derived-" + via), "x");
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/reconfigure", async (IConnectionMultiplexer redis) =>
            Results.Ok(new { receivers = await redis.PublishReconfigureAsync() })).AllowAnonymous().WithSendproofPreview();
    }

    [ServiceFact("redis")]
    public async Task APureReadRunsAndIsLoggedWithoutItsValueOrThePassword()
    {
        await using var f = await Fixture.StartAsync();
        await f.Db.StringSetAsync(f.Prefix + "counter:seeded", "5");
        var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/counters/seeded"));
        Assert.Equal(5, envelope.GetProperty("body").GetProperty("value").GetInt64());
        var entry = Assert.Single(Expect.DbEntries(envelope, "redis", "GET"));
        Assert.Equal(f.Prefix + "counter:seeded", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.Equal($"GET {f.Prefix}counter:seeded", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.False(entry.GetProperty("db").TryGetProperty("blocked", out _));
        var text = envelope.GetRawText();
        Assert.DoesNotContain(Services.RedisPassword, text);
        Assert.DoesNotContain("AUTH", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HELLO", text, StringComparison.OrdinalIgnoreCase);
    }

    [ServiceFact("redis")]
    public async Task AWriteIsRefusedBeforeAnyByteIsSent()
    {
        await using var f = await Fixture.StartAsync();
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/counters/blocked"), "redis", "INCR");
        Assert.Equal("Preview unavailable: this operation writes to Redis", problem.GetProperty("detail").GetString());
        Assert.True((await f.Db.StringGetAsync(f.Prefix + "counter:blocked")).IsNull, "INCR must not reach Redis.");
    }

    [ServiceFact("redis")]
    public async Task GetDelLooksLikeAReadButDeletesSoItBlocksEvenWhenTheHandlerSwallowsTheError()
    {
        await using var f = await Fixture.StartAsync();
        await f.Db.StringSetAsync(f.Prefix + "counter:seeded", "5");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/counters/seeded/take"), "redis", "GETDEL");
        Assert.Equal("5", await f.Db.StringGetAsync(f.Prefix + "counter:seeded"));
    }

    [ServiceFact("redis")]
    public async Task ABatchIsCheckedWhenQueuedSoARefusedWriteIsNeverSent()
    {
        await using var f = await Fixture.StartAsync();
        await f.Db.StringSetAsync(f.Prefix + "counter:k", "1");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/pipeline/k"), "redis", "SET");
        Assert.True((await f.Db.StringGetAsync(f.Prefix + "counter:k-written")).IsNull, "The queued SET must not reach Redis.");
    }

    [ServiceFact("redis")]
    public async Task AMultiTransactionNeverQueuesARefusedWrite()
    {
        await using var f = await Fixture.StartAsync();
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/multi/k"), "redis", "INCR");
        Assert.True((await f.Db.StringGetAsync(f.Prefix + "counter:k-incr")).IsNull);
    }

    [ServiceFact("redis")]
    public async Task ExecuteAndScriptsAreClassifiedByCommandName()
    {
        await using var f = await Fixture.StartAsync();
        await f.Db.StringSetAsync(f.Prefix + "counter:k", "7");
        var read = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/execute/GET?key=k"));
        Assert.Equal("7", read.GetProperty("body").GetProperty("result").GetString());
        // The command text names the key, as a typed call's does, and keeps no value.
        var db = Assert.Single(Expect.DbEntries(read, "redis", "GET")).GetProperty("db");
        Assert.Equal(f.Prefix + "counter:k", db.GetProperty("target").GetString());
        Assert.Equal("GET " + f.Prefix + "counter:k", db.GetProperty("statement").GetString());

        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/execute/SET?key=k"), "redis", "SET");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/script?readOnly=no"), "redis", "EVAL");
        Assert.Equal("7", await f.Db.StringGetAsync(f.Prefix + "counter:k"));
        Assert.True((await f.Db.StringGetAsync(f.Prefix + "counter:scripted")).IsNull, "The script must not run.");
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/script?readOnly=yes"));
    }

    [ServiceFact("redis")]
    public async Task PublishAndServerAdministrationAreWritesToo()
    {
        await using var f = await Fixture.StartAsync();
        await f.Db.StringSetAsync(f.Prefix + "counter:keep", "1");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/publish"), "redis", "PUBLISH");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/server-flush"), "redis", "FLUSHDB");
        Assert.Equal("1", await f.Db.StringGetAsync(f.Prefix + "counter:keep"));
    }

    [ServiceFact("redis")]
    public async Task TheMultiplexerAHandleReturnsIsGuardedAndReconfigurePublishesNothing()
    {
        await using var f = await Fixture.StartAsync();
        foreach (var via in new[] { "database", "batch", "server", "subscriber" })
        {
            await Expect.BlockedAsync(await f.App.PreviewAsync("POST", $"/derived/{via}"), "redis", "SET");
            Assert.False(await f.Db.KeyExistsAsync(f.Prefix + "counter:derived-" + via), $"The write through {via}.Multiplexer reached Redis.");
        }

        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/reconfigure"), "redis", "PUBLISH");
    }

    [ServiceFact("redis")]
    public async Task HostDeclaredReadsAreAllowedByExactNameOnly()
    {
        await using var blocked = await Fixture.StartAsync();
        await Expect.BlockedAsync(await blocked.App.PreviewAsync("POST", "/memory-doctor"), "redis", "MEMORY");
        await using var allowed = await Fixture.StartAsync(configure: redis => redis.TreatAsRead("MEMORY|DOCTOR"));
        await Expect.ConfirmedAsync(await allowed.App.PreviewAsync("POST", "/memory-doctor"));
        Assert.Throws<ArgumentException>(() => new RedisStoreBuilder().TreatAsRead("MEMORY|*"));
    }

    [ServiceFact("redis")]
    public async Task DiscoveryListsRedisInGuardModeWithItsLabelAndTheMarkedRoute()
    {
        await using var f = await Fixture.StartAsync();
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("redis", "cache", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
        var marked = Assert.Single(capabilities.GetProperty("previewUnavailable").EnumerateArray());
        Assert.Equal("/counters/{key}", marked.GetProperty("path").GetString());
        Assert.Equal("Preview unavailable: this operation writes to Redis", marked.GetProperty("reason").GetString());
        Assert.DoesNotContain(Services.RedisPassword, capabilities.GetRawText());
        Assert.DoesNotContain(Services.RedisHost, capabilities.GetRawText());
        await f.Db.StringSetAsync(f.Prefix + "counter:seeded", "5");
        await f.Db.StringSetAsync(f.Prefix + "counter:marked", "5");
        Expect.Unconfirmed(await f.App.PreviewAsync("DELETE", "/counters/marked"), HttpStatusCode.Conflict);
        Assert.Equal("5", await f.Db.StringGetAsync(f.Prefix + "counter:marked"));
    }

    [ServiceFact("redis")]
    public async Task ObservedSendWritesOnceAndTracesTheCommand()
    {
        await using var f = await Fixture.StartAsync();
        var (response, trace) = await f.App.ObservedAsync("POST", "/counters/sent");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(Expect.DbEntries(trace, "redis", "INCR"));
        Assert.Equal("1", await f.Db.StringGetAsync(f.Prefix + "counter:sent"));
        // Ordinary Send is never blocked either.
        using var send = await f.App.Client.PostAsync("/counters/sent", null);
        Assert.Equal(HttpStatusCode.OK, send.StatusCode);
        Assert.Equal("2", await f.Db.StringGetAsync(f.Prefix + "counter:sent"));
    }

    [ServiceFact("redis")]
    public async Task AnExecuteCommandsDbEntryNamesItsKeyFromTheSharedTable()
    {
        await using var f = await Fixture.StartAsync();
        var key = f.Prefix + "counter:coupon";

        // INCRBY sent through Execute: the key is argument 1; the value never appears.
        var (incr, trace) = await f.App.ObservedAsync("POST", "/execute-incrby/coupon");
        Assert.Equal(HttpStatusCode.OK, incr.StatusCode);
        var entry = Assert.Single(Expect.DbEntries(trace, "redis", "INCRBY")).GetProperty("db");
        Assert.Equal(key, entry.GetProperty("target").GetString());
        Assert.Equal($"INCRBY {key} ?", entry.GetProperty("statement").GetString());
        Assert.Equal("3", await f.Db.StringGetAsync(key));

        // A container command: OBJECT ENCODING key has its key at argument 2, after the subcommand.
        var (encoding, encodingTrace) = await f.App.ObservedAsync("POST", "/execute-encoding/coupon");
        Assert.Equal(HttpStatusCode.OK, encoding.StatusCode);
        var container = Assert.Single(Expect.DbEntries(encodingTrace, "redis", "OBJECT")).GetProperty("db");
        Assert.Equal(key, container.GetProperty("target").GetString());
        Assert.Equal($"OBJECT ENCODING {key}", container.GetProperty("statement").GetString());

        // A command with no positional key carries no target.
        var (_, keyless) = await f.App.ObservedAsync("POST", "/execute/dbsize");
        Assert.False(Assert.Single(Expect.DbEntries(keyless, "redis", "DBSIZE")).GetProperty("db").TryGetProperty("target", out _));
    }

    [Fact]
    public void TheSharedTableSaysWhereEachCommandsFirstKeyIs()
    {
        var table = StoreTables.Redis;
        Assert.Equal(1, table.FirstKeyPosition("INCRBY", null));
        Assert.Equal(1, table.FirstKeyPosition("SOME.MODULE.COMMAND", null));
        Assert.Equal(2, table.FirstKeyPosition("OBJECT", "freq"));
        Assert.Equal(2, table.FirstKeyPosition("BITOP", null));
        Assert.Equal(0, table.FirstKeyPosition("PING", null));
        Assert.Equal(0, table.FirstKeyPosition("OBJECT", "help"));
        var (statement, target) = RedisCommandMap.DescribeExecute(new RedisCommandMap.Command("SET"), ["set", new object[] { "k", "v", "EX", 10 }]);
        Assert.Equal(("SET k ? ? ?", "k"), (statement, target));
    }

    [ServiceFact("redis")]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: with the multiplexer left unwrapped, the very same write goes through and the Preview is
        // "confirmed", which is exactly what the guard exists to prevent.
        await using var f = await Fixture.StartAsync(hooked: false);
        var response = await f.App.PreviewAsync("POST", "/counters/unhooked");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("1", await f.Db.StringGetAsync(f.Prefix + "counter:unhooked"));
    }

    [ServiceFact("redis")]
    public async Task AMultiplexerFromACacheFactoryCanBeGuardedExplicitly()
    {
        await using var f = await Fixture.StartAsync(configure: redis => redis.WithoutDecoratingTheRegisteredMultiplexer());
        // Done the way RedisCacheOptions.ConnectionMultiplexerFactory would: wrap a multiplexer that the container never saw.
        var guarded = f.Raw.WithSendproofGuard(f.App.Services);
        Assert.NotSame(f.Raw, guarded);
        Assert.IsAssignableFrom<IConnectionMultiplexer>(guarded);
        Assert.True((await guarded.GetDatabase().StringGetAsync(f.Prefix + "nothing")).IsNull);
    }

    [Fact]
    public void RedisCommandsMapToTheirWireNames()
    {
        Assert.Equal("INCR", RedisCommandMap.Resolve("StringIncrementAsync", [(RedisKey)"k", 1L, CommandFlags.None]).Name);
        Assert.Equal("INCRBY", RedisCommandMap.Resolve("StringIncrement", [(RedisKey)"k", 5L, CommandFlags.None]).Name);
        Assert.Equal("GETDEL", RedisCommandMap.Resolve("StringGetDeleteAsync", [(RedisKey)"k", CommandFlags.None]).Name);
        Assert.Equal("MGET", RedisCommandMap.Resolve("StringGet", [new RedisKey[] { "a", "b" }, CommandFlags.None]).Name);
        Assert.Equal("SUNION", RedisCommandMap.Resolve("SetCombine", [SetOperation.Union, (RedisKey)"a", (RedisKey)"b", CommandFlags.None]).Name);
        Assert.Equal(("OBJECT", "ENCODING"), (RedisCommandMap.Resolve("KeyEncoding", []).Name, RedisCommandMap.Resolve("KeyEncoding", []).Sub));
        Assert.Equal(("OBJECT", "FREQ"), (RedisCommandMap.Resolve("Execute", ["object", new object[] { "freq", "k" }]).Name.ToUpperInvariant(), RedisCommandMap.Resolve("Execute", ["object", new object[] { "freq", "k" }]).Sub?.ToUpperInvariant()));
        // A method the map doesn't know is its own upper-cased name, which the table doesn't list: a write.
        Assert.Equal(CommandKind.Write, StoreClassifier.ClassifyRedis(RedisCommandMap.Resolve("SomeFutureMethodAsync", []).Name));
        foreach (var read in new[] { "StringGet", "HashGetAll", "ListRange", "SetMembers", "SortedSetScore", "KeyExists", "StreamRange", "GeoPosition", "HyperLogLogLength", "ScriptEvaluateReadOnly" })
        {
            var command = RedisCommandMap.Resolve(read, []);
            Assert.True(StoreClassifier.ClassifyRedis(command.Name, command.Sub) == CommandKind.Read, $"{read} should be a read ({command.Name}).");
        }

        foreach (var write in new[] { "StringSet", "StringIncrement", "KeyDelete", "HashSet", "ListLeftPush", "SetAdd", "SortedSetAdd", "StreamAdd", "StreamReadGroup", "ScriptEvaluate", "Sort", "GeoRadius", "Publish" })
        {
            var command = RedisCommandMap.Resolve(write, []);
            Assert.True(StoreClassifier.ClassifyRedis(command.Name, command.Sub) == CommandKind.Write, $"{write} should be a write ({command.Name}).");
        }
    }
}

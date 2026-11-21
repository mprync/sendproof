using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Sendproof.AspNetCore.Tests;

/// <summary>
/// The shared core every data-store hook builds on (docs/plans/data-stores.md): the embedded classification tables and
/// the shared vectors, the Preview scope's blocked and fault marks, the write guard, the pipeline order and the 409
/// response, discovery and the <c>preview: false</c> mark.
/// </summary>
public sealed class DataStoreCoreTests
{
    private static readonly string SpecDirectory = FindSpec();

    private static string FindSpec()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "spec", "data-stores");
            if (Directory.Exists(candidate)) return candidate;
        }

        throw new DirectoryNotFoundException("spec/data-stores was not found above the test output.");
    }

    // ---- Tables and vectors ----

    [Theory]
    [InlineData("redis", nameof(EmbeddedStoreTables.Redis))]
    [InlineData("mongodb", nameof(EmbeddedStoreTables.Mongodb))]
    [InlineData("dynamodb", nameof(EmbeddedStoreTables.Dynamodb))]
    public void EmbeddedTablesMatchTheSpec(string store, string field)
    {
        var embedded = (string)typeof(EmbeddedStoreTables).GetField(field,
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)!.GetRawConstantValue()!;
        var spec = File.ReadAllText(Path.Combine(SpecDirectory, store + ".json"));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(embedded), JsonNode.Parse(spec)),
            $"The embedded {store} table differs from spec/data-stores/{store}.json. Run node adapters/dotnet/scripts/embed-store-tables.mjs.");
    }

    [Fact]
    public void RedisClassifierPassesEverySharedVector()
    {
        var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(SpecDirectory, "classification-cases.json")))!["redis"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var vector in cases)
        {
            var command = vector!["command"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray();
            var actual = StoreClassifier.ClassifyRedis(command[0], command.Length > 1 ? command[1] : null);
            Assert.True(string.Equals(actual.ToString(), vector["expect"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase),
                $"{string.Join(' ', command)}: expected {vector["expect"]}, got {actual}");
        }
    }

    [Fact]
    public void DynamoClassifierPassesEverySharedVector()
    {
        var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(SpecDirectory, "classification-cases.json")))!["dynamodb"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var vector in cases)
        {
            var operation = vector!["operation"]!.GetValue<string>();
            var input = vector["input"]!.AsObject();
            IReadOnlyList<string?> statements = operation == "ExecuteStatement"
                ? [input["Statement"]?.GetValue<string>()]
                : [.. (input["Statements"] ?? input["TransactStatements"])?.AsArray().Select(item => item?["Statement"]?.GetValue<string>()) ?? []];
            var actual = StoreClassifier.ClassifyDynamo(operation, statements);
            Assert.True(string.Equals(actual.ToString(), vector["expect"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase),
                $"{operation} {input.ToJsonString()}: expected {vector["expect"]}, got {actual}");
        }
    }

    [Fact]
    public void HostDeclaredReadsAreAllowedByExactNameOnly()
    {
        var reads = DataStoreGuard.ReadSet(["MYMODULE.GET"], name => name.ToUpperInvariant());
        Assert.Equal(CommandKind.Write, StoreClassifier.ClassifyRedis("MYMODULE.GET"));
        Assert.Equal(CommandKind.Read, StoreClassifier.ClassifyRedis("mymodule.get", null, reads));
        Assert.Equal(CommandKind.Write, StoreClassifier.ClassifyRedis("MYMODULE.SET", null, reads));
        Assert.Throws<ArgumentException>(() => DataStoreGuard.ReadSet(["MYMODULE.*"], name => name));
        Assert.Equal(CommandKind.Read, StoreClassifier.ClassifyDynamo("DescribeStream", null, DataStoreGuard.ReadSet(["DescribeStream"], name => name)));
    }

    [Fact]
    public void RedactionReachesEveryDepthButKeepsOrdinaryKeys()
    {
        var node = JsonNode.Parse("""{"name":"a","password_hash":"x","profile":{"apiKey":"k","idempotency_key":"visible","tokens":[{"refreshToken":"t","city":"Leeds"}]}}""")!;
        SecretNames.RedactDeep(node);
        Assert.Equal("[REDACTED]", node["password_hash"]!.GetValue<string>());
        Assert.Equal("[REDACTED]", node["profile"]!["apiKey"]!.GetValue<string>());
        Assert.Equal("visible", node["profile"]!["idempotency_key"]!.GetValue<string>());
        Assert.Equal("[REDACTED]", node["profile"]!["tokens"]![0]!["refreshToken"]!.GetValue<string>());
        Assert.Equal("Leeds", node["profile"]!["tokens"]![0]!["city"]!.GetValue<string>());
    }

    [Fact]
    public void PartiqlLiteralsBecomeQuestionMarksButIdentifiersStay()
    {
        Assert.Equal("UPDATE \"orders\" SET status = ? WHERE id = ?",
            DataStoreGuard.SanitizePartiql("UPDATE \"orders\" SET status = 'cancel''led' WHERE id = 'secret-id'"));
        Assert.Equal("SELECT * FROM \"t1\" WHERE n > ? AND f < ?", DataStoreGuard.SanitizePartiql("SELECT * FROM \"t1\" WHERE n > 42 AND f < 3.5e-2"));
        Assert.Equal("SELECT * FROM \"o'rders\" WHERE id = ?", DataStoreGuard.SanitizePartiql("SELECT * FROM \"o'rders\" WHERE id = ?"));
    }

    [Fact]
    public void StoreLabelsMustNotBeConnectionDetails()
    {
        Assert.Equal("catalog", DataStoreGuard.Label("catalog"));
        Assert.Null(DataStoreGuard.Label(null));
        foreach (var bad in new[] { "mongodb://host/db", "host:27017", "user@host", "a=b", "", "x\u0001y" })
        {
            Assert.Throws<ArgumentException>(() => DataStoreGuard.Label(bad));
        }
    }

    // ---- The guard and the pipeline ----

    [Fact]
    public async Task AGuardedWriteInPreviewAnswers409WithAProblemBodyAndNothingElse()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/counters/a");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
        Assert.False(response.Headers.Contains("Preference-Applied"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("about:blank", problem.GetProperty("type").GetString());
        Assert.Equal("Preview unavailable", problem.GetProperty("title").GetString());
        Assert.Equal(409, problem.GetProperty("status").GetInt32());
        Assert.Equal("preview_unavailable", problem.GetProperty("code").GetString());
        Assert.Equal("Preview unavailable: this operation writes to Redis", problem.GetProperty("detail").GetString());
        Assert.Equal("redis", problem.GetProperty("store").GetString());
        Assert.Equal("INCR", problem.GetProperty("operation").GetString());
        Assert.False(problem.GetProperty("rolledBack").GetBoolean());
        Assert.False(problem.TryGetProperty("body", out _));
        Assert.Equal(0, host.Hook.Sent);
    }

    [Fact]
    public async Task ABlockedPreviewAnswers409EvenWhenTheHandlerCatchesTheErrorAndReturns200()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/swallow");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"));
        Assert.Equal("INCR", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("operation").GetString());
        Assert.Equal(0, host.Hook.Sent);
    }

    [Fact]
    public async Task AHandlerThatThrowsAfterABlockedWriteStillGetsThe409()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/counters/a");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task ReadsRunAndAreLoggedAsDbEntriesInAConfirmedPreview()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("GET", "/counters/a");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("tx=rollback", Assert.Single(response.Headers.GetValues("Preference-Applied")));
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(envelope.GetProperty("rolledBack").GetBoolean());
        var entry = Assert.Single(envelope.GetProperty("logs").EnumerateArray(), log => log.GetProperty("level").GetString() == "Db");
        Assert.Equal("GET counter:a", entry.GetProperty("message").GetString());
        Assert.Equal("redis", entry.GetProperty("db").GetProperty("system").GetString());
        Assert.Equal("GET", entry.GetProperty("db").GetProperty("operation").GetString());
        Assert.Equal("counter:a", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.False(entry.GetProperty("db").TryGetProperty("blocked", out _));
        Assert.Equal(1, host.Hook.Sent);
    }

    [Fact]
    public async Task AGuardedWriteOutsidePreviewAndInObservedSendIsNeverBlocked()
    {
        await using var host = await StoreHost.StartAsync();
        using var send = await host.Client.PostAsync("/counters/a", null);
        Assert.Equal(HttpStatusCode.OK, send.StatusCode);
        Assert.Equal(1, host.Hook.Sent);
        using var observed = new HttpRequestMessage(HttpMethod.Post, "/counters/b");
        observed.Headers.Add("Prefer", "trace");
        using var result = await host.Client.SendAsync(observed);
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Equal(2, host.Hook.Sent);
    }

    [Fact]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: the same assertions that pass with the hook must fail without it, or they prove nothing.
        await using var hooked = await StoreHost.StartAsync();
        await using var unhooked = await StoreHost.StartAsync(hookInstalled: false);
        Assert.True(await GuardHolds(hooked), "The guard checks must pass with the hook installed.");
        Assert.False(await GuardHolds(unhooked), "The guard checks must fail when the hook is removed.");

        static async Task<bool> GuardHolds(StoreHost host)
        {
            using var response = await host.PreviewAsync("POST", "/counters/a");
            return response.StatusCode == HttpStatusCode.Conflict && host.Hook.Sent == 0 &&
                !response.Headers.Contains("Preference-Applied");
        }
    }

    [Fact]
    public async Task AFaultOutranksABlockAndWithholdsConfirmation()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/fault-then-block");
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"));
        using var alone = await host.PreviewAsync("POST", "/fault");
        Assert.Equal(HttpStatusCode.InternalServerError, alone.StatusCode);
        Assert.False(alone.Headers.Contains("Preference-Applied"));
    }

    [Fact]
    public async Task AStoreThatFailsToFinishFailsThePreviewWithoutConfirmation()
    {
        await using var host = await StoreHost.StartAsync(finishFails: true);
        using var response = await host.PreviewAsync("GET", "/counters/a");
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"));
        // A failed finish also outranks a blocked write.
        using var blocked = await host.PreviewAsync("POST", "/counters/a");
        Assert.Equal(HttpStatusCode.InternalServerError, blocked.StatusCode);
    }

    [Fact]
    public async Task APreviewRunsWithoutASqlProviderWhenDataStoresAreRegistered()
    {
        await using var host = await StoreHost.StartAsync();
        var capabilities = await host.CapabilitiesAsync();
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("database").ValueKind);
        Assert.Contains(capabilities.GetProperty("previewOperations").EnumerateArray(),
            operation => operation.GetProperty("path").GetString() == "/counters/{key}" && operation.GetProperty("method").GetString() == "GET");
        using var response = await host.PreviewAsync("GET", "/counters/a");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ObservedSendTracesDbEntriesWithoutASqlProvider()
    {
        await using var host = await StoreHost.StartAsync();
        using var signIn = await host.Client.PostAsync("/signin", null);
        var cookie = signIn.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
        using var request = new HttpRequestMessage(HttpMethod.Post, "/counters/a");
        request.Headers.Add("Cookie", cookie);
        request.Headers.Add("Prefer", "trace");
        using var response = await host.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var id = Assert.Single(response.Headers.GetValues("X-Sendproof-Trace"));
        using var traceRequest = new HttpRequestMessage(HttpMethod.Get, $"/sendproof/_api/traces/{id}");
        traceRequest.Headers.Add("Cookie", cookie);
        using var traceResponse = await host.Client.SendAsync(traceRequest);
        var trace = await traceResponse.Content.ReadFromJsonAsync<JsonElement>();
        var entry = Assert.Single(trace.GetProperty("logs").EnumerateArray(), log => log.GetProperty("level").GetString() == "Db");
        Assert.Equal("INCR", entry.GetProperty("db").GetProperty("operation").GetString());
        Assert.Equal(1, host.Hook.Sent);
    }

    [Fact]
    public async Task PreviewFalseOperationsAreReportedWithTheirReasonAndNeverRun()
    {
        await using var host = await StoreHost.StartAsync();
        var capabilities = await host.CapabilitiesAsync();
        Assert.DoesNotContain(capabilities.GetProperty("previewOperations").EnumerateArray(),
            operation => operation.GetProperty("method").GetString() == "DELETE");
        var marked = Assert.Single(capabilities.GetProperty("previewUnavailable").EnumerateArray());
        Assert.Equal("DELETE", marked.GetProperty("method").GetString());
        Assert.Equal("/counters/{key}", marked.GetProperty("path").GetString());
        Assert.Equal("Clears the Redis counter", marked.GetProperty("reason").GetString());
        Assert.Equal(["redis"], marked.GetProperty("stores").EnumerateArray().Select(item => item.GetString()).ToArray());

        using var response = await host.PreviewAsync("DELETE", "/counters/a");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"));
        Assert.Equal(0, host.Hook.Sent);
        Assert.Equal(0, host.DeleteRuns);

        // Ordinary Send of the marked route is unaffected.
        using var send = await host.Client.DeleteAsync("/counters/a");
        Assert.Equal(HttpStatusCode.NoContent, send.StatusCode);
        Assert.Equal(1, host.DeleteRuns);
    }

    [Fact]
    public async Task DiscoveryListsEachStoreWithItsModeAndNeverAConnectionString()
    {
        await using var host = await StoreHost.StartAsync();
        var capabilities = await host.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal("redis", store.GetProperty("system").GetString());
        Assert.Equal("cache", store.GetProperty("name").GetString());
        Assert.Equal("guard", store.GetProperty("mode").GetString());
        Assert.False(store.TryGetProperty("reason", out _));
        Assert.Equal("dotnet", capabilities.GetProperty("binding").GetProperty("language").GetString());
        Assert.Equal("ASP.NET Core", capabilities.GetProperty("binding").GetProperty("framework").GetString());
    }

    [Fact]
    public async Task ChangesAndDbEntriesFromAStoreReachTheEnvelopeRedactedAtAnyDepth()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/store-change");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        var change = Assert.Single(envelope.GetProperty("changes").EnumerateArray());
        Assert.Equal("mongodb", change.GetProperty("store").GetString());
        Assert.Equal("upsert", change.GetProperty("via").GetString());
        Assert.Equal("insert", change.GetProperty("operation").GetString());
        Assert.Equal("[REDACTED]", change.GetProperty("after").GetProperty("password_hash").GetString());
        Assert.Equal("[REDACTED]", change.GetProperty("after").GetProperty("profile").GetProperty("apiKey").GetString());
        Assert.Equal("York", change.GetProperty("after").GetProperty("profile").GetProperty("city").GetString());
        Assert.DoesNotContain("hashed:secret", envelope.GetRawText());
    }

    [Fact]
    public async Task ALateWriteAfterTheResponseSettledIsStillRefused()
    {
        await using var host = await StoreHost.StartAsync();
        using var response = await host.PreviewAsync("POST", "/late");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var late = await host.LateWrite!.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsType<PreviewWriteBlockedException>(late);
        Assert.Equal(0, host.Hook.Sent);
    }

    // ---- Review findings every language checks ----

    [Fact]
    public async Task OneStoreFailingToFinishNeverSkipsTheOtherStoresOrTheSqlRollback()
    {
        var order = new List<string>();
        await using var host = await StoreHost.StartAsync(configure: services =>
        {
            services.AddSingleton<IPreviewDataStore>(new RecordingStore("first", order, fail: true));
            services.AddSingleton<IPreviewDataStore>(new RecordingStore("second", order, fail: false));
            services.AddSingleton<IPreviewProvider>(new RecordingProvider(order));
        });
        using var response = await host.PreviewAsync("GET", "/counters/a");
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.False(response.Headers.Contains("Preference-Applied"));
        // Every cleanup step ran, in order: each store, then the SQL rollback, then disposal.
        Assert.Equal(["first.finish", "second.finish", "sql.rollback", "sql.dispose"], order);
    }

    [Fact]
    public async Task AWriteWithNoRequestAttributionFailsEveryOpenPreviewUnlessDetached()
    {
        await using var host = await StoreHost.StartAsync();
        var capture = host.Capture;

        // A background worker (nothing flows its request context to it) writes while a Preview is open.
        host.HoldPreview = new TaskCompletionSource();
        host.PreviewOpen = new TaskCompletionSource();
        var pending = host.PreviewAsync("POST", "/hold");
        await host.PreviewOpen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Detached(() => capture.Check("redis", "INCR", CommandKind.Write));
        host.HoldPreview.SetResult();
        using var failed = await pending;
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        Assert.False(failed.Headers.Contains("Preference-Applied"));

        // Marked detached (a worker that never belongs to a request), the same write leaves the Preview alone.
        host.HoldPreview = new TaskCompletionSource();
        host.PreviewOpen = new TaskCompletionSource();
        pending = host.PreviewAsync("POST", "/hold");
        await host.PreviewOpen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Detached(() =>
        {
            using var _ = DetachedWork.Begin();
            capture.Check("redis", "INCR", CommandKind.Write);
        });
        host.HoldPreview.SetResult();
        using var confirmed = await pending;
        Assert.Equal(HttpStatusCode.OK, confirmed.StatusCode);

        // An ordinary request's own write is attributed to it, so it never fails someone else's Preview.
        host.HoldPreview = new TaskCompletionSource();
        host.PreviewOpen = new TaskCompletionSource();
        pending = host.PreviewAsync("POST", "/hold");
        await host.PreviewOpen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var send = await host.Client.PostAsync("/counters/b", null);
        Assert.Equal(HttpStatusCode.OK, send.StatusCode);
        host.HoldPreview.SetResult();
        using var untouched = await pending;
        Assert.Equal(HttpStatusCode.OK, untouched.StatusCode);

        // With no Preview open, an unattributed write is nobody's business.
        await Detached(() => capture.Check("redis", "INCR", CommandKind.Write));
    }

    /// <summary>Runs work the way a background thread would: with the caller's execution context not flowed to it.</summary>
    private static Task Detached(Action work)
    {
        using var _ = ExecutionContext.SuppressFlow();
        return Task.Run(work);
    }

    // ---- Test host ----

    private sealed class RecordingStore(string name, List<string> order, bool fail) : IPreviewDataStore
    {
        public string System => "redis";

        public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(new DataStoreDescription("redis", name, "guard"));

        public ValueTask FinishPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken)
        {
            lock (order) { order.Add(name + ".finish"); }
            return fail ? throw new InvalidOperationException("Injected abort failure.") : ValueTask.CompletedTask;
        }
    }

    private sealed class RecordingProvider(List<string> order) : IPreviewProvider
    {
        public string? Database => "Recorded";

        public ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IPreviewSession>(new Session(order));

        private sealed class Session(List<string> order) : IPreviewSession
        {
            public IReadOnlyList<PreviewChange> Changes => [];

            public ValueTask RollbackAsync(CancellationToken cancellationToken)
            {
                lock (order) { order.Add("sql.rollback"); }
                return ValueTask.CompletedTask;
            }

            public ValueTask DisposeAsync()
            {
                lock (order) { order.Add("sql.dispose"); }
                return ValueTask.CompletedTask;
            }
        }
    }

    private sealed class Hook
    {
        /// <summary>Commands that reached the (fake) store.</summary>
        internal int Sent;
    }

    private sealed class FakeStore(string? name, bool finishFails) : IPreviewDataStore
    {
        public string System => "redis";

        public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(new DataStoreDescription("redis", name, "guard"));

        public ValueTask FinishPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken) =>
            finishFails ? throw new InvalidOperationException("Injected abort failure.") : ValueTask.CompletedTask;
    }

    private sealed class StoreHost(WebApplication app, HttpClient client, Hook hook) : IAsyncDisposable
    {
        internal HttpClient Client => client;
        internal Hook Hook => hook;
        internal int DeleteRuns;
        internal TaskCompletionSource<Exception?>? LateWrite;
        internal TaskCompletionSource? HoldPreview;
        internal TaskCompletionSource? PreviewOpen;
        internal CaptureContext Capture => app.Services.GetRequiredService<CaptureContext>();

        internal static async Task<StoreHost> StartAsync(bool hookInstalled = true, bool finishFails = false, Action<IServiceCollection>? configure = null)
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                Args = ["--hostBuilder:reloadConfigOnChange=false"],
                EnvironmentName = "Development"
            });
            builder.WebHost.UseTestServer();
            builder.Logging.SetMinimumLevel(LogLevel.Critical);
            builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
            builder.Services.AddAuthentication("test").AddCookie("test");
            builder.Services.AddAuthorization();
            builder.Services.AddSendproof().WithApiName("Stores");
            if (configure is null)
            {
                builder.Services.AddSingleton<IPreviewDataStore>(new FakeStore("cache", finishFails));
            }
            else
            {
                configure(builder.Services);
            }
            var app = builder.Build();
            var hook = new Hook();
            StoreHost? host = null;
            var capture = app.Services.GetRequiredService<CaptureContext>();

            // The hook a store installs: classify, guard, then "send" (count it) and log a Db entry.
            string Send(string command, string key)
            {
                var kind = StoreClassifier.ClassifyRedis(command);
                if (hookInstalled)
                {
                    capture.Check("redis", command, kind);
                }

                Interlocked.Increment(ref hook.Sent);
                capture.Current?.RecordDb(new DbEntry("redis", command) { Target = key, ElapsedMs = 0.5 });
                return "ok";
            }

            app.MapPost("/signin", async (HttpContext context) =>
            {
                await context.SignInAsync("test", new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                    [new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.NameIdentifier, "robin")], "test")));
                return Results.NoContent();
            }).AllowAnonymous();
            app.MapGet("/counters/{key}", (string key) => Send("GET", "counter:" + key)).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/counters/{key}", (string key) => Send("INCR", "counter:" + key)).AllowAnonymous().WithSendproofPreview();
            app.MapDelete("/counters/{key}", (string key) =>
            {
                Interlocked.Increment(ref host!.DeleteRuns);
                Send("DEL", "counter:" + key);
                return Results.NoContent();
            }).AllowAnonymous().WithSendproofPreview(enabled: false, reason: "Clears the Redis counter", "redis");
            app.MapPost("/swallow", () =>
            {
                try { Send("INCR", "swallowed"); }
                catch (PreviewWriteBlockedException) { /* The mark, not the response, decides the outcome. */ }
                return Results.Ok(new { swallowed = true });
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/fault", () =>
            {
                try { throw capture.RefuseInPreview("A commit reached the server.")!; }
                catch (PreviewTransactionControlException) { }
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/fault-then-block", () =>
            {
                try { Send("INCR", "a"); } catch (PreviewWriteBlockedException) { }
                try { throw capture.RefuseInPreview("A commit reached the server.")!; } catch (PreviewTransactionControlException) { }
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/store-change", (SendproofPreview preview) =>
            {
                preview.RecordChange(new PreviewChange("insert", "documents", JsonNode.Parse("""{"_id":"d1"}"""), null,
                    JsonNode.Parse("""{"_id":"d1","password_hash":"hashed:secret","profile":{"city":"York","apiKey":"k-1"}}"""))
                { Store = "mongodb", Namespace = "catalog", Via = "upsert" });
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/hold", async () =>
            {
                host!.PreviewOpen!.TrySetResult();
                await host.HoldPreview!.Task.WaitAsync(TimeSpan.FromSeconds(10));
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapPost("/late", () =>
            {
                var source = host!.LateWrite = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
                // Started inside the Preview, finishes after the Preview ended: it inherits the Preview scope.
                _ = Task.Run(async () =>
                {
                    await Task.Delay(300);
                    try { Send("INCR", "late"); source.SetResult(null); }
                    catch (Exception error) { source.SetResult(error); }
                });
                return Results.Ok();
            }).AllowAnonymous().WithSendproofPreview();
            app.MapSendproof();
            await app.StartAsync();
            app.GetTestServer().PreserveExecutionContext = true;
            var client = app.GetTestClient();
            client.Timeout = TimeSpan.FromSeconds(10);
            host = new StoreHost(app, client, hook);
            return host;
        }

        internal Task<HttpResponseMessage> PreviewAsync(string method, string path)
        {
            var request = new HttpRequestMessage(new HttpMethod(method), "/sendproof/_preview" + path);
            request.Headers.Add("Prefer", "tx=rollback");
            return client.SendAsync(request);
        }

        internal async Task<JsonElement> CapabilitiesAsync() =>
            await client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities");

        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            await app.DisposeAsync();
        }
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sendproof.AspNetCore;
using Xunit;

namespace Sendproof.EntityFrameworkCore.Tests;

/// <summary>
/// Preview sessions on EF Core (spec/README.md "Preview sessions"): one connection and transaction across the steps'
/// requests, a savepoint before each step, rewind, and a rollback on delete, idle timeout and maximum lifetime.
/// </summary>
public sealed class PreviewSessionTests
{
    [Fact]
    public async Task SqliteStepsShareOneTransactionRewindAndRollBack()
    {
        await using var database = SqliteDatabase.Create();
        await StepsShareOneTransactionAsync(database.Configure, database.CountAsync);
    }

    /// <summary>
    /// SQLite has one writer. A second session can't begin while another holds the write transaction, so it is refused
    /// within seconds as 409 <c>store_busy</c> (not a 500 after the driver's 30-second wait), and opens once the first ends.
    /// </summary>
    [Fact]
    public async Task ASecondSqliteSessionIsRefusedAsStoreBusyAndOpensOnceTheFirstEnds()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var first = await host.OpenAsync(null);

        var waited = System.Diagnostics.Stopwatch.StartNew();
        using (var second = await host.Client.PostAsync("/sendproof/_api/sessions", null))
        {
            waited.Stop();
            var problem = await Problem(second, HttpStatusCode.Conflict, "store_busy");
            Assert.StartsWith("Another Preview session is holding sp_session_", problem.GetProperty("title").GetString());
            Assert.EndsWith(".db.", problem.GetProperty("title").GetString());
            Assert.Contains("idle timeout", problem.GetProperty("detail").GetString());
            Assert.Equal(300, problem.GetProperty("idleTimeoutSeconds").GetInt32());
        }

        Assert.True(waited.Elapsed < TimeSpan.FromSeconds(10), $"The refusal took {waited.Elapsed}.");

        // The refused attempt took nothing: the first session still works, and a second opens after it ends.
        using (var read = await host.PreviewAsync("GET", "/orders", null, first))
        {
            await Confirmed(read);
        }

        using (var ended = await host.EndAsync(null, first))
        {
            Assert.Equal(HttpStatusCode.NoContent, ended.StatusCode);
        }

        await host.OpenAsync(null);
    }

    [ServiceFact("postgres")]
    public async Task PostgreSqlStepsShareOneTransactionRewindAndRollBack()
    {
        await using var database = await ServerDatabase.PostgresAsync();
        await StepsShareOneTransactionAsync(database.Configure, database.CountAsync);
    }

    [ServiceFact("mysql")]
    public async Task MySqlStepsShareOneTransactionRewindAndRollBack()
    {
        await using var database = await ServerDatabase.MySqlAsync(ServiceFactAttribute.MySqlRoot);
        await StepsShareOneTransactionAsync(database.Configure, database.CountAsync);
    }

    [ServiceFact("mariadb")]
    public async Task MariaDbStepsShareOneTransactionRewindAndRollBack()
    {
        await using var database = await ServerDatabase.MySqlAsync(ServiceFactAttribute.MariaDbRoot);
        await StepsShareOneTransactionAsync(database.Configure, database.CountAsync);
    }

    [ServiceFact("sqlserver")]
    public async Task SqlServerStepsShareOneTransactionRewindAndRollBack()
    {
        await using var database = await ServerDatabase.SqlServerAsync();
        await StepsShareOneTransactionAsync(database.Configure, database.CountAsync);
    }

    /// <summary>
    /// SQL Server can't release a savepoint, so a kept step proves the transaction is still the session's by its ID. A
    /// handler that commits on the provider's own connection, past every guard, gets a new transaction: the session closes.
    /// </summary>
    [ServiceFact("sqlserver")]
    public async Task ASqlServerCommitNoGuardSawClosesTheSession()
    {
        await using var database = await ServerDatabase.SqlServerAsync();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using var committed = await host.PreviewAsync("POST", "/orders/raw-commit", null, id);
        Assert.Equal(HttpStatusCode.InternalServerError, committed.StatusCode);
        Assert.False(committed.Headers.Contains("Preference-Applied"));
        using var gone = await host.PreviewAsync("GET", "/orders", null, id);
        await Problem(gone, HttpStatusCode.NotFound, "session_not_found");
    }

    /// <summary>MySQL Previews take turns per process: a session keeps the turn, so a second one can't open meanwhile.</summary>
    [ServiceFact("mysql")]
    public async Task AMySqlSessionKeepsTheProcesssPreviewTurn()
    {
        await using var database = await ServerDatabase.MySqlAsync(ServiceFactAttribute.MySqlRoot);
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using (var second = await host.Client.PostAsync("/sendproof/_api/sessions", null))
        {
            await Problem(second, HttpStatusCode.Conflict, "store_busy");
        }

        using (var ended = await host.EndAsync(null, id))
        {
            Assert.Equal(HttpStatusCode.NoContent, ended.StatusCode);
        }

        await host.OpenAsync(null);
    }

    private static async Task StepsShareOneTransactionAsync(Action<DbContextOptionsBuilder> configure, Func<Task<int>> independentCount)
    {
        await using var host = await SessionHost.StartAsync(configure);
        var cookie = await host.SignInAsync("robin");
        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities");
        Assert.True(capabilities.GetProperty("previewSessions").GetBoolean());

        var id = await host.OpenAsync(cookie);
        Assert.Matches("^[0-9a-f]{32}$", id);

        using var created = await host.PreviewAsync("POST", "/orders", cookie, id, new { reference = "A-1" });
        var first = await Confirmed(created);
        Assert.Equal(id, first.GetProperty("session").GetProperty("id").GetString());
        Assert.Equal(1, first.GetProperty("session").GetProperty("step").GetInt32());
        var insert = Assert.Single(first.GetProperty("changes").EnumerateArray());
        Assert.Equal("insert", insert.GetProperty("operation").GetString());
        var orderId = first.GetProperty("body").GetProperty("id").GetInt32();
        // EF Core's savepoint API runs outside the command pipeline, so no savepoint shows in the captured SQL.
        Assert.DoesNotContain(first.GetProperty("logs").EnumerateArray(), log => log.GetProperty("message").GetString()!.Contains("sendproof_"));

        // Step 2 sees step 1's uncommitted row; nothing outside the session does.
        using var read = await host.PreviewAsync("GET", $"/orders/{orderId}", cookie, id);
        var second = await Confirmed(read);
        Assert.Equal(200, second.GetProperty("status").GetInt32());
        Assert.Equal("A-1", second.GetProperty("body").GetProperty("reference").GetString());
        Assert.Equal(2, second.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Empty(second.GetProperty("changes").EnumerateArray());
        Assert.Equal(0, await independentCount());

        // Step 3 renames it; rewinding to step 3 discards that, and the re-run sees step 1's row again.
        using var renamed = await host.PreviewAsync("POST", $"/orders/{orderId}/rename", cookie, id, new { reference = "A-2" });
        Assert.Equal(3, (await Confirmed(renamed)).GetProperty("session").GetProperty("step").GetInt32());
        using (var rewind = await host.RewindAsync(cookie, id, 3))
        {
            Assert.Equal(HttpStatusCode.NoContent, rewind.StatusCode);
        }

        using var again = await host.PreviewAsync("GET", $"/orders/{orderId}", cookie, id);
        var rerun = await Confirmed(again);
        Assert.Equal(3, rerun.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Equal("A-1", rerun.GetProperty("body").GetProperty("reference").GetString());

        // Rewinding to step 2 re-runs the read; past the next step is refused.
        using (var rewind = await host.RewindAsync(cookie, id, 2))
        {
            Assert.Equal(HttpStatusCode.NoContent, rewind.StatusCode);
        }

        using (var tooFar = await host.RewindAsync(cookie, id, 4))
        {
            Assert.Equal(HttpStatusCode.BadRequest, tooFar.StatusCode);
        }

        using var reread = await host.PreviewAsync("GET", $"/orders/{orderId}", cookie, id);
        Assert.Equal(2, (await Confirmed(reread)).GetProperty("session").GetProperty("step").GetInt32());

        using (var ended = await host.EndAsync(cookie, id))
        {
            Assert.Equal(HttpStatusCode.NoContent, ended.StatusCode);
        }

        Assert.Equal(0, await independentCount());
        using var gone = await host.PreviewAsync("GET", $"/orders/{orderId}", cookie, id);
        await Problem(gone, HttpStatusCode.NotFound, "session_not_found");
        using var endedTwice = await host.EndAsync(cookie, id);
        await Problem(endedTwice, HttpStatusCode.NotFound, "session_not_found");

        // A single Preview and a real Send still behave as before once the session has ended.
        using var single = await host.PreviewAsync("POST", "/orders", cookie, null, new { reference = "B-1" });
        Assert.False((await Confirmed(single)).TryGetProperty("session", out _));
        Assert.Equal(0, await independentCount());
        using var sent = await host.SendAsync("POST", "/orders", cookie, new { reference = "C-1" });
        Assert.Equal(HttpStatusCode.Created, sent.StatusCode);
        Assert.Equal(1, await independentCount());
    }

    [Fact]
    public async Task IdleTimeoutRollsTheSessionBack()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure, idle: TimeSpan.FromMilliseconds(600), lifetime: TimeSpan.FromMinutes(1));
        var opened = await host.Client.PostAsync("/sendproof/_api/sessions", null);
        Assert.Equal(HttpStatusCode.Created, opened.StatusCode);
        var body = await opened.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(60, body.GetProperty("maxLifetimeSeconds").GetInt32());
        var id = body.GetProperty("id").GetString()!;

        using var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" });
        await Confirmed(created);
        await WaitUntilAsync(async () =>
        {
            // The sweep ends the transaction, so the SQLite write lock is free again and a real Send can write.
            using var sent = await host.SendAsync("POST", "/orders", null, new { reference = "C-1" });
            return sent.StatusCode == HttpStatusCode.Created;
        });
        Assert.Equal(1, await database.CountAsync());
        using var expired = await host.PreviewAsync("GET", "/orders/1", null, id);
        await Problem(expired, HttpStatusCode.NotFound, "session_not_found");
    }

    [Fact]
    public async Task MaximumLifetimeRollsTheSessionBackEvenWhileInUse()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure, idle: TimeSpan.FromMinutes(1), lifetime: TimeSpan.FromMilliseconds(900));
        var id = await host.OpenAsync(null);
        using var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" });
        await Confirmed(created);
        await WaitUntilAsync(async () =>
        {
            using var read = await host.PreviewAsync("GET", "/orders/1", null, id);
            return read.StatusCode == HttpStatusCode.NotFound &&
                (await read.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("code", out var code) && code.GetString() == "session_not_found";
        });
        Assert.Equal(0, await database.CountAsync());
    }

    [Fact]
    public async Task HostShutdownRollsTheSessionBack()
    {
        await using var database = SqliteDatabase.Create();
        var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using (var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" }))
        {
            await Confirmed(created);
        }

        await host.DisposeAsync();
        Assert.Equal(0, await database.CountAsync());
    }

    /// <summary>
    /// A unique violation the handler catches leaves the PostgreSQL transaction aborted. The step can't be kept, so it is
    /// rolled back to its savepoint and the session carries on at the same step.
    /// </summary>
    [ServiceFact("postgres")]
    public async Task APostgreSqlStepThatAbortsTheTransactionIsUndone()
    {
        await using var database = await ServerDatabase.PostgresAsync();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using (var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" }))
        {
            await Confirmed(created);
        }

        using var duplicate = await host.PreviewAsync("POST", "/orders/duplicate", null, id);
        Assert.Equal(HttpStatusCode.InternalServerError, duplicate.StatusCode);
        Assert.False(duplicate.Headers.Contains("Preference-Applied"));

        using var listed = await host.PreviewAsync("GET", "/orders", null, id);
        var envelope = await Confirmed(listed);
        Assert.Equal(2, envelope.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Equal(["A-1"], envelope.GetProperty("body").EnumerateArray().Select(order => order.GetProperty("reference").GetString()));
    }

    [Fact]
    public async Task ASessionTakesOneRequestAtATime()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        host.Gate.Reset();
        var slow = host.PreviewAsync("POST", "/orders/slow", null, id, new { reference = "S-1" });
        await host.Gate.Started.Task.WaitAsync(TimeSpan.FromSeconds(10));

        using (var busy = await host.PreviewAsync("GET", "/orders/1", null, id))
        {
            await Problem(busy, HttpStatusCode.Conflict, "session_busy");
        }

        using (var busyRewind = await host.RewindAsync(null, id, 1))
        {
            await Problem(busyRewind, HttpStatusCode.Conflict, "session_busy");
        }

        using (var busyEnd = await host.EndAsync(null, id))
        {
            await Problem(busyEnd, HttpStatusCode.Conflict, "session_busy");
        }

        host.Gate.Release.TrySetResult();
        using var finished = await slow;
        Assert.Equal(1, (await Confirmed(finished)).GetProperty("session").GetProperty("step").GetInt32());
        using var next = await host.PreviewAsync("GET", "/orders/1", null, id);
        Assert.Equal(2, (await Confirmed(next)).GetProperty("session").GetProperty("step").GetInt32());
    }

    [Fact]
    public async Task ForeignAndUnknownSessionsAreNotFound()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var robin = await host.SignInAsync("robin");
        var alex = await host.SignInAsync("alex");
        var id = await host.OpenAsync(robin);

        foreach (var (cookie, session) in new[] { (alex, id), ((string?)null, id), (robin, new string('0', 32)), (robin, "not-a-session") })
        {
            using var preview = await host.PreviewAsync("GET", "/orders/1", cookie, session);
            await Problem(preview, HttpStatusCode.NotFound, "session_not_found");
            using var rewind = await host.RewindAsync(cookie, session, 1);
            await Problem(rewind, HttpStatusCode.NotFound, "session_not_found");
            using var end = await host.EndAsync(cookie, session);
            await Problem(end, HttpStatusCode.NotFound, "session_not_found");
        }

        // A cross-site caller can neither open nor reach one.
        using var crossSite = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_api/sessions");
        crossSite.Headers.Add("Cookie", robin);
        crossSite.Headers.Add("Sec-Fetch-Site", "cross-site");
        using var refused = await host.Client.SendAsync(crossSite);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);

        // The owner still can.
        using var owned = await host.PreviewAsync("GET", "/orders/1", robin, id);
        Assert.Equal(1, (await Confirmed(owned)).GetProperty("session").GetProperty("step").GetInt32());
    }

    [Fact]
    public async Task AnUnmarkedReadRunsInsideASessionOnly()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" });
        var orderId = (await Confirmed(created)).GetProperty("body").GetProperty("id").GetInt32();

        // Inside the session an unmarked GET runs in its transaction and sees step 1's row.
        using var read = await host.PreviewAsync("GET", $"/lookups/orders/{orderId}", null, id);
        var envelope = await Confirmed(read);
        Assert.Equal(2, envelope.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Equal("A-1", envelope.GetProperty("body").GetProperty("reference").GetString());
        Assert.Empty(envelope.GetProperty("changes").EnumerateArray());

        // Outside a session it is refused as before, and a read marked preview: false stays refused inside one.
        using var outside = await host.PreviewAsync("GET", $"/lookups/orders/{orderId}", null, null);
        Assert.Equal(HttpStatusCode.Conflict, outside.StatusCode);
        Assert.False(outside.Headers.Contains("Preference-Applied"));
        using var hidden = await host.PreviewAsync("GET", $"/audits/orders/{orderId}", null, id);
        Assert.Equal(HttpStatusCode.Conflict, hidden.StatusCode);
        Assert.False(hidden.Headers.Contains("Preference-Applied"));

        // Neither refusal used up a step.
        using var next = await host.PreviewAsync("GET", "/orders", null, id);
        Assert.Equal(3, (await Confirmed(next)).GetProperty("session").GetProperty("step").GetInt32());
    }

    [Fact]
    public async Task ABlockedGuardStoreWriteUndoesOnlyThatStep()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" });
        await Confirmed(created);

        // Step 2 writes a row, then writes to a guard store: blocked, and its row is rolled back.
        using var blocked = await host.PreviewAsync("POST", "/orders/cached", null, id, new { reference = "B-1" });
        var problem = await Problem(blocked, HttpStatusCode.Conflict, "preview_unavailable");
        Assert.Equal("redis", problem.GetProperty("store").GetString());

        // The session is still usable, still at step 2, and sees step 1's row but not the blocked step's.
        using var listed = await host.PreviewAsync("GET", "/orders", null, id);
        var envelope = await Confirmed(listed);
        Assert.Equal(2, envelope.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Equal(["A-1"], envelope.GetProperty("body").EnumerateArray().Select(order => order.GetProperty("reference").GetString()));
    }

    [Fact]
    public async Task AFailedHandlerUndoesItsStepAndTheSessionGoesOn()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using var failed = await host.PreviewAsync("POST", "/orders/fail", null, id, new { reference = "F-1" });
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        Assert.False(failed.Headers.Contains("Preference-Applied"));

        using var listed = await host.PreviewAsync("GET", "/orders", null, id);
        var envelope = await Confirmed(listed);
        Assert.Equal(1, envelope.GetProperty("session").GetProperty("step").GetInt32());
        Assert.Empty(envelope.GetProperty("body").EnumerateArray());
    }

    [Fact]
    public async Task TheHandlerCantTouchTheSessionsSavepoints()
    {
        await using var database = SqliteDatabase.Create();
        await using var host = await SessionHost.StartAsync(database.Configure);
        var id = await host.OpenAsync(null);
        using var created = await host.PreviewAsync("POST", "/orders", null, id, new { reference = "A-1" });
        await Confirmed(created);

        // Releasing the check savepoint would hide a commit from the step's check: refused, and the session is closed.
        using var escaped = await host.PreviewAsync("POST", "/orders/release", null, id);
        Assert.Equal(HttpStatusCode.InternalServerError, escaped.StatusCode);
        using var gone = await host.PreviewAsync("GET", "/orders", null, id);
        await Problem(gone, HttpStatusCode.NotFound, "session_not_found");
        Assert.Equal(0, await database.CountAsync());
    }

    private static async Task<JsonElement> Confirmed(HttpResponseMessage response)
    {
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"Expected a confirmed Preview, got {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        Assert.Equal("tx=rollback", Assert.Single(response.Headers.GetValues("Preference-Applied")));
        var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(envelope.GetProperty("rolledBack").GetBoolean());
        return envelope;
    }

    private static async Task<JsonElement> Problem(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Assert.True(response.StatusCode == status, $"Expected {(int)status} {code}, got {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, problem.GetProperty("code").GetString());
        return problem;
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!await condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "The session was not rolled back in time.");
            await Task.Delay(100);
        }
    }

    public sealed class OrdersContext(DbContextOptions<OrdersContext> options) : DbContext(options)
    {
        public DbSet<Order> Orders => Set<Order>();
    }

    public sealed class Order
    {
        public int Id { get; set; }
        public string Reference { get; set; } = "";
    }

    public sealed record OrderInput(string Reference);

    private sealed class Gate
    {
        internal TaskCompletionSource Started { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal void Reset()
        {
            Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    /// <summary>A guard store with no client: the handler's write to it is what a hooked Redis write looks like to the guard.</summary>
    private sealed class FakeRedis : IPreviewDataStore
    {
        public string System => "redis";

        public ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(new DataStoreDescription("redis", null, "guard"));
    }

    private sealed class SessionHost(WebApplication app, HttpClient client, Gate gate) : IAsyncDisposable
    {
        internal HttpClient Client => client;
        internal Gate Gate => gate;

        internal static async Task<SessionHost> StartAsync(Action<DbContextOptionsBuilder> configure, TimeSpan? idle = null, TimeSpan? lifetime = null)
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
            builder.Services.AddDbContext<OrdersContext>(configure);
            var bench = builder.Services.AddSendproof().AddEntityFrameworkCore<OrdersContext>();
            if (idle is not null || lifetime is not null)
            {
                bench.WithPreviewSessionLimits(idle ?? TimeSpan.FromMinutes(5), lifetime ?? TimeSpan.FromMinutes(30));
            }

            builder.Services.AddSingleton<IPreviewDataStore, FakeRedis>();
            var gate = new Gate();
            var app = builder.Build();
            await using (var scope = app.Services.CreateAsyncScope())
            {
                await scope.ServiceProvider.GetRequiredService<OrdersContext>().Database.EnsureCreatedAsync();
            }

            app.MapPost("/signin", async (HttpContext context, string subject) =>
            {
                await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, subject)], "test")));
                return Results.NoContent();
            });
            app.MapGet("/orders", async (OrdersContext db) => await db.Orders.OrderBy(order => order.Id).ToListAsync()).WithSendproofPreview();
            app.MapGet("/orders/{id:int}", async (int id, OrdersContext db) =>
                await db.Orders.FindAsync(id) is { } order ? Results.Ok(order) : Results.NotFound()).WithSendproofPreview();
            // A read nobody marked, and one marked preview: false.
            app.MapGet("/lookups/orders/{id:int}", async (int id, OrdersContext db) =>
                await db.Orders.FindAsync(id) is { } order ? Results.Ok(order) : Results.NotFound());
            app.MapGet("/audits/orders/{id:int}", (int id) => Results.Ok(new { id }))
                .WithSendproofPreview(enabled: false, reason: "Reads the audit service");
            app.MapPost("/orders", async (OrderInput input, OrdersContext db) =>
            {
                var order = new Order { Reference = input.Reference };
                db.Orders.Add(order);
                await db.SaveChangesAsync();
                return Results.Created($"/orders/{order.Id}", order);
            }).WithSendproofPreview();
            app.MapPost("/orders/{id:int}/rename", async (int id, OrderInput input, OrdersContext db) =>
            {
                var order = await db.Orders.FindAsync(id);
                order!.Reference = input.Reference;
                await db.SaveChangesAsync();
                return Results.Ok(order);
            }).WithSendproofPreview();
            app.MapPost("/orders/slow", async (OrderInput input, OrdersContext db) =>
            {
                gate.Started.TrySetResult();
                await gate.Release.Task.WaitAsync(TimeSpan.FromSeconds(10));
                db.Orders.Add(new Order { Reference = input.Reference });
                await db.SaveChangesAsync();
                return Results.Created();
            }).WithSendproofPreview();
            app.MapPost("/orders/cached", async (OrderInput input, OrdersContext db, HttpContext context) =>
            {
                db.Orders.Add(new Order { Reference = input.Reference });
                await db.SaveChangesAsync();
                context.RequestServices.GetRequiredService<CaptureContext>().Check("redis", "SET", CommandKind.Write);
                return Results.Created();
            }).WithSendproofPreview();
            app.MapPost("/orders/fail", async (OrderInput input, OrdersContext db) =>
            {
                db.Orders.Add(new Order { Reference = input.Reference });
                await db.SaveChangesAsync();
                throw new InvalidOperationException("The handler failed after its write.");
            }).WithSendproofPreview();
            app.MapPost("/orders/duplicate", async (OrdersContext db) =>
            {
                // EF Core's SaveChanges guards itself with a savepoint, so a plain statement is what aborts the transaction.
                var existing = await db.Orders.AsNoTracking().FirstAsync();
                try
                {
                    await db.Database.ExecuteSqlAsync($"INSERT INTO \"Orders\" (\"Id\", \"Reference\") VALUES ({existing.Id}, 'duplicate')");
                }
                catch (Npgsql.PostgresException)
                {
                    // Answered as if all were well; the transaction is now aborted.
                }

                return Results.Ok();
            }).WithSendproofPreview();
            app.MapPost("/orders/raw-commit", async (OrdersContext db) =>
            {
                // Plain ADO.NET on the provider's own connection: no driver hook guards SqlClient.
                await using var command = db.Database.GetDbConnection().CreateCommand();
                command.Transaction = db.Database.CurrentTransaction!.GetDbTransaction();
                command.CommandText = "INSERT INTO Orders (Reference) VALUES ('escaped'); COMMIT TRANSACTION; BEGIN TRANSACTION;";
                await command.ExecuteNonQueryAsync();
                return Results.Ok();
            }).WithSendproofPreview();
            app.MapPost("/orders/release", async (OrdersContext db) =>
            {
                await db.Database.CurrentTransaction!.ReleaseSavepointAsync("sendproof_check");
                return Results.NoContent();
            }).WithSendproofPreview();
            app.MapSendproof();
            await app.StartAsync();
            app.GetTestServer().PreserveExecutionContext = true;
            var client = app.GetTestClient();
            client.Timeout = TimeSpan.FromSeconds(30);
            return new SessionHost(app, client, gate);
        }

        internal async Task<string> SignInAsync(string subject)
        {
            using var response = await client.PostAsync($"/signin?subject={subject}", null);
            return response.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
        }

        internal async Task<string> OpenAsync(string? cookie)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_api/sessions");
            Authorize(request, cookie);
            using var response = await client.SendAsync(request);
            Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
            Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(body.GetProperty("idleTimeoutSeconds").GetInt32() > 0);
            return body.GetProperty("id").GetString()!;
        }

        internal Task<HttpResponseMessage> PreviewAsync(string method, string path, string? cookie, string? session, object? body = null)
        {
            var request = new HttpRequestMessage(new HttpMethod(method), "/sendproof/_preview" + path);
            request.Headers.Add("Prefer", "tx=rollback");
            if (session is not null)
            {
                request.Headers.Add("Sendproof-Session", session);
            }

            Authorize(request, cookie);
            if (body is not null)
            {
                request.Content = JsonContent.Create(body);
            }

            return client.SendAsync(request);
        }

        internal Task<HttpResponseMessage> SendAsync(string method, string path, string? cookie, object body)
        {
            var request = new HttpRequestMessage(new HttpMethod(method), path) { Content = JsonContent.Create(body) };
            Authorize(request, cookie);
            return client.SendAsync(request);
        }

        internal Task<HttpResponseMessage> RewindAsync(string? cookie, string session, int step)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, $"/sendproof/_api/sessions/{session}/rewind") { Content = JsonContent.Create(new { step }) };
            Authorize(request, cookie);
            return client.SendAsync(request);
        }

        internal Task<HttpResponseMessage> EndAsync(string? cookie, string session)
        {
            var request = new HttpRequestMessage(HttpMethod.Delete, $"/sendproof/_api/sessions/{session}");
            Authorize(request, cookie);
            return client.SendAsync(request);
        }

        private static void Authorize(HttpRequestMessage request, string? cookie)
        {
            if (cookie is not null)
            {
                request.Headers.Add("Cookie", cookie);
            }
        }

        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            await app.DisposeAsync();
        }
    }

    private sealed class SqliteDatabase : IAsyncDisposable
    {
        private readonly string _path = Path.Combine(Path.GetTempPath(), "sp_session_" + Guid.NewGuid().ToString("N") + ".db");

        internal static SqliteDatabase Create() => new();

        internal void Configure(DbContextOptionsBuilder options) => options.UseSqlite($"Data Source={_path}");

        /// <summary>Counts orders on a connection of its own, outside every session.</summary>
        internal async Task<int> CountAsync()
        {
            await using var db = new OrdersContext(new DbContextOptionsBuilder<OrdersContext>().UseSqlite($"Data Source={_path};Pooling=False").Options);
            return await db.Orders.CountAsync();
        }

        public ValueTask DisposeAsync()
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            File.Delete(_path);
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>A fresh database on a compose server, dropped afterwards.</summary>
    private sealed class ServerDatabase(Action<DbContextOptionsBuilder, string> use, string connection, Func<Task> drop) : IAsyncDisposable
    {
        internal void Configure(DbContextOptionsBuilder options) => use(options, connection);

        /// <summary>Counts orders on a connection of its own, outside every session.</summary>
        internal async Task<int> CountAsync()
        {
            var options = new DbContextOptionsBuilder<OrdersContext>();
            use(options, connection + ";Pooling=false");
            await using var db = new OrdersContext(options.Options);
            return await db.Orders.CountAsync();
        }

        public async ValueTask DisposeAsync() => await drop();

        private static string Name() => "tb_session_" + Guid.NewGuid().ToString("N")[..10];

        private static async Task AdminAsync(Action<DbContextOptionsBuilder> use, string sql)
        {
            var options = new DbContextOptionsBuilder();
            use(options);
            await using var admin = new DbContext(options.Options);
            await admin.Database.ExecuteSqlRawAsync(sql);
        }

        internal static async Task<ServerDatabase> PostgresAsync()
        {
            var name = Name();
            var admin = ServiceFactAttribute.PostgresRoot + ";Database=postgres";
            await AdminAsync(options => options.UseNpgsql(admin), $"CREATE DATABASE {name}");
            return new ServerDatabase((options, connection) => options.UseNpgsql(connection), $"{ServiceFactAttribute.PostgresRoot};Database={name}", async () =>
            {
                Npgsql.NpgsqlConnection.ClearAllPools();
                await AdminAsync(options => options.UseNpgsql(admin), $"DROP DATABASE IF EXISTS {name} WITH (FORCE)");
            });
        }

        /// <summary>MySQL or MariaDB, through Oracle's provider.</summary>
        internal static async Task<ServerDatabase> MySqlAsync(string root)
        {
            var name = Name();
            await AdminAsync(options => options.UseMySQL(root), $"CREATE DATABASE {name}");
            return new ServerDatabase((options, connection) => options.UseMySQL(connection), $"{root};database={name}", async () =>
            {
                MySql.Data.MySqlClient.MySqlConnection.ClearAllPools();
                await AdminAsync(options => options.UseMySQL(root), $"DROP DATABASE IF EXISTS {name}");
            });
        }

        internal static async Task<ServerDatabase> SqlServerAsync()
        {
            var name = Name();
            var root = ServiceFactAttribute.SqlServerRoot;
            // Without read-committed snapshot, SQL Server's reads wait on the session's uncommitted rows, as they would on any
            // open transaction's: the independent count below would block until the session ended.
            await AdminAsync(options => options.UseSqlServer(root), $"CREATE DATABASE {name}");
            await AdminAsync(options => options.UseSqlServer(root), $"ALTER DATABASE [{name}] SET READ_COMMITTED_SNAPSHOT ON");
            return new ServerDatabase((options, connection) => options.UseSqlServer(connection), $"{root};Database={name}", async () =>
            {
                Microsoft.Data.SqlClient.SqlConnection.ClearAllPools();
                await AdminAsync(options => options.UseSqlServer(root),
                    $"ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{name}]");
            });
        }
    }
}

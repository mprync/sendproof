using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace TestBench.AspNetCore.Tests;

public sealed class CaptureHttpTests
{
    private const string TraceHeader = "X-TestBench-Trace";

    [Fact]
    public async Task PreviewRecordsStructuredLogsEffectsAndTimingAtHostMinimumLevel()
    {
        await using var host = await PreviewTestHost.StartAsync();
        using var response = await CaptureAsync(host.Client, "effects", preview: true);
        response.EnsureSuccessStatusCode();
        AssertTimingHeader(response);
        var result = await ReadAsync(response);
        var logs = result.GetProperty("logs").EnumerateArray().ToArray();
        Assert.DoesNotContain(logs, log => log.GetProperty("message").GetString() == "Below configured host minimum");
        var warning = Assert.Single(logs, log => log.TryGetProperty("category", out var category) && category.GetString() == "TrackA.Scope");
        Assert.Equal("Warning", warning.GetProperty("level").GetString());
        Assert.Equal("Request effects processed 17", warning.GetProperty("message").GetString());
        Assert.Equal(42, warning.GetProperty("eventId").GetProperty("id").GetInt32());
        Assert.Equal("Scope", warning.GetProperty("eventId").GetProperty("name").GetString());
        Assert.True(warning.GetProperty("offsetMs").GetDouble() >= 0);
        var properties = warning.GetProperty("properties");
        Assert.Equal("effects", properties.GetProperty("Mode").GetString());
        Assert.Equal("17", properties.GetProperty("Total").GetString());
        Assert.False(properties.TryGetProperty("{OriginalFormat}", out _));
        var error = warning.GetProperty("exception");
        Assert.Equal("System.InvalidOperationException", error.GetProperty("type").GetString());
        Assert.Equal("Structured error", error.GetProperty("message").GetString());
        Assert.Equal(2, error.GetPropertyCount());
        Assert.Contains(logs, log => log.GetProperty("message").GetString() == "manual-effects");

        var effects = result.GetProperty("effects");
        Assert.Equal(4, effects.GetArrayLength());
        Assert.All(effects.EnumerateArray(), effect => Assert.False(effect.TryGetProperty("delivered", out _)));
        var email = Effect(effects, "email");
        Assert.Equal("sender@example.test", email.GetProperty("from").GetString());
        Assert.Equal("recipient@example.test", email.GetProperty("to")[0].GetString());
        Assert.Equal("cc@example.test", email.GetProperty("cc")[0].GetString());
        Assert.Equal("Payment created", email.GetProperty("subject").GetString());
        Assert.Equal("Text body", email.GetProperty("text").GetString());
        Assert.Equal("<p>HTML body</p>", email.GetProperty("html").GetString());
        var http = Effect(effects, "http");
        Assert.Equal("POST", http.GetProperty("method").GetString());
        Assert.Equal("https://example.test/payments", http.GetProperty("url").GetString());
        Assert.Equal(202, http.GetProperty("status").GetInt32());
        Assert.Equal(17, http.GetProperty("body").GetProperty("amount").GetInt32());
        var job = Effect(effects, "job");
        Assert.Equal("SettlePayment", job.GetProperty("name").GetString());
        Assert.Equal("payments", job.GetProperty("queue").GetString());
        Assert.Equal(DateTimeOffset.UnixEpoch, job.GetProperty("runAt").GetDateTimeOffset());
        Assert.Equal(17, job.GetProperty("arguments").GetProperty("amount").GetInt32());
        var message = Effect(effects, "message");
        Assert.Equal("payment.created", message.GetProperty("topic").GetString());
        Assert.Equal("payment-id", message.GetProperty("key").GetString());
        Assert.Equal(17, message.GetProperty("payload").GetProperty("amount").GetInt32());
    }

    [Fact]
    public async Task CaptureCapsLogsEffectsAndStringsButContinuesSuppressingPreviewEffects()
    {
        await using var host = await PreviewTestHost.StartAsync();
        using var response = await CaptureAsync(host.Client, "limits", preview: true);
        response.EnsureSuccessStatusCode();
        var result = await ReadAsync(response);
        Assert.True(result.GetProperty("logsTruncated").GetBoolean());
        var logs = result.GetProperty("logs");
        Assert.Equal(500, logs.GetArrayLength());
        Assert.All(logs.EnumerateArray(), log => Assert.InRange(log.GetProperty("message").GetString()!.Length, 1, 4096));
        var longLog = Assert.Single(logs.EnumerateArray(), log => log.GetProperty("message").GetString()!.StartsWith("Long property"));
        Assert.Equal(4096, longLog.GetProperty("properties").GetProperty("Value").GetString()!.Length);
        var manyFields = Assert.Single(logs.EnumerateArray(), log => log.GetProperty("message").GetString() == "Many fields");
        Assert.Equal(32, manyFields.GetProperty("properties").GetPropertyCount());
        Assert.True(result.GetProperty("effectsTruncated").GetBoolean());
        var effects = result.GetProperty("effects");
        Assert.Equal(100, effects.GetArrayLength());
        Assert.Equal(JsonValueKind.Null, effects[0].GetProperty("data").ValueKind);
        Assert.Equal(0, host.State.RealDispatches);
    }

    [Fact]
    public async Task ObservedSendPreservesResponseAndTraceIsReadableOnlyByItsAuthenticatedOwner()
    {
        await using var host = await PreviewTestHost.StartAsync(pathBase: true);
        var owner = await host.SignInAsync("/tenant");
        var other = await host.SignInAsync("/tenant", "different-user-with-the-same-display-name");

        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>("/tenant/bench/_api/capabilities");
        Assert.Equal(1, capabilities.GetProperty("protocolVersion").GetInt32());
        Assert.True(capabilities.GetProperty("observedSend").GetBoolean());

        using var send = PreviewTestHost.PaymentRequest("/tenant", owner, preference: "trace");
        using var response = await host.Client.SendAsync(send);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        AssertTimingHeader(response);
        Assert.Equal("live-only=1", Assert.Single(response.Headers.GetValues("Set-Cookie")));
        Assert.Equal("buffered", Assert.Single(response.Headers.GetValues("X-Started")));
        Assert.Equal("gzip", Assert.Single(response.Content.Headers.ContentEncoding));
        await using var stream = new GZipStream(await response.Content.ReadAsStreamAsync(), CompressionMode.Decompress);
        Assert.Equal(25, (await JsonSerializer.DeserializeAsync<JsonElement>(stream)).GetProperty("amount").GetInt32());
        Assert.Equal(25, host.State.CurrentAmount);
        Assert.Equal(1, host.State.RealDispatches);

        var path = TracePath(response, "/tenant");
        using var owned = await GetTraceAsync(host.Client, path, owner);
        owned.EnsureSuccessStatusCode();
        Assert.True(owned.Headers.CacheControl?.NoStore);
        var trace = await ReadAsync(owned);
        Assert.True(trace.GetProperty("effects")[0].GetProperty("delivered").GetBoolean());
        Assert.Contains(trace.GetProperty("logs").EnumerateArray(), log => log.GetProperty("message").GetString() == "Saved payment");
        Assert.Equal(0, trace.GetProperty("timing").GetProperty("queryCount").GetInt32());
        foreach (var name in new[] { "auth", "handler", "db", "serialize" })
        {
            Assert.True(trace.GetProperty("timing").GetProperty(name).GetDouble() >= 0);
        }

        using var foreign = await GetTraceAsync(host.Client, path, other);
        using var anonymous = await GetTraceAsync(host.Client, path);
        using var crossOrigin = await GetTraceAsync(host.Client, path, owner, crossOrigin: true);
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, anonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, crossOrigin.StatusCode);
        Assert.True(foreign.Headers.CacheControl?.NoStore);
    }

    [Fact]
    public async Task ConcurrentUnobservedRequestsAndDetachedWorkDoNotEnterCapture()
    {
        await using var host = await PreviewTestHost.StartAsync();
        var owner = await host.SignInAsync();
        var other = await host.SignInAsync(subject: "other");
        host.State.CaptureStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        host.State.ReleaseCapture = new(TaskCreationOptions.RunContinuationsAsynchronously);
        host.State.ReleaseLateLog = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = CaptureAsync(host.Client, "hold", cookie: owner);
        await host.State.CaptureStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            using var regular = await CaptureAsync(host.Client, "unscoped", cookie: owner, trace: false);
            Assert.False(regular.Headers.Contains(TraceHeader));
            Assert.False((await ReadAsync(regular)).GetProperty("logCaptured").GetBoolean());
            using var second = await CaptureAsync(host.Client, "second", cookie: other);
            using var secondTrace = await GetTraceAsync(host.Client, TracePath(second), other);
            Assert.Equal(new[] { "Request second processed 17", "manual-second" }, Messages(await ReadAsync(secondTrace)));
            using var nested = await CaptureAsync(host.Client, "nested", cookie: other);
            using var nestedTrace = await GetTraceAsync(host.Client, TracePath(nested), other);
            Assert.Equal(new[] { "Request nested processed 17", "manual-nested" }, Messages(await ReadAsync(nestedTrace)));
        }
        finally
        {
            host.State.ReleaseCapture.TrySetResult();
        }

        using var first = await held;
        host.State.ReleaseLateLog.TrySetResult();
        Assert.False(await host.State.LateLog!);
        using var firstTrace = await GetTraceAsync(host.Client, TracePath(first), owner);
        Assert.Equal(new[] { "Request hold processed 17", "manual-hold" }, Messages(await ReadAsync(firstTrace)));
    }

    [Fact]
    public async Task TraceRequestsThatAreIneligibleExecuteNormallyWithoutCreatingATrace()
    {
        await using var host = await PreviewTestHost.StartAsync();
        var owner = await host.SignInAsync();
        using var anonymous = await CaptureAsync(host.Client, "anonymous");
        Assert.False(anonymous.Headers.Contains(TraceHeader));
        Assert.False((await ReadAsync(anonymous)).GetProperty("logCaptured").GetBoolean());

        using var unmarked = new HttpRequestMessage(HttpMethod.Post, "/unsupported");
        unmarked.Headers.Add("Prefer", "trace");
        unmarked.Headers.Add("Cookie", owner);
        using var unmarkedResponse = await host.Client.SendAsync(unmarked);
        Assert.True(unmarkedResponse.IsSuccessStatusCode);
        Assert.False(unmarkedResponse.Headers.Contains(TraceHeader));

        using var originRequest = PreviewTestHost.PaymentRequest("", owner, preference: "trace");
        originRequest.Headers.Add("Origin", "https://other.example.test");
        using var differentOrigin = await host.Client.SendAsync(originRequest);
        Assert.Equal(HttpStatusCode.Created, differentOrigin.StatusCode);
        Assert.False(differentOrigin.Headers.Contains(TraceHeader));

        using var unauthorized = PreviewTestHost.PaymentRequest("", preference: "trace");
        using var denied = await host.Client.SendAsync(unauthorized);
        using var regular = PreviewTestHost.PaymentRequest("", preference: null);
        using var normallyDenied = await host.Client.SendAsync(regular);
        Assert.Equal(normallyDenied.StatusCode, denied.StatusCode);
        Assert.False(denied.IsSuccessStatusCode);
        Assert.False(denied.Headers.Contains(TraceHeader));
        Assert.Equal(1, host.State.RealDispatches);
    }

    [Fact]
    public async Task WorkbenchPolicyGatesCaptureWithoutChangingSendAuthorization()
    {
        await using var host = await PreviewTestHost.StartAsync(requireBenchPolicy: true, benchSubject: "allowed");
        var denied = await host.SignInAsync(subject: "denied");
        var allowed = await host.SignInAsync(subject: "allowed");
        using var ordinary = await CaptureAsync(host.Client, "policy", cookie: denied);
        ordinary.EnsureSuccessStatusCode();
        Assert.False(ordinary.Headers.Contains(TraceHeader));
        Assert.False((await ReadAsync(ordinary)).GetProperty("logCaptured").GetBoolean());

        using var observed = await CaptureAsync(host.Client, "policy", cookie: allowed);
        observed.EnsureSuccessStatusCode();
        var path = TracePath(observed);
        using var ownTrace = await GetTraceAsync(host.Client, path, allowed);
        ownTrace.EnsureSuccessStatusCode();
        using var deniedTrace = await GetTraceAsync(host.Client, path, denied);
        Assert.False(deniedTrace.IsSuccessStatusCode);
    }

    [Fact]
    public async Task TraceCacheBoundsEachOwnerAndExpiresTraces()
    {
        var clock = new TraceClock();
        await using var host = await PreviewTestHost.StartAsync(clock: clock);
        var owner = await host.SignInAsync();
        var other = await host.SignInAsync(subject: "other");
        using var first = await CaptureAsync(host.Client, "first", cookie: owner);
        using var anotherUser = await CaptureAsync(host.Client, "first", cookie: other);
        string? latest = null;
        for (var index = 0; index < 8; index++)
        {
            using var response = await CaptureAsync(host.Client, "repeat", cookie: owner);
            latest = TracePath(response);
        }

        using var evicted = await GetTraceAsync(host.Client, TracePath(first), owner);
        using var retained = await GetTraceAsync(host.Client, latest!, owner);
        using var otherRetained = await GetTraceAsync(host.Client, TracePath(anotherUser), other);
        Assert.Equal(HttpStatusCode.NotFound, evicted.StatusCode);
        Assert.Equal(HttpStatusCode.OK, retained.StatusCode);
        Assert.Equal(HttpStatusCode.OK, otherRetained.StatusCode);

        clock.Advance(TimeSpan.FromMinutes(5));
        using var expired = await GetTraceAsync(host.Client, latest!, owner);
        Assert.Equal(HttpStatusCode.NotFound, expired.StatusCode);
    }

    [Fact]
    public async Task TraceCacheBoundsTotalEntriesAcrossUsers()
    {
        await using var host = await PreviewTestHost.StartAsync();
        var firstOwner = await host.SignInAsync();
        using var first = await CaptureAsync(host.Client, "first", cookie: firstOwner);
        string? latest = null;
        string? latestOwner = null;
        for (var user = 0; user < 4; user++)
        {
            latestOwner = await host.SignInAsync(subject: $"user-{user}");
            for (var index = 0; index < 8; index++)
            {
                using var response = await CaptureAsync(host.Client, "repeat", cookie: latestOwner);
                latest = TracePath(response);
            }
        }

        using var evicted = await GetTraceAsync(host.Client, TracePath(first), firstOwner);
        using var retained = await GetTraceAsync(host.Client, latest!, latestOwner);
        Assert.Equal(HttpStatusCode.NotFound, evicted.StatusCode);
        Assert.Equal(HttpStatusCode.OK, retained.StatusCode);
    }

    private static async Task<HttpResponseMessage> CaptureAsync(HttpClient client, string mode, bool preview = false, string? cookie = null,
        bool trace = true)
    {
        var path = (preview ? "/bench/_preview" : "") + $"/capture/{mode}";
        using var request = new HttpRequestMessage(HttpMethod.Post, path);
        if (preview || trace)
        {
            request.Headers.Add("Prefer", preview ? "tx=rollback" : "trace");
        }

        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        return await client.SendAsync(request);
    }

    private static async Task<HttpResponseMessage> GetTraceAsync(HttpClient client, string path, string? cookie = null, bool crossOrigin = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (cookie is not null)
        {
            request.Headers.Add("Cookie", cookie);
        }

        if (crossOrigin)
        {
            request.Headers.Add("Sec-Fetch-Site", "cross-site");
        }

        return await client.SendAsync(request);
    }

    private static string TracePath(HttpResponseMessage response, string pathBase = "") =>
        $"{pathBase}/bench/_api/traces/{Assert.Single(response.Headers.GetValues(TraceHeader))}";

    private static Task<JsonElement> ReadAsync(HttpResponseMessage response) => response.Content.ReadFromJsonAsync<JsonElement>();

    private static JsonElement Effect(JsonElement effects, string kind) =>
        Assert.Single(effects.EnumerateArray(), effect => effect.GetProperty("kind").GetString() == kind).GetProperty("data");

    private static string?[] Messages(JsonElement trace) =>
        trace.GetProperty("logs").EnumerateArray().Select(log => log.GetProperty("message").GetString()).ToArray();

    private static void AssertTimingHeader(HttpResponseMessage response)
    {
        var timing = Assert.Single(response.Headers.GetValues("Server-Timing"));
        Assert.Matches(@"^auth;dur=\d+\.\d{3}, handler;dur=\d+\.\d{3}, db;dur=\d+\.\d{3};desc=""0 queries"", serialize;dur=\d+\.\d{3}$", timing);
    }

    private sealed class TraceClock : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => Interlocked.Read(ref _timestamp);
        internal void Advance(TimeSpan elapsed) => Interlocked.Add(ref _timestamp, elapsed.Ticks);
    }
}

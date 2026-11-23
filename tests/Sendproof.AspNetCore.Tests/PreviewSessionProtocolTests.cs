using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Sendproof.AspNetCore.Tests;

/// <summary>
/// The preview-session protocol of spec/README.md "Preview sessions", against a provider whose held transaction only
/// records what it was asked to do: discovery, limits, the step lifecycle and cleanup on shutdown.
/// </summary>
public sealed class PreviewSessionProtocolTests
{
    [Fact]
    public async Task AProviderThatCantHoldATransactionReportsNoSessions()
    {
        await using var host = await Host.StartAsync(canHold: false);
        var capabilities = await host.Client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities");
        Assert.False(capabilities.GetProperty("previewSessions").GetBoolean());
        using var opened = await host.Client.PostAsync("/sendproof/_api/sessions", null);
        Assert.Equal(HttpStatusCode.Conflict, opened.StatusCode);
        Assert.Equal("no-store", opened.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task StepsAreNumberedKeptAndEndedOnce()
    {
        await using var host = await Host.StartAsync();
        Assert.True((await host.Client.GetFromJsonAsync<JsonElement>("/sendproof/_api/capabilities")).GetProperty("previewSessions").GetBoolean());
        var id = await host.OpenAsync();
        for (var step = 1; step <= 2; step++)
        {
            using var response = await host.PreviewAsync(id);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var envelope = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(step, envelope.GetProperty("session").GetProperty("step").GetInt32());
            Assert.Equal(id, envelope.GetProperty("session").GetProperty("id").GetString());
            Assert.Equal("step", Assert.Single(envelope.GetProperty("changes").EnumerateArray()).GetProperty("table").GetString());
        }

        using var ended = await host.Client.DeleteAsync($"/sendproof/_api/sessions/{id}");
        Assert.Equal(HttpStatusCode.NoContent, ended.StatusCode);
        Assert.Equal(["hold", "begin 1", "keep", "begin 2", "keep", "end"], host.Calls);
    }

    [Fact]
    public async Task AnOwnerHasAtMostFourSessions()
    {
        await using var host = await Host.StartAsync();
        for (var count = 0; count < PreviewSessionStore.PerOwnerLimit; count++)
        {
            await host.OpenAsync();
        }

        using var refused = await host.Client.PostAsync("/sendproof/_api/sessions", null);
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal("session_limit", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        // The refused session's held transaction was rolled back at once.
        Assert.Equal(PreviewSessionStore.PerOwnerLimit + 1, host.Calls.Count(call => call == "hold"));
        Assert.Single(host.Calls, call => call == "end");
    }

    [Fact]
    public async Task HostShutdownEndsEverySession()
    {
        var host = await Host.StartAsync();
        await host.OpenAsync();
        await host.OpenAsync();
        await host.DisposeAsync();
        Assert.Equal(2, host.Calls.Count(call => call == "end"));
    }

    private sealed class Host(WebApplication app, HttpClient client, ConcurrentQueue<string> calls) : IAsyncDisposable
    {
        internal HttpClient Client => client;
        internal string[] Calls => [.. calls];

        internal static async Task<Host> StartAsync(bool canHold = true)
        {
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions
            {
                Args = ["--hostBuilder:reloadConfigOnChange=false"],
                EnvironmentName = "Development"
            });
            builder.WebHost.UseTestServer();
            builder.Logging.SetMinimumLevel(LogLevel.Critical);
            var calls = new ConcurrentQueue<string>();
            builder.Services.AddSingleton(calls);
            builder.Services.AddSendproof();
            builder.Services.AddScoped<IPreviewProvider>(_ => new HoldingProvider(calls, canHold));
            var app = builder.Build();
            app.MapPost("/things", () => Results.Created()).WithSendproofPreview();
            app.MapSendproof();
            await app.StartAsync();
            return new Host(app, app.GetTestClient(), calls);
        }

        internal async Task<string> OpenAsync()
        {
            using var response = await client.PostAsync("/sendproof/_api/sessions", null);
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        }

        internal Task<HttpResponseMessage> PreviewAsync(string id)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview/things");
            request.Headers.Add("Prefer", "tx=rollback");
            request.Headers.Add("Sendproof-Session", id);
            return client.SendAsync(request);
        }

        public async ValueTask DisposeAsync()
        {
            client.Dispose();
            await app.DisposeAsync();
        }
    }

    private sealed class HoldingProvider(ConcurrentQueue<string> calls, bool canHold) : IPreviewProvider, IPreviewSessionSource
    {
        public string? Database => "Held";

        public string? SessionUnavailableReason => canHold ? null : "This provider can't hold a transaction.";

        public ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("A session step never begins the provider's own transaction.");

        public ValueTask<IHeldPreview?> HoldAsync(HttpContext context, CancellationToken cancellationToken)
        {
            calls.Enqueue("hold");
            return ValueTask.FromResult<IHeldPreview?>(new Held(calls));
        }
    }

    private sealed class Held(ConcurrentQueue<string> calls) : IHeldPreview
    {
        public IReadOnlyList<PreviewChange> Changes { get; private set; } = [];

        public ValueTask BeginStepAsync(HttpContext context, SendproofPreview preview, int step, CancellationToken cancellationToken)
        {
            calls.Enqueue($"begin {step}");
            Changes = [];
            return ValueTask.CompletedTask;
        }

        public ValueTask KeepStepAsync(CancellationToken cancellationToken)
        {
            calls.Enqueue("keep");
            Changes = [new PreviewChange("insert", "step", null, null, null)];
            return ValueTask.CompletedTask;
        }

        public ValueTask UndoStepAsync(CancellationToken cancellationToken)
        {
            calls.Enqueue("undo");
            return ValueTask.CompletedTask;
        }

        public ValueTask RewindAsync(int step, CancellationToken cancellationToken)
        {
            calls.Enqueue($"rewind {step}");
            return ValueTask.CompletedTask;
        }

        public ValueTask EndAsync()
        {
            calls.Enqueue("end");
            return ValueTask.CompletedTask;
        }
    }
}

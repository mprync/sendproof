using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.CosmosDb;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The Cosmos DB write guard without a service (the emulator is large and Linux-only): the recorded requests of
/// spec/data-stores/recordings replay through the request handler the way the SDK's pipeline hands it a request, a write with no
/// request is refused, and a client built without the handler stops the host from starting.
/// </summary>
public sealed class CosmosDbTests
{
    /// <summary>The end of the pipeline: records what reaches it and answers 200, so nothing leaves the process.</summary>
    private sealed class Terminal : RequestHandler
    {
        internal List<RequestMessage> Sent { get; } = [];

        public override Task<ResponseMessage> SendAsync(RequestMessage request, CancellationToken cancellationToken)
        {
            lock (Sent) Sent.Add(request);
            return Task.FromResult(new ResponseMessage(HttpStatusCode.OK));
        }
    }

    public static IEnumerable<object[]> Recordings() => Spec.RecordingNames("cosmosdb");

    private static readonly System.Reflection.PropertyInfo? SdkOperationProperty = typeof(RequestMessage).GetProperty(
        "OperationType", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);

    /// <summary>
    /// A request message as the SDK would hand it to the handler. The SDK sets its internal operation type on every request, and a
    /// message built by hand would carry the enum's default (<c>Create</c>), so the replay sets the recorded one.
    /// </summary>
    private static RequestMessage Build(JsonElement http, string? sdkOperation)
    {
        var request = new RequestMessage(new HttpMethod(http.GetProperty("method").GetString()!), new Uri(http.GetProperty("path").GetString()!.TrimStart('/'), UriKind.Relative));
        foreach (var header in http.GetProperty("headers").EnumerateObject())
        {
            request.Headers.Add(header.Name, header.Value.GetString());
        }

        if (http.TryGetProperty("body", out var body))
        {
            request.Content = new MemoryStream(Encoding.UTF8.GetBytes(body.GetRawText()));
        }

        if (sdkOperation is not null && SdkOperationProperty is { } property)
        {
            // Node spells Execute where .NET says ExecuteJavaScript.
            var operation = CosmosClassifier.Classify(sdkOperation, false).Operation;
            var value = Enum.Parse(property.PropertyType, operation is "Execute" ? "ExecuteJavaScript" : operation);
            if (property.CanWrite)
            {
                property.SetValue(request, value);
            }
            else
            {
                typeof(RequestMessage).GetField("<OperationType>k__BackingField", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(request, value);
            }
        }

        return request;
    }

    /// <summary>
    /// Replays one recording through the handler inside a Preview: reads reach the end of the pipeline unchanged (as a <c>Db</c>
    /// entry with their operation), writes are refused before it and the Preview answers 409. Outside a Preview every request
    /// reaches it. The SDK-level operation type of each request classifies the same way.
    /// </summary>
    [Theory]
    [MemberData(nameof(Recordings))]
    public async Task EveryRecordedRequestIsClassifiedAsTheSpecSays(int index, string name)
    {
        var recording = Spec.Recordings("cosmosdb")[index];
        Assert.Equal(name, recording.GetProperty("name").GetString());
        var requests = recording.GetProperty("requests").EnumerateArray().ToArray();
        var expected = requests.Select(item => (Kind: item.GetProperty("expect").GetProperty("http").GetProperty("kind").GetString()!,
            Operation: item.GetProperty("expect").GetProperty("http").GetProperty("operation").GetString()!)).ToArray();

        // What an SDK-level hook would decide from the operation type and the trigger headers.
        foreach (var item in requests)
        {
            var sdk = item.GetProperty("sdk").GetProperty("operationType").GetString()!;
            var triggered = item.GetProperty("http").GetProperty("headers").EnumerateObject().Any(header => CosmosClassifier.TriggerHeaders.Contains(header.Name.ToLowerInvariant()));
            var classification = CosmosClassifier.Classify(sdk, triggered);
            Assert.Equal(item.GetProperty("expect").GetProperty("sdk").GetProperty("kind").GetString(), classification.Kind.ToString().ToLowerInvariant());
            Assert.Equal(item.GetProperty("expect").GetProperty("sdk").GetProperty("operation").GetString(), classification.Operation);
        }

        var firstWrite = expected.FirstOrDefault(item => item.Kind == "write");
        var results = new List<(string Operation, bool Blocked)>();
        var terminal = new Terminal();
        await using (var app = await StartReplayAsync(requests, terminal, results))
        {
            var response = await app.PreviewAsync("POST", "/replay");
            if (firstWrite.Operation is null)
            {
                var envelope = await Expect.ConfirmedAsync(response);
                foreach (var read in expected.Where(item => item.Kind == "read"))
                {
                    Assert.NotEmpty(Expect.DbEntries(envelope, "cosmosdb", read.Operation));
                }
            }
            else
            {
                await Expect.BlockedAsync(response, "cosmosdb", firstWrite.Operation);
            }

            Assert.Equal(expected.Length, results.Count);
            for (var i = 0; i < expected.Length; i++)
            {
                Assert.Equal(expected[i].Kind == "write", results[i].Blocked);
                Assert.Equal(expected[i].Operation, results[i].Operation);
            }

            // Only the requests that are not writes reached the end of the pipeline.
            Assert.Equal(expected.Count(item => item.Kind != "write"), terminal.Sent.Count);
        }

        var open = new Terminal();
        await using (var app = await StartReplayAsync(requests, open, []))
        {
            using var response = await app.Client.PostAsync("/replay", null);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(expected.Length, open.Sent.Count);
        }
    }

    /// <summary>
    /// Hosts a route that sends each recorded request through a handler in front of <paramref name="terminal"/>. With
    /// <paramref name="hooked"/> false there is no handler: the hook removed.
    /// </summary>
    private static Task<TestApp> StartReplayAsync(JsonElement[] requests, Terminal terminal, List<(string Operation, bool Blocked)> results, bool hooked = true) => TestApp.StartAsync(
        (services, bench) =>
        {
            if (hooked)
            {
                bench.AddCosmosDb();
            }
            else
            {
                services.AddSingleton<IPreviewDataStore>(new CosmosDbStore(bench.Capture, null, new HashSet<string>()));
            }
        }, app => app.MapPost("/replay", async (IServiceProvider services) =>
        {
            foreach (var item in requests)
            {
                RequestHandler handler = hooked ? services.GetRequiredService<CosmosDbStore>().CreateHandler() : terminal;
                if (hooked)
                {
                    handler.InnerHandler = terminal;
                }

                try
                {
                    await handler.SendAsync(Build(item.GetProperty("http"), item.GetProperty("sdk").GetProperty("operationType").GetString()), CancellationToken.None);
                    results.Add((item.GetProperty("expect").GetProperty("http").GetProperty("operation").GetString()!, false));
                }
                catch (PreviewWriteBlockedException blocked)
                {
                    results.Add((blocked.Operation, true));
                }
            }

            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview());

    [Fact]
    public async Task AQueryIsLoggedWithItsTextAndNeverItsValues()
    {
        var requests = Spec.Recordings("cosmosdb")[1].GetProperty("requests").EnumerateArray().ToArray();
        await using var app = await StartReplayAsync(requests, new Terminal(), []);
        var envelope = await Expect.ConfirmedAsync(await app.PreviewAsync("POST", "/replay"));
        var entry = Assert.Single(Expect.DbEntries(envelope, "cosmosdb", "Query"));
        Assert.Equal("SELECT * FROM c WHERE c.status = @status", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.Equal("orders", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.Equal("shop", entry.GetProperty("db").GetProperty("namespace").GetString());
        Assert.DoesNotContain("\"open\"", envelope.GetRawText());
    }

    [Fact]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: with no handler in the pipeline the writes of the same recording reach its end, so the
        // assertions "a write is refused" and "the Preview answers 409" no longer hold.
        var requests = Spec.Recordings("cosmosdb")[9].GetProperty("requests").EnumerateArray().ToArray(); // a write
        var terminal = new Terminal();
        await using var app = await StartReplayAsync(requests, terminal, [], hooked: false);
        Assert.Equal(HttpStatusCode.OK, (await app.PreviewAsync("POST", "/replay")).StatusCode);
        Assert.Equal(requests.Length, terminal.Sent.Count);
        Assert.Contains(terminal.Sent, sent => sent.Method != HttpMethod.Get);
    }

    // ---- Writes with no request, and the registration ----

    [Fact]
    public async Task AWriteWithNoRequestIsRefusedBeforeItIsSentUnlessDetached()
    {
        var gates = new Gates();
        var terminal = new Terminal();
        await using var app = await TestApp.StartAsync((_, bench) => bench.AddCosmosDb(), gates.Map);
        var store = app.Services.GetRequiredService<CosmosDbStore>();
        RequestMessage Write() => new(HttpMethod.Post, new Uri("dbs/shop/colls/orders/docs", UriKind.Relative));

        // Detached from any request while a Preview is open: refused before it is sent.
        gates.Reset();
        var pending = app.PreviewAsync("POST", "/hold");
        await gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var handler = store.CreateHandler();
        handler.InnerHandler = terminal;
        var refused = await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => Gates.Detached(() => handler.SendAsync(Write(), CancellationToken.None)));
        Assert.Equal("cosmosdb", refused.Store);
        gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "cosmosdb", "Create");
        Assert.Empty(terminal.Sent);

        // Detached work is never refused.
        gates.Reset();
        pending = app.PreviewAsync("POST", "/hold");
        await gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Gates.Detached(async () =>
        {
            using var _ = DetachedWork.Begin();
            await handler.SendAsync(Write(), CancellationToken.None);
        });
        gates.Release.SetResult();
        await Expect.ConfirmedAsync(await pending);
        Assert.Single(terminal.Sent);
    }

    private static CosmosClient NewClient(CosmosClientOptions options) =>
        new("https://fake.documents.azure.com:443/", Convert.ToBase64String(Encoding.UTF8.GetBytes("bench-key-bench-key-bench-key-xx")), options);

    [Fact]
    public async Task AClientBuiltWithoutTheGuardStopsTheHostFromStartingAndOneBuiltWithItStarts()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync((services, bench) =>
        {
            bench.AddCosmosDb();
            services.AddSingleton(_ => NewClient(new CosmosClientOptions()));
        }, _ => { }));
        Assert.Contains("built without the Sendproof guard", error.Message);

        await using var app = await TestApp.StartAsync((services, bench) =>
        {
            bench.AddCosmosDb(cosmos => cosmos.WithName("orders"));
            services.AddSingleton(provider => NewClient(new CosmosClientOptions().WithSendproofGuard(provider)));
        }, _ => { });
        var capabilities = await app.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("cosmosdb", "orders", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
    }
}

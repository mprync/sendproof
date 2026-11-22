using System.Net;
using System.Text.Json;
using Google.Cloud.Firestore;
using Google.Cloud.Firestore.V1;
using Google.Protobuf;
using Grpc.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.Firestore;
using Xunit;
using GrpcFirestore = Google.Cloud.Firestore.V1.Firestore;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The Firestore write guard over a fake gRPC transport: the recorded requests of spec/data-stores/recordings replay through
/// the interceptor (unary, streaming and duplex calls alike), a real <c>FirestoreDb</c> is refused before it sends, and the
/// same writes reach the transport when the hook is removed. Firestore has no compose service.
/// </summary>
public sealed class FirestoreTests
{
    /// <summary>A gRPC transport that records every call and answers each with an empty reply, so nothing leaves the process.</summary>
    internal sealed class FakeInvoker : CallInvoker
    {
        internal List<(string Method, IMessage? Request)> Calls { get; } = [];

        internal IEnumerable<string> Methods => Calls.Select(call => call.Method.Split('/')[^1]);

        private void Record<TRequest>(string method, TRequest? request)
        {
            lock (Calls) Calls.Add((method, request as IMessage));
        }

        private static TResponse Reply<TRequest, TResponse>(TRequest request) => request switch
        {
            // The SDK reads one write result per write it sent.
            CommitRequest commit => (TResponse)(object)new CommitResponse
            {
                CommitTime = Google.Protobuf.WellKnownTypes.Timestamp.FromDateTime(DateTime.UtcNow),
                WriteResults = { commit.Writes.Select(_ => new Google.Cloud.Firestore.V1.WriteResult { UpdateTime = Google.Protobuf.WellKnownTypes.Timestamp.FromDateTime(DateTime.UtcNow) }) }
            },
            BeginTransactionRequest => (TResponse)(object)new BeginTransactionResponse { Transaction = ByteString.CopyFromUtf8("tx") },
            _ => Activator.CreateInstance<TResponse>()
        };

        // A document read answers "missing" for every document asked for, as an empty database would.
        private static IEnumerable<TResponse> Stream<TRequest, TResponse>(TRequest request) => request is BatchGetDocumentsRequest batch
            ? batch.Documents.Select(name => (TResponse)(object)new BatchGetDocumentsResponse
            {
                Missing = name,
                ReadTime = Google.Protobuf.WellKnownTypes.Timestamp.FromDateTime(DateTime.UtcNow)
            })
            : [];

        public override TResponse BlockingUnaryCall<TRequest, TResponse>(Method<TRequest, TResponse> method, string? host, CallOptions options, TRequest request)
        {
            Record(method.FullName, request);
            return Reply<TRequest, TResponse>(request);
        }

        public override AsyncUnaryCall<TResponse> AsyncUnaryCall<TRequest, TResponse>(Method<TRequest, TResponse> method, string? host, CallOptions options, TRequest request)
        {
            Record(method.FullName, request);
            return new AsyncUnaryCall<TResponse>(Task.FromResult(Reply<TRequest, TResponse>(request)), Task.FromResult(new Metadata()), () => Status.DefaultSuccess, () => [], () => { });
        }

        public override AsyncServerStreamingCall<TResponse> AsyncServerStreamingCall<TRequest, TResponse>(Method<TRequest, TResponse> method, string? host, CallOptions options, TRequest request)
        {
            Record(method.FullName, request);
            return new AsyncServerStreamingCall<TResponse>(new ListReader<TResponse>(Stream<TRequest, TResponse>(request)), Task.FromResult(new Metadata()), () => Status.DefaultSuccess, () => [], () => { });
        }

        public override AsyncClientStreamingCall<TRequest, TResponse> AsyncClientStreamingCall<TRequest, TResponse>(Method<TRequest, TResponse> method, string? host, CallOptions options)
        {
            Record<TRequest>(method.FullName, default);
            return new AsyncClientStreamingCall<TRequest, TResponse>(new Writer<TRequest>(), Task.FromResult(Activator.CreateInstance<TResponse>()), Task.FromResult(new Metadata()), () => Status.DefaultSuccess, () => [], () => { });
        }

        public override AsyncDuplexStreamingCall<TRequest, TResponse> AsyncDuplexStreamingCall<TRequest, TResponse>(Method<TRequest, TResponse> method, string? host, CallOptions options)
        {
            Record<TRequest>(method.FullName, default);
            return new AsyncDuplexStreamingCall<TRequest, TResponse>(new Writer<TRequest>(), new EmptyReader<TResponse>(), Task.FromResult(new Metadata()), () => Status.DefaultSuccess, () => [], () => { });
        }

        private sealed class ListReader<T>(IEnumerable<T> items) : IAsyncStreamReader<T>
        {
            private readonly IEnumerator<T> _items = items.GetEnumerator();

            public T Current => _items.Current;

            public Task<bool> MoveNext(CancellationToken cancellationToken) => Task.FromResult(_items.MoveNext());
        }

        private sealed class EmptyReader<T> : IAsyncStreamReader<T>
        {
            public T Current => default!;

            public Task<bool> MoveNext(CancellationToken cancellationToken) => Task.FromResult(false);
        }

        private sealed class Writer<T> : IClientStreamWriter<T>
        {
            public WriteOptions? WriteOptions { get; set; }

            public Task WriteAsync(T message) => Task.CompletedTask;

            public Task CompleteAsync() => Task.CompletedTask;
        }
    }

    private static FirestoreDb NewDb(FakeInvoker transport) =>
        FirestoreDb.Create("bench", new FirestoreClientBuilder { CallInvoker = transport }.Build());

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required FakeInvoker Transport { get; init; }
        internal required Gates Gates { get; init; }

        /// <summary><paramref name="hooked"/> false is the hook removed: the store is listed so a Preview can run, but the database is the raw one.</summary>
        internal static async Task<Fixture> StartAsync(bool hooked = true, Action<IServiceCollection, SendproofBuilder>? after = null)
        {
            var transport = new FakeInvoker();
            var gates = new Gates();
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton(NewDb(transport));
                if (hooked)
                {
                    bench.AddFirestore(firestore => firestore.WithName("orders"));
                }
                else
                {
                    services.AddSingleton<IPreviewDataStore>(new FirestoreStore(bench.Capture, "orders", new HashSet<string>()));
                }

                after?.Invoke(services, bench);
            }, app =>
            {
                Map(app);
                gates.Map(app);
            });
            return new Fixture { App = app, Transport = transport, Gates = gates };
        }

        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private static void Map(WebApplication app)
    {
        app.MapGet("/orders/{id}", async (string id, FirestoreDb db) =>
        {
            var snapshot = await db.Collection("orders").Document(id).GetSnapshotAsync();
            return snapshot.Exists ? Results.Ok() : Results.NotFound();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}", async (string id, FirestoreDb db) =>
        {
            await db.Collection("orders").Document(id).SetAsync(new Dictionary<string, object> { ["status"] = "new", ["hits"] = 1 });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/batch", async (string id, FirestoreDb db) =>
        {
            var batch = db.StartBatch();
            batch.Set(db.Collection("orders").Document(id), new Dictionary<string, object> { ["status"] = "new" });
            await batch.CommitAsync();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/transaction", async (string id, FirestoreDb db) =>
        {
            // A read-write transaction: its reads and BeginTransaction run, the Commit that carries a write is refused.
            await db.RunTransactionAsync(async transaction =>
            {
                await transaction.GetSnapshotAsync(db.Collection("orders").Document(id));
                transaction.Set(db.Collection("orders").Document(id), new Dictionary<string, object> { ["status"] = "closed" });
            });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/readonly-tx", async (string id, FirestoreDb db) =>
        {
            await db.RunTransactionAsync(async transaction => await transaction.GetSnapshotAsync(db.Collection("orders").Document(id)));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/bulk", async (string id, FirestoreDb db) =>
        {
            // The .NET library has no BulkWriter; the bulk RPC is BatchWrite, which is refused like any other write.
            var request = new BatchWriteRequest { Database = "projects/bench/databases/(default)" };
            request.Writes.Add(new Google.Cloud.Firestore.V1.Write { Delete = $"projects/bench/databases/(default)/documents/orders/{id}" });
            await db.Client.BatchWriteAsync(request);
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/stream", (string id, FirestoreDb db) =>
        {
            // The Write RPC is a bidirectional stream: it must be refused before its first message.
            using var call = db.Client.GrpcClient.Write();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/orders/{id}/catch", async (string id, FirestoreDb db) =>
        {
            try { await db.Collection("orders").Document(id).DeleteAsync(); } catch (PreviewWriteBlockedException) { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
    }

    // ---- Recordings ----

    public static IEnumerable<object[]> Recordings() => Spec.RecordingNames("firestore");

    private static IMessage Parse(string rpc, JsonElement rest)
    {
        var text = rest.TryGetProperty("body", out var body) ? body.GetRawText() : "{}";
        var parser = new JsonParser(JsonParser.Settings.Default.WithIgnoreUnknownFields(true));
        return rpc.Split('/')[^1] switch
        {
            "BatchGetDocuments" => parser.Parse<BatchGetDocumentsRequest>(text),
            "RunQuery" => parser.Parse<RunQueryRequest>(text),
            "RunAggregationQuery" => parser.Parse<RunAggregationQueryRequest>(text),
            "ListCollectionIds" => parser.Parse<ListCollectionIdsRequest>(text),
            "ListDocuments" => new ListDocumentsRequest { Parent = "projects/bench/databases/(default)/documents", CollectionId = "orders" },
            "Commit" => parser.Parse<CommitRequest>(text),
            "BatchWrite" => parser.Parse<BatchWriteRequest>(text),
            "BeginTransaction" => parser.Parse<BeginTransactionRequest>(text),
            "Rollback" => parser.Parse<RollbackRequest>(text),
            var other => throw new NotSupportedException($"The replay has no request type for {other}.")
        };
    }

    private static async Task Send(GrpcFirestore.FirestoreClient grpc, IMessage request)
    {
        switch (request)
        {
            case BatchGetDocumentsRequest r: using (grpc.BatchGetDocuments(r)) { } break;
            case RunQueryRequest r: using (grpc.RunQuery(r)) { } break;
            case RunAggregationQueryRequest r: using (grpc.RunAggregationQuery(r)) { } break;
            case ListCollectionIdsRequest r: await grpc.ListCollectionIdsAsync(r); break;
            case ListDocumentsRequest r: await grpc.ListDocumentsAsync(r); break;
            case CommitRequest r: await grpc.CommitAsync(r); break;
            case BatchWriteRequest r: await grpc.BatchWriteAsync(r); break;
            case BeginTransactionRequest r: await grpc.BeginTransactionAsync(r); break;
            case RollbackRequest r: await grpc.RollbackAsync(r); break;
            default: throw new NotSupportedException(request.GetType().Name);
        }
    }

    /// <summary>
    /// Replays every request of one recording through the interceptor inside a Preview: a read or session request reaches the
    /// transport unchanged (a read as a <c>Db</c> entry with its operation), and a write is refused before it is sent, so the
    /// Preview answers 409. Outside a Preview every request reaches the transport, writes included.
    /// </summary>
    [Theory]
    [MemberData(nameof(Recordings))]
    public async Task EveryRecordedRequestIsClassifiedAsTheSpecSays(int index, string name)
    {
        var recording = Spec.Recordings("firestore")[index];
        Assert.Equal(name, recording.GetProperty("name").GetString());
        var requests = recording.GetProperty("requests").EnumerateArray().ToArray();
        var expected = requests.Select(item => (Rpc: item.GetProperty("rpc").GetString()!, Kind: item.GetProperty("expect").GetProperty("kind").GetString()!,
            Operation: item.GetProperty("expect").GetProperty("operation").GetString()!, Message: Parse(item.GetProperty("rpc").GetString()!, item.GetProperty("rest")))).ToArray();

        var firstWrite = expected.FirstOrDefault(item => item.Kind == "write");

        // In a Preview, through a route that replays the recording on the guarded client.
        var results = new List<(string Operation, bool Blocked)>();
        using (var host = await StartReplayHostAsync(expected.Select(item => item.Message).ToArray(), results))
        {
            var response = await host.App.PreviewAsync("POST", "/replay");
            if (firstWrite.Operation is null)
            {
                var envelope = await Expect.ConfirmedAsync(response);
                foreach (var read in expected.Where(item => item.Kind == "read"))
                {
                    Assert.NotEmpty(Expect.DbEntries(envelope, "firestore", read.Operation));
                }
            }
            else
            {
                await Expect.BlockedAsync(response, "firestore", firstWrite.Operation);
            }

            for (var i = 0; i < expected.Length; i++)
            {
                var wrote = expected[i].Kind == "write";
                Assert.Equal(wrote, results[i].Blocked);
                Assert.Equal(expected[i].Operation, results[i].Operation);
                Assert.Equal(!wrote, host.Transport.Methods.Contains(expected[i].Operation) && host.Transport.Calls.Any(call => call.Request is { } sent && sent.Equals(expected[i].Message)));
            }

            // A session or read request reached the transport as the SDK sent it; no refused write did.
            Assert.DoesNotContain(host.Transport.Calls, call => expected.Any(item => item.Kind == "write" && call.Request is { } sent && sent.Equals(item.Message)));
        }

        // Outside a Preview nothing is refused: a plain request reaches the transport, writes included.
        using (var host = await StartReplayHostAsync(expected.Select(item => item.Message).ToArray(), []))
        {
            using var response = await host.App.Client.PostAsync("/replay", null);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(expected.Length, host.Transport.Calls.Count);
        }
    }

    private sealed class ReplayHost(TestApp app, FakeInvoker transport) : IDisposable
    {
        internal TestApp App => app;
        internal FakeInvoker Transport => transport;

        public void Dispose() => app.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    private static async Task<ReplayHost> StartReplayHostAsync(IMessage[] requests, List<(string Operation, bool Blocked)> results)
    {
        var transport = new FakeInvoker();
        var app = await TestApp.StartAsync((services, bench) =>
        {
            services.AddSingleton(NewDb(transport));
            bench.AddFirestore();
        }, app => app.MapPost("/replay", async (FirestoreDb db) =>
        {
            foreach (var request in requests)
            {
                var operation = request.Descriptor.Name.Replace("Request", "");
                try
                {
                    await Send(db.Client.GrpcClient, request);
                    results.Add((operation, false));
                }
                catch (PreviewWriteBlockedException blocked)
                {
                    results.Add((blocked.Operation, true));
                }
            }

            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview());
        return new ReplayHost(app, transport);
    }

    // ---- A real FirestoreDb ----

    [Fact]
    public async Task AReadRunsAndIsLoggedWithTheCollectionAndNoValues()
    {
        await using var f = await Fixture.StartAsync();
        var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/orders/seeded"));
        var entry = Assert.Single(Expect.DbEntries(envelope, "firestore", "BatchGetDocuments"));
        Assert.Equal("orders", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.DoesNotContain("seeded", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.Contains("BatchGetDocuments", f.Transport.Methods);
    }

    [Theory]
    [InlineData("POST", "/orders/blocked", "Commit")]
    [InlineData("POST", "/orders/blocked/batch", "Commit")]
    [InlineData("POST", "/orders/blocked/transaction", "Commit")]
    [InlineData("POST", "/orders/blocked/bulk", "BatchWrite")]
    [InlineData("POST", "/orders/blocked/stream", "Write")]
    [InlineData("POST", "/orders/blocked/catch", "Commit")]
    public async Task EveryWritePathIsRefusedBeforeItIsSent(string method, string path, string operation)
    {
        await using var f = await Fixture.StartAsync();
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync(method, path), "firestore", operation);
        Assert.Equal("Preview unavailable: this operation writes to Firestore", problem.GetProperty("detail").GetString());
        Assert.DoesNotContain(f.Transport.Methods, name => name is "Commit" or "BatchWrite" or "Write");
    }

    [Fact]
    public async Task ATransactionThatOnlyReadsIsAllowedBecauseItsEmptyCommitChangesNothing()
    {
        await using var f = await Fixture.StartAsync();
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/orders/reader/readonly-tx"));
        Assert.Contains("BeginTransaction", f.Transport.Methods);
        Assert.Contains("Commit", f.Transport.Methods);
    }

    [Fact]
    public async Task ADerivedDatabaseStaysGuardedAndGuardingTwiceChangesNothing()
    {
        await using var f = await Fixture.StartAsync();
        var store = f.App.Services.GetRequiredService<FirestoreStore>();
        var registered = f.App.Services.GetRequiredService<FirestoreDb>();
        Assert.Same(registered, store.Guard(registered));
        // A guarded invoker built from the raw one: its calls pass through the same interceptor.
        var other = store.Guard(NewDb(new FakeInvoker()));
        Assert.NotNull(other);
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/orders/derived/batch"), "firestore", "Commit");
    }

    [Fact]
    public async Task ARegistrationAfterAddFirestoreStopsTheHostFromStarting()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Fixture.StartAsync(after: (services, _) => services.AddSingleton(NewDb(new FakeInvoker()))));
        Assert.Contains("registered again after AddFirestore", error.Message);
        await Assert.ThrowsAsync<InvalidOperationException>(() => TestApp.StartAsync((_, bench) => bench.AddFirestore(), _ => { }));
    }

    [Fact]
    public async Task AWriteWithNoRequestIsRefusedBeforeItIsSentAndBlocksTheOpenPreviewUnlessDetached()
    {
        await using var f = await Fixture.StartAsync();
        var db = f.App.Services.GetRequiredService<FirestoreDb>();

        // A background writer (a BulkWriter's timer thread, a spawned task) that lost the request context, while a Preview is open.
        f.Gates.Reset();
        var pending = f.App.PreviewAsync("POST", "/hold");
        await f.Gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var refused = await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => Gates.Detached(() => db.Collection("orders").Document("bg").SetAsync(new Dictionary<string, object> { ["a"] = 1 })));
        Assert.Equal("firestore", refused.Store);
        f.Gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "firestore", "Commit");
        Assert.DoesNotContain("Commit", f.Transport.Methods);

        // Detached work is never refused, and leaves the Preview alone.
        f.Gates.Reset();
        pending = f.App.PreviewAsync("POST", "/hold");
        await f.Gates.Open.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Gates.Detached(async () =>
        {
            using var _ = DetachedWork.Begin();
            await db.Collection("orders").Document("job").SetAsync(new Dictionary<string, object> { ["a"] = 1 });
        });
        f.Gates.Release.SetResult();
        await Expect.ConfirmedAsync(await pending);
        Assert.Contains("Commit", f.Transport.Methods);
    }

    [Fact]
    public async Task ObservedSendWritesOnceAndTracesTheCommit()
    {
        await using var f = await Fixture.StartAsync();
        var (response, trace) = await f.App.ObservedAsync("POST", "/orders/sent");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(Expect.DbEntries(trace, "firestore", "Commit"));
        Assert.Single(f.Transport.Methods, name => name == "Commit");
    }

    [Fact]
    public async Task TheGuardChecksFailWhenTheHookIsRemoved()
    {
        // The negative test: without AddFirestore the same writes are sent and the Preview is "confirmed".
        await using var f = await Fixture.StartAsync(hooked: false);
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/orders/unhooked")).StatusCode);
        Assert.Contains("Commit", f.Transport.Methods);
        Assert.Equal(HttpStatusCode.OK, (await f.App.PreviewAsync("POST", "/orders/unhooked/stream")).StatusCode);
        Assert.Contains("Write", f.Transport.Methods);
    }

    [Fact]
    public async Task DiscoveryListsFirestoreInGuardMode()
    {
        await using var f = await Fixture.StartAsync();
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("firestore", "orders", "guard"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
    }
}

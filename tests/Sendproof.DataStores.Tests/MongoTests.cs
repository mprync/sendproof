using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using global::MongoDB.Bson;
using global::MongoDB.Driver;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;
using Sendproof.MongoDB;
using Xunit;

namespace Sendproof.DataStores.Tests;

/// <summary>
/// The MongoDB hook against a real replica set (compose service): transactions that are aborted after the handler, document
/// changes captured at the transaction's snapshot time, the escape tripwire, the guarded handles and guard mode.
/// </summary>
public sealed class MongoTests
{
    private sealed class Gates
    {
        internal TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        /// <summary>Runs at the end of <c>/lost-abort</c>, after its write.</summary>
        internal Action? AfterWrite;

        internal void Reset()
        {
            Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
            Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required TestApp App { get; init; }
        internal required IMongoClient Raw { get; init; }
        internal required string Database { get; init; }
        internal required Gates Gates { get; set; }
        internal MongoEngine Engine => App.Services.GetServices<IPreviewDataStore>().OfType<MongoStore>().Single().Engine;
        internal IMongoCollection<BsonDocument> Documents => Raw.GetDatabase(Database).GetCollection<BsonDocument>("documents");

        /// <param name="url">The server the app's client reaches; the fixture's own raw client always reaches the compose one.</param>
        /// <param name="settings">Changes the settings of the app's client.</param>
        internal static async Task<Fixture> StartAsync(TimeSpan? timeout = null, Func<Task<BsonDocument>>? hello = null, Action<MongoStoreBuilder>? configure = null, bool monitored = true,
            string? url = null, Action<MongoClientSettings>? settings = null)
        {
            var database = Services.Fresh("tb");
            var raw = new MongoClient(Services.MongoUrl);
            var gates = new Gates();
            var app = await TestApp.StartAsync((services, bench) =>
            {
                services.AddSingleton<IMongoClient>(_ =>
                {
                    var own = MongoClientSettings.FromConnectionString(url ?? Services.MongoUrl);
                    settings?.Invoke(own);
                    return new MongoClient(own);
                });
                bench.AddMongoDB(mongo =>
                {
                    mongo.WithName("catalog");
                    if (timeout is { } limit)
                    {
                        mongo.WithPreviewTimeout(limit);
                    }

                    configure?.Invoke(mongo);
                    if (!monitored)
                    {
                        mongo.WithoutMonitoringForTests();
                    }
                });
            }, app => Map(app, database, raw, gates));
            var fixture = new Fixture { App = app, Raw = raw, Database = database, Gates = gates };
            if (hello is not null)
            {
                fixture.Engine.HelloOverride = hello;
            }

            return fixture;
        }

        internal async Task SeedAsync()
        {
            await Documents.InsertOneAsync(new BsonDocument { { "_id", "seeded" }, { "name", "Seeded" }, { "profile", new BsonDocument("city", "Leeds") }, { "password_hash", "hashed:seeded-secret" } });
        }

        internal async Task<BsonDocument?> FindAsync(string id) => await (await Documents.FindAsync(new BsonDocument("_id", id))).FirstOrDefaultAsync();

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync();
            await Raw.DropDatabaseAsync(Database);
            Raw.Dispose();
        }
    }

    private static IMongoCollection<BsonDocument> Documents(IMongoClient client, string database) =>
        client.GetDatabase(database).GetCollection<BsonDocument>("documents");

    private static object Shape(BsonDocument document) => new
    {
        id = document["_id"].AsString, name = document["name"].AsString,
        city = document.GetValue("profile", new BsonDocument()).AsBsonDocument.GetValue("city", BsonNull.Value).IsBsonNull ? null : document["profile"]["city"].AsString
    };

    private static void Map(WebApplication app, string database, IMongoClient raw, Gates gates)
    {
        app.MapGet("/documents/{id}", async (string id, IMongoClient client) =>
            await (await Documents(client, database).FindAsync(new BsonDocument("_id", id))).FirstOrDefaultAsync() is { } document
                ? Results.Ok(Shape(document)) : Results.NotFound()).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/documents", async (CreateInput input, IMongoClient client) =>
        {
            var document = new BsonDocument
            {
                { "_id", input.Id }, { "name", input.Name }, { "profile", new BsonDocument { { "city", input.City }, { "apiKey", "k-" + input.Id } } },
                { "password_hash", "hashed:" + input.Password }, { "createdAt", new BsonDateTime(DateTime.UnixEpoch.AddDays(20000)) }
            };
            await Documents(client, database).InsertOneAsync(document);
            return Results.Created("/documents/" + input.Id, Shape(document));
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPatch("/documents/{id}", async (string id, PatchInput input, IMongoClient client) =>
        {
            var update = Builders<BsonDocument>.Update.Set("name", input.Name).Set("profile.city", input.City);
            var result = await Documents(client, database).UpdateOneAsync(new BsonDocument("_id", id), update);
            if (result.MatchedCount == 0) return Results.NotFound();
            return Results.Ok(Shape(await (await Documents(client, database).FindAsync(new BsonDocument("_id", id))).FirstAsync()));
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/documents/{id}/upsert", async (string id, IMongoClient client) =>
        {
            await Documents(client, database).UpdateOneAsync(new BsonDocument("_id", id),
                Builders<BsonDocument>.Update.Set("name", "Upserted"), new UpdateOptions { IsUpsert = true });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPut("/documents/{id}", async (string id, IMongoClient client) =>
        {
            await Documents(client, database).ReplaceOneAsync(new BsonDocument("_id", id), new BsonDocument { { "_id", id }, { "name", "Replaced" } });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/documents/{id}/remove", async (string id, IMongoClient client) =>
        {
            await Documents(client, database).DeleteOneAsync(new BsonDocument("_id", id));
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapDelete("/documents/{id}", async (string id, IMongoClient client) =>
        {
            await Documents(client, database).DeleteOneAsync(new BsonDocument("_id", id));
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview(enabled: false, reason: "Preview unavailable: this operation writes to MongoDB", "mongodb");

        app.MapPost("/documents/archive", async (IMongoClient client) =>
        {
            var pipeline = PipelineDefinition<BsonDocument, BsonDocument>.Create(
                new BsonDocument("$match", new BsonDocument()), new BsonDocument("$out", "documents_archive"));
            await (await Documents(client, database).AggregateAsync(pipeline)).ToListAsync();
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/documents/archive-fluent", async (IMongoClient client) =>
        {
            // The stage is added through the builder, after Aggregate() returned: it is checked when the pipeline runs.
            await Documents(client, database).Aggregate().Match(new BsonDocument()).Out("documents_archive").ToListAsync();
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/documents/archive-deep", async (IMongoClient client) =>
        {
            var pipeline = PipelineDefinition<BsonDocument, BsonDocument>.Create(new BsonDocument("$facet", new BsonDocument("a",
                new BsonArray { new BsonDocument("$match", new BsonDocument()), new BsonDocument("$merge", new BsonDocument("into", "documents_archive")) })));
            await (await Documents(client, database).AggregateAsync(pipeline)).ToListAsync();
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/explicit-create", async (IMongoClient client) =>
        {
            await client.GetDatabase(database).CreateCollectionAsync("made");
            return Results.NoContent();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/count", async (IMongoClient client) => Results.Ok(new { count = await Documents(client, database).EstimatedDocumentCountAsync() })).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/list-indexes", async (IMongoClient client) =>
        {
            await (await Documents(client, database).Indexes.ListAsync()).ToListAsync();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();

        app.MapPost("/escape", async (IEnumerable<IPreviewDataStore> stores) =>
        {
            // Sent around the guarded handles, to the instrumented client: command monitoring sees a write without the
            // Preview's session, which nothing can undo, so the Preview can never be confirmed.
            var engine = stores.OfType<MongoStore>().Single().Engine;
            await Documents(engine.Client, database).InsertOneAsync(new BsonDocument("_id", "escaped"));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/foreign-session", async (IMongoClient client) =>
        {
            using var own = await raw.StartSessionAsync();
            try { await Documents(client, database).InsertOneAsync(own, new BsonDocument("_id", "foreign")); } catch (PreviewTransactionControlException) { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/commit", async (string swallow, IMongoClient client) =>
        {
            using var session = await client.StartSessionAsync();
            await Documents(client, database).InsertOneAsync(session, new BsonDocument("_id", "committed"));
            try { await session.CommitTransactionAsync(); } catch (PreviewTransactionControlException) when (swallow == "yes") { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/fork-commit", async (string how, IMongoClient client) =>
        {
            // Handler code must never get hold of the real session, however it asks for it.
            using var session = await client.StartSessionAsync();
            await Documents(client, database).InsertOneAsync(session, new BsonDocument("_id", "forked"));
            try
            {
                if (how == "fork") session.Fork().CommitTransaction();
                else session.WrappedCoreSession.CommitTransaction(CancellationToken.None);
            }
            catch (PreviewTransactionControlException) { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/with-transaction", async (IMongoClient client) =>
        {
            using var session = await client.StartSessionAsync();
            await session.WithTransactionAsync(async (inner, token) =>
            {
                await Documents(client, database).InsertOneAsync(inner, new BsonDocument { { "_id", "txn" }, { "name", "Joined" } }, cancellationToken: token);
                return 1;
            });
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/snapshot", async (IMongoClient client) =>
        {
            var documents = Documents(client, database);
            await (await documents.FindAsync(new BsonDocument("_id", "seeded"))).FirstOrDefaultAsync();
            gates.Started.TrySetResult();
            await gates.Release.Task.WaitAsync(TimeSpan.FromSeconds(20));
            await documents.UpdateManyAsync(new BsonDocument(), Builders<BsonDocument>.Update.Set("touched", true));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/slow", async (int delay, string swallow, IMongoClient client) =>
        {
            var documents = Documents(client, database);
            await documents.InsertOneAsync(new BsonDocument("_id", "slow-1"));
            await Task.Delay(delay);
            try { await documents.InsertOneAsync(new BsonDocument("_id", "slow-2")); } catch (Exception) when (swallow == "yes") { }
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/conflict/{who}", async (string who, IMongoClient client) =>
        {
            var documents = Documents(client, database);
            try
            {
                await documents.UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Set("name", "By " + who));
            }
            catch (MongoCommandException error)
            {
                return Results.Ok(new { error = error.CodeName });
            }

            if (who == "first")
            {
                gates.Started.TrySetResult();
                await gates.Release.Task.WaitAsync(TimeSpan.FromSeconds(20));
            }

            return Results.Ok(new { error = (string?)null });
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/redetect", async (IEnumerable<IPreviewDataStore> stores, IMongoClient client) =>
        {
            // Detection succeeds in the middle of a Preview that began without it: the Preview keeps its own mode.
            await stores.OfType<MongoStore>().Single().DescribeAsync(CancellationToken.None);
            await Documents(client, database).InsertOneAsync(new BsonDocument("_id", "redetected"));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/derived/{via}", async (string via, IMongoClient client) =>
        {
            // Handles that come back from the guarded ones, with other options or through a back-reference, stay guarded.
            using var session = await client.StartSessionAsync();
            var derived = via switch
            {
                "session" => session.Client,
                "read-preference" => client.WithReadPreference(ReadPreference.Primary),
                "write-concern" => client.WithWriteConcern(WriteConcern.WMajority),
                "read-concern" => client.WithReadConcern(ReadConcern.Majority),
                _ => client.GetDatabase(database).Client
            };
            await Documents(derived, database).InsertOneAsync(new BsonDocument("_id", "derived-" + via));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/hang", async (IMongoClient client, HttpContext context) =>
        {
            // Holds the Preview transaction, with an uncommitted insert, until the client goes away.
            await Documents(client, database).InsertOneAsync(new BsonDocument("_id", "hung"));
            gates.Started.TrySetResult();
            await Task.Delay(Timeout.Infinite, context.RequestAborted);
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/nothing", () => Results.Ok()).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/lost-abort", async (IMongoClient client) =>
        {
            await Documents(client, database).UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Inc("n", 1));
            gates.AfterWrite?.Invoke();
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/gridfs", async (IMongoClient client) =>
        {
            // GridFS sends its commands through the cluster directly, never through a collection handle.
            await new global::MongoDB.Driver.GridFS.GridFSBucket(client.GetDatabase(database)).UploadFromBytesAsync("file.txt", [1, 2, 3]);
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
        app.MapPost("/unguarded", async () =>
        {
            // A client the hook never saw: not covered, so the write is neither blocked nor rolled back.
            await Documents(raw, database).InsertOneAsync(new BsonDocument("_id", "unguarded"));
            return Results.Ok();
        }).AllowAnonymous().WithSendproofPreview();
    }

    private sealed record CreateInput(string Id, string Name, string City, string Password);

    private sealed record PatchInput(string Name, string City);

    private static JsonElement[] Changes(JsonElement envelope, string? operation = null) =>
        [.. envelope.GetProperty("changes").EnumerateArray().Where(change => change.GetProperty("store").GetString() == "mongodb" &&
            (operation is null || change.GetProperty("operation").GetString() == operation))];

    private static readonly CreateInput NewDocument = new("preview-doc", "Draft", "York", "mongo-secret-value");

    // ---- Classification ----

    [Fact]
    public void ClassifierPassesEverySharedVector()
    {
        var spec = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "spec", "data-stores", "classification-cases.json");
        var cases = JsonNode.Parse(File.ReadAllText(Path.GetFullPath(spec)))!["mongodb"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var vector in cases)
        {
            var command = BsonDocument.Parse(vector!["command"]!.ToJsonString());
            var actual = MongoClassifier.Classify(command);
            Assert.True(string.Equals(actual.Kind.ToString(), vector["expect"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase),
                $"{command.ToJson()}: expected {vector["expect"]}, got {actual.Kind}");
            Assert.Equal(vector["refusedInTransaction"]?.GetValue<string>(), actual.RefusedInTransaction);
        }
    }

    [Fact]
    public void HostDeclaredReadsAreMatchedInLowerCaseByExactName()
    {
        var reads = DataStoreGuard.ReadSet(["myReadCommand"], name => name.ToLowerInvariant());
        Assert.Equal(CommandKind.Write, MongoClassifier.Classify(new BsonDocument("myReadCommand", 1)).Kind);
        Assert.Equal(CommandKind.Read, MongoClassifier.Classify(new BsonDocument("MYREADCOMMAND", 1), reads).Kind);
        Assert.Throws<ArgumentException>(() => new MongoStoreBuilder().TreatAsRead("my*"));
    }

    [Fact]
    public void CommandsAreSanitizedToFieldNamesAndPlaceholders()
    {
        var command = new BsonDocument { { "update", "documents" }, { "updates", new BsonArray { new BsonDocument { { "q", new BsonDocument("_id", "secret-id") }, { "u", new BsonDocument("$set", new BsonDocument("name", "Private")) } } } } };
        var text = BsonJson.Text(BsonJson.Sanitize(command));
        Assert.Contains("\"update\"", text);
        Assert.Contains("\"$set\"", text);
        Assert.DoesNotContain("secret-id", text);
        Assert.DoesNotContain("Private", text);
    }

    // ---- Preview mode ----

    [ServiceFact("mongodb")]
    public async Task APreviewRollsBackAndReportsNestedRedactedChangesAndSanitizedDbEntries()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync();
        var read = await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/documents/seeded"));
        Assert.Equal("Leeds", read.GetProperty("body").GetProperty("city").GetString());

        var created = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument));
        var insert = Assert.Single(Changes(created, "insert"));
        Assert.Equal("documents", insert.GetProperty("table").GetString());
        Assert.Equal(f.Database, insert.GetProperty("namespace").GetString());
        Assert.Equal("preview-doc", insert.GetProperty("key").GetProperty("_id").GetString());
        Assert.Equal(JsonValueKind.Null, insert.GetProperty("before").ValueKind);
        Assert.Equal("York", insert.GetProperty("after").GetProperty("profile").GetProperty("city").GetString());
        Assert.Equal("[REDACTED]", insert.GetProperty("after").GetProperty("password_hash").GetString());
        Assert.Equal("[REDACTED]", insert.GetProperty("after").GetProperty("profile").GetProperty("apiKey").GetString());
        Assert.True(insert.GetProperty("after").GetProperty("createdAt").TryGetProperty("$date", out _), "Dates keep their extended JSON form.");
        var entry = Assert.Single(Expect.DbEntries(created, "mongodb", "insert"));
        Assert.Equal("documents", entry.GetProperty("db").GetProperty("target").GetString());
        Assert.DoesNotContain("mongo-secret-value", created.GetRawText());
        Assert.DoesNotContain("preview-doc\"", entry.GetProperty("db").GetProperty("statement").GetString());
        Assert.Null(await f.FindAsync("preview-doc"));

        var updated = await Expect.ConfirmedAsync(await f.App.PreviewAsync("PATCH", "/documents/seeded", new PatchInput("Renamed", "Hull")));
        var update = Assert.Single(Changes(updated, "update"));
        Assert.Equal("Seeded", update.GetProperty("before").GetProperty("name").GetString());
        Assert.Equal("Renamed", update.GetProperty("after").GetProperty("name").GetString());
        Assert.Equal(("Leeds", "Hull"), (update.GetProperty("before").GetProperty("profile").GetProperty("city").GetString(), update.GetProperty("after").GetProperty("profile").GetProperty("city").GetString()));
        Assert.Equal("[REDACTED]", update.GetProperty("before").GetProperty("password_hash").GetString());

        var removed = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents/seeded/remove"));
        var delete = Assert.Single(Changes(removed, "delete"));
        Assert.Equal("Seeded", delete.GetProperty("before").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, delete.GetProperty("after").ValueKind);

        var seeded = (await f.FindAsync("seeded"))!;
        Assert.Equal(("Seeded", "Leeds"), (seeded["name"].AsString, seeded["profile"]["city"].AsString));
    }

    [ServiceFact("mongodb")]
    public async Task UpsertsAndWholeDocumentReplacementsCarryViaForTheUi()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync();
        var upsert = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents/created-by-upsert/upsert"));
        var inserted = Assert.Single(Changes(upsert));
        Assert.Equal(("insert", "upsert"), (inserted.GetProperty("operation").GetString(), inserted.GetProperty("via").GetString()));
        var matched = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents/seeded/upsert"));
        Assert.Equal(("update", "upsert"), (Changes(matched)[0].GetProperty("operation").GetString(), Changes(matched)[0].GetProperty("via").GetString()));
        var replaced = await Expect.ConfirmedAsync(await f.App.PreviewAsync("PUT", "/documents/seeded"));
        Assert.Equal(("update", "replace"), (Changes(replaced)[0].GetProperty("operation").GetString(), Changes(replaced)[0].GetProperty("via").GetString()));
        Assert.Null(await f.FindAsync("created-by-upsert"));
        Assert.Equal("Seeded", (await f.FindAsync("seeded"))!["name"].AsString);
    }

    [ServiceFact("mongodb")]
    public async Task AggregateOutAndMergeAtAnyDepthAreBlockedBeforeTheyAreSent()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync();
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/documents/archive"), "mongodb", "aggregate");
        Assert.Equal("Preview unavailable: MongoDB can't run $out inside a transaction", problem.GetProperty("detail").GetString());
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/documents/archive-fluent"), "mongodb", "aggregate");
        var deep = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/documents/archive-deep"), "mongodb", "aggregate");
        Assert.Contains("$merge", deep.GetProperty("detail").GetString());
        var names = await (await f.Raw.GetDatabase(f.Database).ListCollectionNamesAsync()).ToListAsync();
        Assert.DoesNotContain("documents_archive", names);
    }

    [ServiceFact("mongodb")]
    public async Task CommandsATransactionCannotRunAreBlockedWithTheirReason()
    {
        await using var f = await Fixture.StartAsync();
        var create = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/explicit-create"), "mongodb", "create");
        Assert.Contains("create", create.GetProperty("detail").GetString());
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/count"), "mongodb", "count");
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/list-indexes"), "mongodb", "listIndexes");
        var names = await (await f.Raw.GetDatabase(f.Database).ListCollectionNamesAsync()).ToListAsync();
        Assert.DoesNotContain("made", names);
    }

    [ServiceFact("mongodb")]
    public async Task DerivedClientsAndTheSessionsClientStayGuardedSoTheirWritesRollBack()
    {
        await using var f = await Fixture.StartAsync();
        foreach (var via in new[] { "session", "read-preference", "write-concern", "read-concern", "database" })
        {
            var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", $"/derived/{via}"));
            Assert.Equal("derived-" + via, Assert.Single(Changes(envelope, "insert")).GetProperty("key").GetProperty("_id").GetString());
            Assert.Null(await f.FindAsync("derived-" + via));
        }
    }

    [ServiceFact("mongodb")]
    public async Task GridFsIsBlockedBeforeItWritesBecauseItBypassesThePreviewSession()
    {
        await using var f = await Fixture.StartAsync();
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/gridfs"), "mongodb", "Cluster");
        Assert.Contains("GridFS", problem.GetProperty("detail").GetString());
        var names = await (await f.Raw.GetDatabase(f.Database).ListCollectionNamesAsync()).ToListAsync();
        Assert.DoesNotContain("fs.files", names);
        Assert.DoesNotContain("fs.chunks", names);
    }

    [ServiceFact("mongodb")]
    public async Task AWriteSentWithoutThePreviewSessionFailsThePreviewWith500NotAConfirmation()
    {
        await using var f = await Fixture.StartAsync();
        var response = await f.App.PreviewAsync("POST", "/escape");
        Expect.Unconfirmed(response, HttpStatusCode.InternalServerError);
        // The tripwire could not stop it, only refuse to claim a rollback: the document is really there.
        Assert.NotNull(await f.FindAsync("escaped"));
    }

    [ServiceFact("mongodb")]
    public async Task AForeignSessionIsRefusedBeforeSendingAndFailsThePreviewEvenIfCaught()
    {
        await using var f = await Fixture.StartAsync();
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/foreign-session"), HttpStatusCode.InternalServerError);
        Assert.Null(await f.FindAsync("foreign"));
    }

    [ServiceFact("mongodb")]
    public async Task AHandlerCommitNeverReachesTheServerAndNeverConfirms()
    {
        await using var f = await Fixture.StartAsync();
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/commit?swallow=no"), HttpStatusCode.InternalServerError);
        Assert.Null(await f.FindAsync("committed"));
        // Catching the refusal and returning 200 changes nothing: the fault is on the Preview, not in the response.
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/commit?swallow=yes"), HttpStatusCode.InternalServerError);
        Assert.Null(await f.FindAsync("committed"));
    }

    [ServiceFact("mongodb")]
    public async Task WithTransactionJoinsThePreviewTransactionInsteadOfNestingOne()
    {
        await using var f = await Fixture.StartAsync();
        var envelope = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/with-transaction"));
        Assert.Equal("Joined", Assert.Single(Changes(envelope, "insert")).GetProperty("after").GetProperty("name").GetString());
        Assert.Null(await f.FindAsync("txn"));
    }

    [ServiceFact("mongodb")]
    public async Task BeforeImagesComeFromTheTransactionStartNotFromLaterCommitsByOthers()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync();
        var pending = f.App.PreviewAsync("POST", "/snapshot");
        await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
        // Another request commits a document after the Preview's transaction began.
        await f.Documents.InsertOneAsync(new BsonDocument { { "_id", "late-doc" }, { "name", "Late" } });
        f.Gates.Release.SetResult();
        var envelope = await Expect.ConfirmedAsync(await pending);
        var change = Assert.Single(Changes(envelope));
        Assert.Equal("seeded", change.GetProperty("key").GetProperty("_id").GetString());
        Assert.Equal("update", change.GetProperty("operation").GetString());
        Assert.NotNull(await f.FindAsync("late-doc"));
        Assert.False((await f.FindAsync("seeded"))!.Contains("touched"));
    }

    [ServiceFact("mongodb")]
    public async Task APreviewThatOutlivesItsTimeLimitIsAbortedAndNeverConfirmed()
    {
        await using var f = await Fixture.StartAsync(timeout: TimeSpan.FromMilliseconds(400));
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/slow?delay=1500&swallow=no"), HttpStatusCode.InternalServerError);
        // A handler that swallows the failure of the aborted transaction still never gets a confirmation.
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/slow?delay=1500&swallow=yes"), HttpStatusCode.InternalServerError);
        Assert.Null(await f.FindAsync("slow-1"));
        Assert.Null(await f.FindAsync("slow-2"));
        Assert.Throws<ArgumentOutOfRangeException>(() => new MongoStoreBuilder().WithPreviewTimeout(TimeSpan.Zero));
    }

    [ServiceFact("mongodb")]
    public async Task ConcurrentPreviewsAndSendsNeverShareASession()
    {
        await using var f = await Fixture.StartAsync();
        var previews = Enumerable.Range(0, 8).Select(index => f.App.PreviewAsync("POST", "/documents", NewDocument with { Id = $"p{index}" })).ToArray();
        var sends = Enumerable.Range(0, 8).Select(index => f.App.Client.PostAsJsonAsync("/documents", NewDocument with { Id = $"s{index}" })).ToArray();
        var responses = await Task.WhenAll(previews);
        await Task.WhenAll(sends);
        for (var index = 0; index < responses.Length; index++)
        {
            var envelope = await Expect.ConfirmedAsync(responses[index]);
            Assert.Equal($"p{index}", Assert.Single(Changes(envelope)).GetProperty("key").GetProperty("_id").GetString());
        }

        Assert.Equal(8, await f.Documents.CountDocumentsAsync(new BsonDocument("_id", new BsonDocument("$regex", "^s"))));
        Assert.Equal(0, await f.Documents.CountDocumentsAsync(new BsonDocument("_id", new BsonDocument("$regex", "^p"))));
    }

    [ServiceFact("mongodb")]
    public async Task AWriteConflictBetweenTwoPreviewsReachesTheHandlerAndBothRollBack()
    {
        await using var f = await Fixture.StartAsync();
        await f.SeedAsync();
        var first = f.App.PreviewAsync("POST", "/conflict/first");
        await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
        var second = await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/conflict/second"));
        Assert.Equal("WriteConflict", second.GetProperty("body").GetProperty("error").GetString());
        Assert.Contains(Expect.DbEntries(second, "mongodb", "update"), entry => entry.GetProperty("db").TryGetProperty("error", out var error) && error.GetString() == "WriteConflict");
        f.Gates.Release.SetResult();
        var winner = await Expect.ConfirmedAsync(await first);
        Assert.Equal("By first", Assert.Single(Changes(winner, "update")).GetProperty("after").GetProperty("name").GetString());
        Assert.Equal("Seeded", (await f.FindAsync("seeded"))!["name"].AsString);
    }

    [ServiceFact("mongodb")]
    public async Task DiscoveryListsMongoDbInPreviewModeWithItsLabelAndNeverAConnectionString()
    {
        await using var f = await Fixture.StartAsync();
        var capabilities = await f.App.CapabilitiesAsync();
        Assert.True(f.Engine.LastDetectionError is null, f.Engine.LastDetectionError?.ToString());
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal(("mongodb", "catalog", "preview"), (store.GetProperty("system").GetString(), store.GetProperty("name").GetString(), store.GetProperty("mode").GetString()));
        Assert.False(store.TryGetProperty("reason", out _));
        Assert.Equal("Preview unavailable: this operation writes to MongoDB", Assert.Single(capabilities.GetProperty("previewUnavailable").EnumerateArray()).GetProperty("reason").GetString());
        Assert.DoesNotContain("127.0.0.1", capabilities.GetRawText());
        Assert.Equal(JsonValueKind.Null, capabilities.GetProperty("database").ValueKind);
        await f.SeedAsync();
        Expect.Unconfirmed(await f.App.PreviewAsync("DELETE", "/documents/seeded"), HttpStatusCode.Conflict);
        Assert.NotNull(await f.FindAsync("seeded"));
    }

    [ServiceFact("mongodb")]
    public async Task ObservedSendCommitsOnceAndTracesTheCommandWithoutItsValues()
    {
        await using var f = await Fixture.StartAsync();
        var (response, trace) = await f.App.ObservedAsync("POST", "/documents", NewDocument with { Id = "sent-doc" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Single(Expect.DbEntries(trace, "mongodb", "insert"));
        Assert.Equal("hashed:mongo-secret-value", (await f.FindAsync("sent-doc"))!["password_hash"].AsString);
        Assert.DoesNotContain("mongo-secret-value", trace.GetRawText());
        // Session commands such as hello and authentication are never logged.
        Assert.DoesNotContain(trace.GetProperty("logs").EnumerateArray(), log => log.TryGetProperty("db", out var db) &&
            db.GetProperty("operation").GetString() is "hello" or "saslStart" or "authenticate");
    }

    [ServiceFact("mongodb")]
    public async Task AClientTheHookNeverSawIsNotCovered()
    {
        // The documented limit, and the negative test: a write through an unhooked client goes through and is confirmed.
        await using var f = await Fixture.StartAsync();
        var response = await f.App.PreviewAsync("POST", "/unguarded");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(await f.FindAsync("unguarded"));
    }

    // ---- Review findings every language checks ----

    [ServiceFact("mongodb")]
    public async Task HandlerCodeNeverHoldsThePreviewSessionSoItCannotCommitIt()
    {
        await using var f = await Fixture.StartAsync();
        foreach (var how in new[] { "fork", "core" })
        {
            Expect.Unconfirmed(await f.App.PreviewAsync("POST", $"/fork-commit?how={how}"), HttpStatusCode.InternalServerError);
            Assert.Null(await f.FindAsync("forked"));
        }
    }

    [ServiceFact("mongodb")]
    public async Task TheTripwireMustBeInstalledOnTheGuardedClientItselfOrThePreviewFallsBackToGuardMode()
    {
        // A guarded client whose command monitoring was never subscribed can't see an escaped write, so it must not claim a
        // transaction: its own detection hello never reached the monitor, and the store runs in guard mode.
        await using var f = await Fixture.StartAsync(monitored: false);
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal("guard", store.GetProperty("mode").GetString());
        Assert.Contains("monitoring", store.GetProperty("reason").GetString());
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument), "mongodb", "insert");
        Assert.Null(await f.FindAsync("preview-doc"));
    }

    [ServiceFact("mongodb")]
    public async Task AnAbortThatFailsFailsThePreviewWith500AndStillEndsItsSession()
    {
        await using var f = await Fixture.StartAsync();
        var aborts = 0;
        f.Engine.AbortOverride = _ => { aborts++; return Task.FromException(new TimeoutException("Injected abort failure.")); };
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/documents", NewDocument), HttpStatusCode.InternalServerError);
        Assert.Equal(1, aborts);
        Assert.Null(await f.FindAsync("preview-doc"));
        f.Engine.AbortOverride = null;
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument with { Id = "after" }));
    }

    [ServiceFact("mongodb")]
    public async Task APreviewWhoseAbortIsLostAnswers500AtOnceAndStillReleasesItsLocks()
    {
        using var proxy = new Proxy(Services.MongoUrl);
        // An app whose client reaches MongoDB only through the proxy and gives up quickly when it can't: when the
        // connection is cut, the driver's own abort fails and the driver hides that.
        await using var f = await Fixture.StartAsync(url: $"mongodb://127.0.0.1:{proxy.Port}/?directConnection=true&serverSelectionTimeoutMS=1000");
        await f.SeedAsync();
        await f.Documents.UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Set("n", 0));
        var store = Assert.Single((await f.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal("preview", store.GetProperty("mode").GetString());
        Task restored = Task.CompletedTask;
        var cut = new System.Diagnostics.Stopwatch();
        f.Gates.AfterWrite = () =>
        {
            // The network fails after the handler, before the Preview finishes, and stays down for 8 seconds.
            proxy.Cut();
            cut.Start();
            restored = Task.Delay(TimeSpan.FromSeconds(8)).ContinueWith(_ => proxy.Restore(), TaskScheduler.Default);
        };
        var response = await f.App.PreviewAsync("POST", "/lost-abort");
        Assert.True(cut.Elapsed < TimeSpan.FromSeconds(6), $"The reply waited for the network: {cut.Elapsed}.");
        Expect.Unconfirmed(response, HttpStatusCode.InternalServerError);

        // The session is killed in the background once the network is back; without that the transaction holds its
        // write lock until the server's 60-second lifetime limit.
        await f.Documents.UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Inc("n", 10)).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(10, (await f.FindAsync("seeded"))!["n"].ToInt32());
        await restored;
    }

    [ServiceFact("mongodb")]
    public async Task APreviewWhoseAbortAloneIsLostStillCapturesThenAnswers500AndReleasesItsLocks()
    {
        using var proxy = new Proxy(Services.MongoUrl);
        var succeeded = new ConcurrentQueue<string>();
        var failed = new ConcurrentQueue<string>();
        await using var f = await Fixture.StartAsync(url: $"mongodb://127.0.0.1:{proxy.Port}/?directConnection=true&serverSelectionTimeoutMS=1000",
            settings: settings => settings.ClusterConfigurator = builder => builder
                .Subscribe<global::MongoDB.Driver.Core.Events.CommandSucceededEvent>(done => succeeded.Enqueue(done.CommandName))
                .Subscribe<global::MongoDB.Driver.Core.Events.CommandFailedEvent>(done => failed.Enqueue(done.CommandName)));
        await f.SeedAsync();
        await f.Documents.UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Set("n", 0));
        var store = Assert.Single((await f.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal("preview", store.GetProperty("mode").GetString());
        var armed = new System.Diagnostics.Stopwatch();
        f.Gates.AfterWrite = () =>
        {
            // Only the abort is lost: the proxy closes the connection on it, and every other command goes through.
            proxy.DropAborts = true;
            succeeded.Clear();
            armed.Start();
        };
        var response = await f.App.PreviewAsync("POST", "/lost-abort");
        Assert.True(armed.Elapsed < TimeSpan.FromSeconds(6), $"The reply waited: {armed.Elapsed}.");
        Assert.Contains("find", succeeded);
        Assert.Contains("abortTransaction", failed);
        Expect.Unconfirmed(response, HttpStatusCode.InternalServerError);

        // The network is fine, so killSessions ends the transaction straight away.
        var released = System.Diagnostics.Stopwatch.StartNew();
        await f.Documents.UpdateOneAsync(new BsonDocument("_id", "seeded"), Builders<BsonDocument>.Update.Inc("n", 10)).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True(released.Elapsed < TimeSpan.FromSeconds(5), $"The lock was held for {released.Elapsed}.");
        Assert.Contains("killSessions", succeeded);
        Assert.Equal(10, (await f.FindAsync("seeded"))!["n"].ToInt32());
    }

    [ServiceFact("mongodb")]
    public async Task AKillSessionsTryAgainstAnUnreachableServerNeverHoldsTheRetryWindowOpen()
    {
        // Nothing listens here, and the client keeps the driver's default 30-second server selection timeout.
        await using var f = await Fixture.StartAsync(url: "mongodb://127.0.0.1:1/?directConnection=true");
        var started = System.Diagnostics.Stopwatch.StartNew();
        var failure = await f.Engine.KillSessionAsync(new BsonDocument("id", new BsonBinaryData(Guid.NewGuid(), GuidRepresentation.Standard)));
        Assert.Contains("couldn't be reached", failure);
        Assert.InRange(started.Elapsed, TimeSpan.FromSeconds(9), TimeSpan.FromSeconds(13));
    }

    [ServiceFact("mongodb")]
    public async Task ANormalPreviewSendsNoKillSessions()
    {
        var names = new ConcurrentQueue<string>();
        await using var f = await Fixture.StartAsync(settings: settings => settings.ClusterConfigurator = builder =>
            builder.Subscribe<global::MongoDB.Driver.Core.Events.CommandStartedEvent>(started => names.Enqueue(started.CommandName)));
        await f.SeedAsync();
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument));
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/documents/seeded"));
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/nothing"));
        await Task.Delay(500);
        Assert.Contains("abortTransaction", names);
        Assert.DoesNotContain("killSessions", names);
        Assert.Null(await f.FindAsync("preview-doc"));
    }

    [ServiceFact("mongodb")]
    public async Task ACancelledRequestStillAbortsThePreviewTransaction()
    {
        await using var f = await Fixture.StartAsync();
        using var cancel = new CancellationTokenSource();
        var request = new HttpRequestMessage(HttpMethod.Post, "/sendproof/_preview/hang");
        request.Headers.Add("Prefer", "tx=rollback");
        var pending = f.App.Client.SendAsync(request, cancel.Token);
        await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
        var cancelled = System.Diagnostics.Stopwatch.StartNew();
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);

        // While the Preview transaction held its insert, this one would wait for it (until the 50 s limit aborted it).
        var raw = Documents(f.Raw, f.Database).WithWriteConcern(WriteConcern.WMajority);
        await raw.InsertOneAsync(new BsonDocument("_id", "hung"));
        Assert.True(cancelled.Elapsed < TimeSpan.FromSeconds(15), $"The transaction outlived the cancelled request by {cancelled.Elapsed}.");
        await Expect.ConfirmedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument));
    }

    [ServiceFact("mongodb")]
    public async Task OnceThePreviewTransactionEndsEveryFurtherCallIsRefusedNeverSentOutsideIt()
    {
        await using var f = await Fixture.StartAsync();
        var guarded = f.App.Services.GetRequiredService<IMongoClient>();
        var outcomes = new List<string>();
        // Runs where a late handler write lands: after the abort, before the session is ended (the time limit's path too).
        f.Engine.AbortOverride = async session =>
        {
            await session.AbortTransactionAsync();
            foreach (var (name, call) in new (string, Func<Task>)[]
            {
                ("insert", () => Documents(guarded, f.Database).InsertOneAsync(new BsonDocument("_id", "after-end"))),
                ("find", async () => await (await Documents(guarded, f.Database).FindAsync(new BsonDocument())).ToListAsync()),
                ("commit", async () => { using var handle = await guarded.StartSessionAsync(); await handle.CommitTransactionAsync(); }),
                ("server-session", async () => { using var handle = await guarded.StartSessionAsync(); _ = handle.ServerSession; await Task.CompletedTask; })
            })
            {
                try { await call(); outcomes.Add(name + ": ran"); }
                catch (PreviewTransactionControlException) { outcomes.Add(name + ": refused"); }
            }
        };
        Expect.Unconfirmed(await f.App.PreviewAsync("POST", "/documents", NewDocument), HttpStatusCode.InternalServerError);
        Assert.Equal(["insert: refused", "find: refused", "commit: refused", "server-session: refused"], outcomes);
        Assert.Null(await f.FindAsync("after-end"));
        Assert.Null(await f.FindAsync("preview-doc"));
    }

    [ServiceFact("mongodb")]
    public async Task AWriteWithNoRequestAttributionFailsTheOpenPreviewUnlessDetached()
    {
        await using var f = await Fixture.StartAsync();
        var failed = await Unattributed(f, detach: false);
        Expect.Unconfirmed(failed, HttpStatusCode.InternalServerError);
        var confirmed = await Unattributed(f, detach: true);
        await Expect.ConfirmedAsync(confirmed);
        // Both writes went through: they were never the Preview's to roll back.
        Assert.NotNull(await f.FindAsync("background-False"));
        Assert.NotNull(await f.FindAsync("background-True"));

        static async Task<HttpResponseMessage> Unattributed(Fixture f, bool detach)
        {
            f.Gates.Reset();
            var pending = f.App.PreviewAsync("POST", "/snapshot");
            await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
            Task write;
            using (ExecutionContext.SuppressFlow())
            {
                write = Task.Run(async () =>
                {
                    using var _ = detach ? DetachedWork.Begin() : null;
                    await f.Engine.Client.GetDatabase(f.Database).GetCollection<BsonDocument>("documents")
                        .InsertOneAsync(new BsonDocument("_id", "background-" + detach));
                });
            }

            await write;
            f.Gates.Release.SetResult();
            return await pending;
        }
    }

    [ServiceFact("mongodb")]
    public async Task AGuardedWriteWithNoRequestAttributionIsRefusedBeforeItIsSentAndBlocksThePreviewWith409()
    {
        await using var f = await Fixture.StartAsync();
        var guarded = f.App.Services.GetRequiredService<IMongoClient>();
        f.Gates.Reset();
        var pending = f.App.PreviewAsync("POST", "/snapshot");
        await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
        Task write;
        using (ExecutionContext.SuppressFlow())
        {
            write = Task.Run(async () => await Documents(guarded, f.Database).InsertOneAsync(new BsonDocument("_id", "guarded-background")));
        }

        // Nothing reached the server, so the Preview answers 409 (the 500 is for a write seen after it was sent, by the tripwire).
        await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => write);
        f.Gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "mongodb", "insert");
        Assert.Null(await f.FindAsync("guarded-background"));
    }

    [ServiceFact("mongodb")]
    public async Task GridFsWithNoRequestAttributionIsRefusedBeforeItIsSentWhileAPreviewIsOpen()
    {
        // GridFS sends through the client's cluster, never a guarded handle: with no request and a Preview open, reaching the
        // cluster is refused like a write, as it is inside a Preview, instead of being sent and caught afterwards with a 500.
        await using var f = await Fixture.StartAsync();
        var guarded = f.App.Services.GetRequiredService<IMongoClient>();
        f.Gates.Reset();
        var pending = f.App.PreviewAsync("POST", "/snapshot");
        await f.Gates.Started.Task.WaitAsync(TimeSpan.FromSeconds(20));
        Task write;
        using (ExecutionContext.SuppressFlow())
        {
            write = Task.Run(async () => await new global::MongoDB.Driver.GridFS.GridFSBucket(guarded.GetDatabase(f.Database)).UploadFromBytesAsync("background.txt", [1, 2, 3]));
        }

        await Assert.ThrowsAsync<PreviewWriteBlockedException>(() => write);
        f.Gates.Release.SetResult();
        await Expect.BlockedAsync(await pending, "mongodb", "Cluster");
        Assert.Equal(0, await f.Engine.Client.GetDatabase(f.Database).GetCollection<BsonDocument>("fs.files").CountDocumentsAsync(FilterDefinition<BsonDocument>.Empty));
    }

    // ---- Guard mode ----

    private static readonly BsonDocument Standalone = new() { { "isWritablePrimary", true }, { "ok", 1 } };

    [ServiceFact("mongodb")]
    public async Task OnAStandaloneServerWritesBlockAndReadsRun()
    {
        await using var f = await Fixture.StartAsync(hello: () => Task.FromResult(Standalone));
        await f.SeedAsync();
        var capabilities = await f.App.CapabilitiesAsync();
        var store = Assert.Single(capabilities.GetProperty("dataStores").EnumerateArray());
        Assert.Equal("guard", store.GetProperty("mode").GetString());
        Assert.Equal("Preview unavailable: this MongoDB server doesn't support transactions", store.GetProperty("reason").GetString());

        await Expect.ConfirmedAsync(await f.App.PreviewAsync("GET", "/documents/seeded"));
        var problem = await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/documents", NewDocument), "mongodb", "insert");
        Assert.Equal("Preview unavailable: this operation writes to MongoDB", problem.GetProperty("detail").GetString());
        Assert.Null(await f.FindAsync("preview-doc"));
        await Expect.BlockedAsync(await f.App.PreviewAsync("PATCH", "/documents/seeded", new PatchInput("Renamed", "Hull")), "mongodb", "update");
        Assert.Equal("Seeded", (await f.FindAsync("seeded"))!["name"].AsString);
    }

    [ServiceFact("mongodb")]
    public async Task APreviewKeepsTheModeItBeganInWhenDetectionLaterSucceeds()
    {
        var calls = 0;
        // Detection fails for the Preview's first look (so it begins in guard mode) and succeeds for the next one.
        await using var f = await Fixture.StartAsync(hello: () => ++calls == 1
            ? Task.FromException<BsonDocument>(new TimeoutException("server not selected"))
            : Task.FromResult(new BsonDocument { { "setName", "rs0" }, { "logicalSessionTimeoutMinutes", 30 } }));
        await Expect.BlockedAsync(await f.App.PreviewAsync("POST", "/redetect"), "mongodb", "insert");
        Assert.Null(await f.FindAsync("redetected"));
        Assert.True(calls >= 2, "Detection must have run again during the Preview.");
    }

    [ServiceFact("mongodb")]
    public async Task AnUnreachableServerRunsInGuardModeWithItsOwnReasonAndIsAskedAgain()
    {
        const string unreachable = "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode";
        Assert.Equal(unreachable, MongoEngine.UnreachableReason);
        Assert.NotEqual(MongoEngine.StandaloneReason, MongoEngine.UnreachableReason);

        // Nothing listens here: the hello can't be sent, which says nothing about transactions.
        await using (var f = await Fixture.StartAsync(url: "mongodb://127.0.0.1:1/?directConnection=true&serverSelectionTimeoutMS=300"))
        {
            var store = Assert.Single((await f.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
            Assert.Equal("guard", store.GetProperty("mode").GetString());
            Assert.Equal(unreachable, store.GetProperty("reason").GetString());
        }

        // Once the server answers, detection runs again and Preview is available.
        var calls = 0;
        await using var later = await Fixture.StartAsync(hello: () => ++calls == 1
            ? Task.FromException<BsonDocument>(new TimeoutException("server not selected"))
            : Task.FromResult(new BsonDocument { { "setName", "rs0" }, { "logicalSessionTimeoutMinutes", 30 } }));
        var first = Assert.Single((await later.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal(unreachable, first.GetProperty("reason").GetString());
        var second = Assert.Single((await later.App.CapabilitiesAsync()).GetProperty("dataStores").EnumerateArray());
        Assert.Equal("preview", second.GetProperty("mode").GetString());
    }

    /// <summary>A TCP proxy to the compose MongoDB that can cut every connection and refuse new ones: the network failing.</summary>
    private sealed class Proxy : IDisposable
    {
        private readonly System.Net.Sockets.TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly List<System.Net.Sockets.TcpClient> _open = [];
        private volatile bool _down;

        internal Proxy(string url)
        {
            var upstream = MongoUrl.Create(url).Server;
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    System.Net.Sockets.TcpClient client;
                    try
                    {
                        client = await _listener.AcceptTcpClientAsync();
                    }
                    catch (Exception stopped) when (stopped is System.Net.Sockets.SocketException or ObjectDisposedException)
                    {
                        return; // The listener stopped.
                    }

                    if (_down)
                    {
                        client.Dispose();
                        continue;
                    }

                    var server = new System.Net.Sockets.TcpClient();
                    try
                    {
                        await server.ConnectAsync(upstream.Host, upstream.Port);
                    }
                    catch (System.Net.Sockets.SocketException)
                    {
                        client.Dispose();
                        server.Dispose();
                        continue;
                    }

                    lock (_open)
                    {
                        _open.Add(client);
                        _open.Add(server);
                    }

                    _ = Forward(client, server);
                    _ = Pump(server, client);
                }
            });
        }

        internal int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

        /// <summary>While set, a connection that carries an <c>abortTransaction</c> is closed instead, before it reaches the server.</summary>
        internal bool DropAborts { get; set; }

        /// <summary>Copies the driver's requests to the server message by message, so an abort can be recognised and lost.</summary>
        private async Task Forward(System.Net.Sockets.TcpClient client, System.Net.Sockets.TcpClient server)
        {
            try
            {
                var from = client.GetStream();
                var to = server.GetStream();
                var header = new byte[4];
                while (true)
                {
                    await from.ReadExactlyAsync(header);
                    var message = new byte[BitConverter.ToInt32(header)];
                    header.CopyTo(message, 0);
                    await from.ReadExactlyAsync(message.AsMemory(4));
                    if (DropAborts && IsAbort(message))
                    {
                        return;
                    }

                    await to.WriteAsync(message);
                }
            }
            catch (Exception cut) when (cut is IOException or ObjectDisposedException or InvalidOperationException or System.Net.Sockets.SocketException or EndOfStreamException)
            {
                // A cut connection.
            }
            finally
            {
                client.Dispose();
                server.Dispose();
            }
        }

        /// <summary>Whether a wire message is an OP_MSG whose body (section kind 0) starts with <c>abortTransaction</c>.</summary>
        private static bool IsAbort(byte[] message)
        {
            // Header (16 bytes, opCode at 12), flag bits (4), section kind (1), document length (4), element type (1).
            var name = "abortTransaction\0"u8;
            const int at = 26;
            return message.Length >= at + name.Length && BitConverter.ToInt32(message, 12) == 2013 && message[20] == 0 &&
                message.AsSpan(at, name.Length).SequenceEqual(name);
        }

        private static async Task Pump(System.Net.Sockets.TcpClient from, System.Net.Sockets.TcpClient to)
        {
            try
            {
                await from.GetStream().CopyToAsync(to.GetStream());
            }
            catch (Exception cut) when (cut is IOException or ObjectDisposedException or InvalidOperationException or System.Net.Sockets.SocketException)
            {
                // A cut connection.
            }
            finally
            {
                from.Dispose();
                to.Dispose();
            }
        }

        /// <summary>Closes every open connection and refuses new ones until <see cref="Restore"/>.</summary>
        internal void Cut()
        {
            _down = true;
            lock (_open)
            {
                foreach (var socket in _open)
                {
                    // Null once a pump has disposed it.
                    socket.Client?.Close(0);
                    socket.Dispose();
                }

                _open.Clear();
            }
        }

        internal void Restore() => _down = false;

        public void Dispose()
        {
            _listener.Stop();
            Cut();
        }
    }
}

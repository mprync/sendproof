using System.Text.Json.Nodes;
using MongoDB.Bson;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>
/// The document changes of one observed Send. Its writes commit, so nothing can be read back afterwards: command monitoring
/// sees each write before it is sent and this reads the documents it will touch (the before images), then after the handler
/// reads each one again (the after image). The same change shape as a Preview, from the same write parsing. It works on a
/// standalone server too, because it needs no transaction.
/// </summary>
internal sealed class MongoObservation(MongoEngine engine, SendproofPreview recorder) : IPreviewObservation
{
    /// <summary>The longest the after images may take to read, so a slow server never holds the response.</summary>
    private static readonly TimeSpan CompleteLimit = TimeSpan.FromSeconds(10);

    private readonly object _gate = new();
    private readonly Dictionary<string, MongoEngine.Candidate> _candidates = [];
    // A document's first image seen in this Send: its state before the first write that touched it (null: it didn't exist).
    private readonly Dictionary<string, BsonDocument?> _before = [];
    private readonly List<PreviewChange> _changes = [];
    private bool _closed;
    private bool _truncated;

    public IReadOnlyList<PreviewChange> Changes => _changes;

    public bool ChangesTruncated => _truncated;

    /// <summary>Runs inside the monitoring event of a write, before the command reaches the server: reads what it will change.</summary>
    internal void Write(BsonDocument command, string database, string name)
    {
        if (MongoEngine.IsSystemDatabase(database))
        {
            return;
        }

        var found = new Dictionary<string, MongoEngine.Candidate>();
        var filters = new List<MongoEngine.Filter>();
        MongoEngine.Collect(found, filters, command, database, name);
        if (found.Count == 0 && filters.Count == 0)
        {
            return;
        }

        try
        {
            engine.Internal(() =>
            {
                // A named id is read too: an insert of an id that exists fails and changes nothing, and must not look like an insert.
                foreach (var group in found.Values.GroupBy(candidate => (candidate.Namespace, candidate.Collection)))
                {
                    var ids = new BsonArray(group.Select(candidate => candidate.Id));
                    var existing = Read(group.Key.Namespace, group.Key.Collection, new BsonDocument("_id", new BsonDocument("$in", ids)));
                    foreach (var candidate in group)
                    {
                        Remember(candidate, existing.FirstOrDefault(document => document["_id"] == candidate.Id));
                    }
                }

                foreach (var filter in filters)
                {
                    foreach (var document in Read(filter.Namespace, filter.Collection, filter.Match))
                    {
                        Remember(new MongoEngine.Candidate(filter.Namespace, filter.Collection, document["_id"], filter.Via), document);
                    }
                }

                return true;
            });
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // The documents this write changes can't be compared, so the changes are reported as partial.
            lock (_gate)
            {
                _truncated = true;
            }

            engine.Logger?.LogDebug(error, "Sendproof could not read the MongoDB documents an observed write touches.");
        }
    }

    /// <summary>Runs inside the monitoring event of a reply: adds the documents it names (upserted ids, a findAndModify result).</summary>
    internal void Reply(string database, string target, string name, BsonDocument reply)
    {
        lock (_gate)
        {
            if (!_closed && !MongoEngine.IsSystemDatabase(database))
            {
                MongoEngine.CollectReply(_candidates, database, target, name, reply);
            }
        }
    }

    // A blocking find: the monitoring event that calls it is synchronous, and runs before the write is sent.
    private static List<BsonDocument> ReadWith(IMongoClient client, string database, string collection, BsonDocument filter) =>
        client.GetDatabase(database).GetCollection<BsonDocument>(collection)
            .WithReadPreference(ReadPreference.Primary).WithReadConcern(ReadConcern.Local)
            .Find(new BsonDocumentFilterDefinition<BsonDocument>(filter)).Limit(MongoEngine.CandidateLimit + 1).ToList();

    private List<BsonDocument> Read(string database, string collection, BsonDocument filter)
    {
        var documents = ReadWith(engine.Client, database, collection, filter);
        if (documents.Count > MongoEngine.CandidateLimit)
        {
            lock (_gate)
            {
                _truncated = true;
            }

            documents.RemoveAt(documents.Count - 1);
        }

        return documents;
    }

    private void Remember(MongoEngine.Candidate candidate, BsonDocument? image)
    {
        lock (_gate)
        {
            if (_closed)
            {
                return;
            }

            var key = MongoEngine.KeyOf(candidate);
            if (!_candidates.ContainsKey(key) && _candidates.Count >= MongoEngine.CandidateLimit)
            {
                _truncated = true;
                return;
            }

            // The first image wins: a document written twice reports its change across the whole Send.
            _before.TryAdd(key, image);
            MongoEngine.AddCandidate(_candidates, candidate);
        }
    }

    /// <summary>Reads each touched document again and records the ones that differ from their before image.</summary>
    public async ValueTask CompleteAsync(CancellationToken cancellationToken)
    {
        MongoEngine.Candidate[] candidates;
        lock (_gate)
        {
            // A write that comes after the handler isn't part of this Send.
            _closed = true;
            candidates = [.. _candidates.Values];
        }

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(CompleteLimit);
        try
        {
            await engine.InternalAsync(async () =>
            {
                foreach (var candidate in candidates)
                {
                    var now = await (await engine.Client.GetDatabase(candidate.Namespace).GetCollection<BsonDocument>(candidate.Collection)
                        .WithReadPreference(ReadPreference.Primary).WithReadConcern(ReadConcern.Local)
                        .FindAsync(new BsonDocumentFilterDefinition<BsonDocument>(new BsonDocument("_id", candidate.Id)), cancellationToken: limit.Token)
                        .ConfigureAwait(false)).FirstOrDefaultAsync(limit.Token).ConfigureAwait(false);
                    BsonDocument? was;
                    lock (_gate)
                    {
                        _before.TryGetValue(MongoEngine.KeyOf(candidate), out was);
                    }

                    var (wasJson, nowJson) = (was is null ? null : BsonJson.Plain(was), now is null ? null : BsonJson.Plain(now));
                    if (JsonNode.DeepEquals(wasJson, nowJson))
                    {
                        continue;
                    }

                    var operation = was is null ? "insert" : now is null ? "delete" : "update";
                    // Secret-named fields never leave the process, at any depth, exactly as a Preview's changes.
                    _changes.Add(new PreviewChange(operation, candidate.Collection,
                        SecretNames.RedactDeep(new JsonObject { ["_id"] = BsonJson.Plain(candidate.Id) }),
                        SecretNames.RedactDeep(wasJson), SecretNames.RedactDeep(nowJson))
                    {
                        Store = "mongodb",
                        Namespace = candidate.Namespace,
                        Via = candidate.Via is not null && operation != "delete" ? candidate.Via : null
                    });
                }

                return true;
            }).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (limit.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            // Out of time: what was read is reported, marked partial.
            _truncated = true;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _closed = true;
        }

        engine.Unobserve(recorder);
    }
}

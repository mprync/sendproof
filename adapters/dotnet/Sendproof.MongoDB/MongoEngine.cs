using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Driver;
using MongoDB.Driver.Core.Configuration;
using MongoDB.Driver.Core.Events;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Sendproof.AspNetCore;

namespace Sendproof.MongoDB;

/// <summary>
/// The per-client engine behind the MongoDB hook:
/// <list type="bullet">
/// <item><b>Topology</b>: <c>hello</c> decides the mode once. A replica set or mongos with logical sessions runs in
/// <c>preview</c> mode; anything else in <c>guard</c> mode.</item>
/// <item><b>Session</b>: each <c>preview</c>-mode Preview gets one client session with a snapshot/majority transaction.
/// The handler's own <c>StartTransaction</c> and <c>WithTransaction</c> join it; its <c>CommitTransaction</c> and
/// <c>AbortTransaction</c> never reach the server and fail the Preview with 500.</item>
/// <item><b>Guard</b>: <see cref="Check"/> classifies a command before the proxies send it.</item>
/// <item><b>Monitoring</b> (the tripwire): every command the client sends is seen in the request's async context. A write
/// during a Preview without the Preview's <c>lsid</c> and <c>autocommit: false</c> fails the Preview with 500, a reply
/// with code 263 blocks it, and every other command becomes a <c>Db</c> entry. Candidate document ids for change capture
/// come from the same events.</item>
/// <item><b>Finish</b>: after the handler, changes are read (inside the transaction for <c>after</c>, at the transaction's
/// own snapshot time for <c>before</c>), then the transaction is aborted and the session ended. A Preview that outlives
/// its time limit is aborted early and answers 500.</item>
/// </list>
/// </summary>
internal sealed class MongoEngine
{
    /// <summary>The reason a standalone server, or any reply the binding doesn't recognise, runs in guard mode.</summary>
    internal const string StandaloneReason = "Preview unavailable: this MongoDB server doesn't support transactions";

    /// <summary>
    /// The reason when the detection <c>hello</c> can't be sent or answered: whether the server supports transactions is
    /// unknown, so the store runs in guard mode for now and asks again next time.
    /// </summary>
    internal const string UnreachableReason = "Preview unavailable: couldn't reach MongoDB to check whether it supports transactions, so this Preview runs in guard mode";

    /// <summary>The reason a client whose command monitoring isn't installed runs in guard mode.</summary>
    internal const string UnmonitoredReason = "Preview unavailable: Sendproof's command monitoring isn't installed on this MongoDB client";

    /// <summary>The default Preview time limit: below the server's 60-second <c>transactionLifetimeLimitSeconds</c>.</summary>
    internal static readonly TimeSpan DefaultPreviewTimeout = TimeSpan.FromSeconds(50);

    /// <summary>Most candidate documents read back for change capture in one Preview.</summary>
    private const int CandidateLimit = 1000;

    /// <summary><c>NoSuchTransaction</c>: the server has no such transaction, so nothing holds its locks.</summary>
    private const int NoSuchTransaction = 251;

    // How long the engine keeps trying to end a Preview transaction whose abort the server never acknowledged, and the
    // backoff between tries. Well inside the server's 60-second transaction lifetime.
    private static readonly TimeSpan KillRetryLimit = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan KillFirstDelay = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan KillMaxDelay = TimeSpan.FromSeconds(2);

    // Commands the monitoring specification marks security-sensitive: never logged.
    private static readonly HashSet<string> Sensitive = new(
        ["authenticate", "saslstart", "saslcontinue", "getnonce", "createuser", "updateuser", "copydbgetnonce", "copydbsaslstart", "copydb"],
        StringComparer.Ordinal);

    // Fields the driver adds to every command; they carry no meaning for the log and are dropped.
    private static readonly HashSet<string> Envelope = new(
        ["lsid", "txnNumber", "autocommit", "startTransaction", "$clusterTime", "$db", "$readPreference", "readConcern", "writeConcern", "apiVersion", "apiStrict", "apiDeprecationErrors"],
        StringComparer.Ordinal);

    // Server error codes meaning the collection or snapshot didn't exist at the start time.
    private static readonly HashSet<int> AbsentAtStart = [26 /* NamespaceNotFound */, 246 /* SnapshotUnavailable */];

    private readonly CaptureContext _capture;
    private readonly IReadOnlySet<string>? _reads;
    private readonly TimeSpan _timeout;

    // A Preview keeps the mode it began in, even if detection later changes it: a Preview that began without a session
    // must never have its writes treated as joining a transaction.
    private readonly ConditionalWeakTable<SendproofPreview, string> _modes = new();
    private readonly ConditionalWeakTable<SendproofPreview, PreviewState> _states = new();
    private readonly ConcurrentDictionary<int, Pending> _pending = new();

    // Each Preview whose session is still open, by the hex of its lsid, and the Preview of each abortTransaction sent and
    // not yet answered, by request id.
    private readonly ConcurrentDictionary<string, PreviewState> _byLsid = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<int, PreviewState> _aborts = new();

    // Set while the engine itself talks to the server, so monitoring ignores those commands.
    private readonly AsyncLocal<bool> _internal = new();
    private Task<(string Mode, string? Reason, bool Succeeded)>? _detected;

    internal MongoEngine(CaptureContext capture, IReadOnlySet<string>? reads, TimeSpan timeout)
    {
        _capture = capture;
        _reads = reads;
        _timeout = timeout;
    }

    /// <summary>The last failure of topology detection, for diagnostics. The mode is <c>guard</c> while detection fails.</summary>
    internal Exception? LastDetectionError { get; private set; }

    /// <summary>A test seam: replaces the abort of the Preview transaction, to simulate an abort that fails.</summary>
    internal Func<IClientSessionHandle, Task>? AbortOverride { get; set; }

    /// <summary>A test seam: leaves command monitoring unsubscribed, as a client built some other way would be.</summary>
    internal bool MonitoringEnabled { get; set; } = true;

    // The detection hello carries a one-off token in its comment. Seeing it in this engine's own command events proves the
    // monitor is installed on this client, which the tripwire depends on; commands seen from any other client prove nothing.
    private const string ProbePrefix = "sendproof-probe-";
    private readonly ConcurrentDictionary<string, byte> _probesSeen = new();
    private readonly object _detectGate = new();

    /// <summary>A test seam: answers <c>hello</c> in place of the server, to simulate a standalone server or a failed detection.</summary>
    internal Func<Task<BsonDocument>>? HelloOverride { get; set; }

    /// <summary>The client the engine talks to: the instrumented one that reports command events.</summary>
    internal IMongoClient Client { get; set; } = null!;

    /// <summary>The guarded client handlers get from the container.</summary>
    internal IMongoClient? GuardedClient { get; set; }

    /// <summary>The client the host registered, kept so disposing the decorator disposes both.</summary>
    internal IMongoClient? Original { get; set; }

    /// <summary>The capture slot of this host.</summary>
    internal CaptureContext Capture => _capture;

    /// <summary>Where a transaction the engine couldn't end is reported.</summary>
    internal ILogger? Logger { get; set; }

    /// <summary>The state of one <c>preview</c>-mode Preview.</summary>
    internal sealed class PreviewState(IClientSessionHandle session, string lsid)
    {
        /// <summary>The real session: the engine's own calls and the proxies use it.</summary>
        internal IClientSessionHandle Session { get; } = session;

        /// <summary>The same session as the handler sees it: transaction control joins or is refused.</summary>
        internal IClientSessionHandle? Handle { get; set; }

        internal string Lsid { get; } = lsid;

        /// <summary>Set once a write carried the session to the server.</summary>
        internal bool Used { get; set; }

        private volatile bool _sent;
        private volatile bool _abortAcknowledged;

        /// <summary>
        /// Set once any command carried the session to the server: from then on the server may hold the transaction, and
        /// its locks, until an abort reaches it.
        /// </summary>
        internal bool Sent { get => _sent; set => _sent = value; }

        /// <summary>Set when the server answered the abort: acknowledged it, or said the transaction no longer exists.</summary>
        internal bool AbortAcknowledged { get => _abortAcknowledged; set => _abortAcknowledged = value; }

        internal bool Finished { get; set; }

        internal Dictionary<string, Candidate> Candidates { get; } = [];

        internal List<Filter> Filters { get; } = [];

        /// <summary>
        /// The transaction's snapshot time: the <c>operationTime</c> of the first reply to a command the Preview session
        /// sent. <c>before</c> images are read at this time, so a concurrent commit by another request never shows up as a
        /// Preview change.
        /// </summary>
        internal BsonValue? StartTime { get; set; }

        /// <summary>Aborts the transaction when the Preview outlives its time limit.</summary>
        internal Timer? Timer { get; set; }
    }

    /// <summary>One document a Preview may have changed, and how.</summary>
    internal sealed record Candidate(string Namespace, string Collection, BsonValue Id, string? Via);

    /// <summary>A filter whose matches, before and inside the transaction, are change candidates.</summary>
    internal sealed record Filter(string Namespace, string Collection, BsonDocument Match, string? Via);

    /// <summary>A command seen by monitoring, kept until its reply arrives.</summary>
    /// <remarks>
    /// The driver hands monitoring events a view over the wire buffer that is released when the handler returns, so
    /// everything a later reply needs (the session id, the sanitized text) is copied out here.
    /// </remarks>
    private sealed record Pending(SendproofPreview? Capture, SendproofPreview? Preview, string Name, string Namespace, string? Target,
        string Statement, long Started, string? Lsid);

    // ---- Wiring ----

    /// <summary>Subscribes the engine's command monitoring to a cluster being built.</summary>
    internal void Subscribe(ClusterBuilder builder)
    {
        if (!MonitoringEnabled)
        {
            return;
        }

        builder
            .Subscribe<CommandStartedEvent>(OnStarted)
            .Subscribe<CommandSucceededEvent>(OnSucceeded)
            .Subscribe<CommandFailedEvent>(OnFailed);
    }

    /// <summary>Runs engine-internal commands (topology, change capture, abort) without logging or tripping.</summary>
    internal async Task<T> InternalAsync<T>(Func<Task<T>> work)
    {
        var previous = _internal.Value;
        _internal.Value = true;
        try
        {
            return await work().ConfigureAwait(false);
        }
        finally
        {
            _internal.Value = previous;
        }
    }

    /// <summary>Detects the topology once: <c>preview</c> on a replica set or mongos with logical sessions.</summary>
    internal async Task<(string Mode, string? Reason)> DetectAsync()
    {
        Task<(string Mode, string? Reason, bool Succeeded)> detection;
        lock (_detectGate)
        {
            detection = _detected ??= DetectCoreAsync();
        }

        var (mode, reason, succeeded) = await detection;
        if (!succeeded)
        {
            // Unreachable or unrecognised: guard mode for now, and ask again next time.
            _ = Interlocked.CompareExchange(ref _detected, null, detection);
        }

        return (mode, reason);
    }

    private async Task<(string Mode, string? Reason, bool Succeeded)> DetectCoreAsync()
    {
        try
        {
            BsonDocument hello;
            bool monitored;
            if (HelloOverride is { } simulated)
            {
                hello = await simulated();
                monitored = true;
            }
            else
            {
                var token = ProbePrefix + Guid.NewGuid().ToString("N");
                hello = await InternalAsync(() => Client.GetDatabase("admin")
                    .RunCommandAsync<BsonDocument>(new BsonDocument { { "hello", 1 }, { "comment", token } }));
                monitored = _probesSeen.TryRemove(token, out _);
            }

            var transactions = (hello.Contains("setName") || hello.GetValue("msg", BsonNull.Value) == "isdbgrid") &&
                hello.GetValue("logicalSessionTimeoutMinutes", BsonNull.Value) is { IsBsonNull: false };
            if (transactions && !monitored)
            {
                // Without the monitor an escaped write is invisible, so a rollback could be claimed falsely: stay in guard mode.
                return ("guard", UnmonitoredReason, true);
            }

            return transactions ? ("preview", null, true) : ("guard", StandaloneReason, true);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // Guard mode for now, and ask again next time. A server that answered with an error is a reply this doesn't
            // recognise; one that couldn't be reached proves nothing about transactions, and says so.
            LastDetectionError = error;
            return ("guard", error is MongoServerException ? StandaloneReason : UnreachableReason, false);
        }
    }

    /// <summary>The current Preview's state, when this code runs in a <c>preview</c>-mode Preview that began.</summary>
    internal PreviewState? StateOf(SendproofPreview? preview) =>
        preview is not null && _states.TryGetValue(preview, out var state) ? state : null;

    private string ModeOf(SendproofPreview preview) => _modes.TryGetValue(preview, out var mode) ? mode : "guard";

    /// <summary>
    /// Prepares a Preview: detects the mode and, in <c>preview</c> mode, starts the Preview's session and transaction. The
    /// handler's view of the session joins the Preview transaction instead of ending it.
    /// </summary>
    internal async Task BeginAsync(SendproofPreview preview, CancellationToken cancellationToken)
    {
        if (_states.TryGetValue(preview, out _) || _modes.TryGetValue(preview, out _))
        {
            return;
        }

        var (mode, _) = await DetectAsync();
        _modes.Add(preview, mode);
        if (mode != "preview")
        {
            return;
        }

        var session = await Client.StartSessionAsync(cancellationToken: cancellationToken);
        PreviewState? state = null;
        try
        {
            session.StartTransaction(new TransactionOptions(ReadConcern.Snapshot, writeConcern: WriteConcern.WMajority));
            var lsid = HexOf(session.WrappedCoreSession.ServerSession.Id) ??
                throw new InvalidOperationException("The MongoDB driver did not expose the Preview session id.");
            state = new PreviewState(session, lsid);
            state.Handle = GuardedSession.Create(this, state, preview);
            _states.Add(preview, state);
            _byLsid[lsid] = state;

            // A handler still running at the limit loses its transaction: later commands fail, nothing commits, and the
            // Preview answers 500 when it ends.
            state.Timer = new Timer(_ =>
            {
                preview.Refuse(new PreviewTransactionControlException(
                    $"The Preview ran longer than {(int)_timeout.TotalMilliseconds} ms, so its MongoDB transaction was aborted."));
                _ = EndAsync(state);
            }, null, _timeout, Timeout.InfiniteTimeSpan);
        }
        catch
        {
            if (state is null)
            {
                session.Dispose();
            }
            else
            {
                await EndAsync(state);
            }

            throw;
        }
    }

    // ---- Guard ----

    /// <summary>
    /// Classifies a command before it is sent and lets the guard refuse it. In <c>guard</c> mode every write blocks; in
    /// <c>preview</c> mode only what MongoDB can't run inside a transaction does. A command on the admin, config or local
    /// database runs outside the transaction, so its writes block too.
    /// </summary>
    internal void Check(BsonDocument command, string operation, string? database)
    {
        if (_capture.Current is not { InPreview: true } preview)
        {
            // A write through a guarded handle that carries no request, while a Preview is open, is refused before it is sent:
            // it blocks every open Preview with a 409, whatever the mode, because nothing reached the server.
            if (MongoClassifier.Classify(command, _reads).Kind == CommandKind.Write)
            {
                _capture.RefuseUnattributedWrite("mongodb", operation);
            }

            return;
        }

        if (EndsTransaction(operation.ToLowerInvariant()))
        {
            throw _capture.RefuseInPreview($"Preview owns the MongoDB transaction, so the handler's {operation} cannot run during Preview.")!;
        }

        var (kind, refused) = MongoClassifier.Classify(command, _reads);
        if (ModeOf(preview) == "preview" && !IsSystemDatabase(database))
        {
            if (refused is not null)
            {
                _capture.Check("mongodb", operation, CommandKind.Write, RefusedReason(refused));
            }

            return;
        }

        _capture.Check("mongodb", operation, kind);
    }

    /// <summary>The reason for a command MongoDB refuses inside a transaction.</summary>
    internal static string RefusedReason(string operation) =>
        StoreTables.Mongo.ReasonTemplate.Replace("{operation}", operation, StringComparison.Ordinal);

    /// <summary>Commands that end a transaction. In a Preview only the engine may send them.</summary>
    private static bool EndsTransaction(string name) => name is "committransaction" or "aborttransaction";

    /// <summary>Commands on these databases can't join a transaction.</summary>
    internal static bool IsSystemDatabase(string? name) => name is "admin" or "config" or "local";

    // ---- Monitoring ----

    private SendproofPreview? CurrentPreview => _capture.Current is { InPreview: true } preview ? preview : null;

    private void OnStarted(CommandStartedEvent started)
    {
        var command = started.Command;
        if (command.TryGetValue("comment", out var comment) && comment is BsonString commentText &&
            commentText.Value.StartsWith(ProbePrefix, StringComparison.Ordinal))
        {
            _probesSeen[commentText.Value] = 0;
        }

        // Before the internal check: the engine sends the abort itself.
        if (!_byLsid.IsEmpty && command.TryGetValue("lsid", out var sessionValue) && sessionValue is BsonDocument sessionDocument &&
            HexOf(sessionDocument) is { } sessionId && _byLsid.TryGetValue(sessionId, out var own))
        {
            if (started.CommandName == "abortTransaction")
            {
                _aborts[started.RequestId] = own;
            }
            else
            {
                own.Sent = true;
            }
        }

        if (_internal.Value)
        {
            return;
        }

        var name = started.CommandName;
        var lower = name.ToLowerInvariant();
        var kind = MongoClassifier.Classify(command, _reads).Kind;
        var preview = CurrentPreview;
        var database = started.DatabaseNamespace.DatabaseName;
        if (kind == CommandKind.Write)
        {
            // A write nobody can attribute to a request fails every open Preview (unless the worker is marked detached).
            _capture.ReportWrite("mongodb", name);
        }

        if (preview is not null && EndsTransaction(lower))
        {
            // Sent around the hook: it may have committed the Preview transaction, so the Preview can never be confirmed.
            preview.Refuse(new PreviewTransactionControlException($"A MongoDB {name} reached the server during a Preview; the Preview can't be confirmed."));
        }
        else if (preview is not null && kind == CommandKind.Write)
        {
            WatchWrite(preview, command, database, lower);
        }

        if (kind == CommandKind.Session || Sensitive.Contains(lower))
        {
            return;
        }

        var target = command.ElementCount > 0 && command[0] is BsonString text ? text.Value : null;
        var body = new BsonDocument(command.Where(element => !Envelope.Contains(element.Name)));
        var lsid = command.TryGetValue("lsid", out var lsidValue) && lsidValue is BsonDocument lsidDocument ? HexOf(lsidDocument) : null;
        _pending[started.RequestId] = new Pending(_capture.Current, preview, name, database, target,
            BsonJson.Text(BsonJson.Sanitize(body)), Stopwatch.GetTimestamp(), lsid);
    }

    /// <summary>A write seen during a Preview: collect change candidates, or trip if it escaped the session.</summary>
    private void WatchWrite(SendproofPreview preview, BsonDocument command, string database, string name)
    {
        var state = StateOf(preview);
        var lsid = command.TryGetValue("lsid", out var lsidValue) && lsidValue is BsonDocument lsidDocument ? HexOf(lsidDocument) : null;
        // Only a command inside the Preview transaction (its lsid and autocommit: false) rolls back.
        if (state is null || state.Finished || lsid != state.Lsid || command.GetValue("autocommit", BsonNull.Value) != BsonBoolean.False)
        {
            // The hook couldn't stop it and nothing can undo it: never claim a rollback.
            preview.Refuse(new PreviewTransactionControlException($"A MongoDB {name} escaped the Preview session; the Preview can't be confirmed."));
            return;
        }

        state.Used = true;
        var collection = command.ElementCount > 0 && command[0] is BsonString text ? text.Value : "";
        switch (name)
        {
            case "insert" when command.GetValue("documents", null) is BsonArray documents:
                foreach (var document in documents.OfType<BsonDocument>())
                {
                    AddCandidate(state, new Candidate(database, collection, document.GetValue("_id", BsonNull.Value), null), document.Contains("_id"));
                }

                break;
            case "update" when command.GetValue("updates", null) is BsonArray updates:
                foreach (var update in updates.OfType<BsonDocument>())
                {
                    var via = update.GetValue("upsert", false).ToBoolean() ? "upsert" : Replaces(update.GetValue("u", null)) ? "replace" : null;
                    state.Filters.Add(new Filter(database, collection, Detach(update.GetValue("q", null)), via));
                }

                break;
            case "delete" when command.GetValue("deletes", null) is BsonArray deletes:
                foreach (var remove in deletes.OfType<BsonDocument>())
                {
                    state.Filters.Add(new Filter(database, collection, Detach(remove.GetValue("q", null)), null));
                }

                break;
            case "findandmodify":
                var modifyVia = command.GetValue("upsert", false).ToBoolean() ? "upsert" : Replaces(command.GetValue("update", null)) ? "replace" : null;
                state.Filters.Add(new Filter(database, collection, Detach(command.GetValue("query", null)), modifyVia));
                break;
            case "bulkwrite" when command.GetValue("ops", null) is BsonArray ops && command.GetValue("nsInfo", null) is BsonArray nsInfo:
                // The client-level bulkWrite command: each op names its namespace by index.
                var namespaces = nsInfo.OfType<BsonDocument>().Select(info => info["ns"].AsString.Split('.', 2)).ToArray();
                foreach (var op in ops.OfType<BsonDocument>())
                {
                    var index = (op.GetValue("insert", null) ?? op.GetValue("update", null) ?? op.GetValue("delete", null))?.ToInt32() ?? -1;
                    var (opDatabase, opCollection) = index >= 0 && index < namespaces.Length && namespaces[index].Length == 2
                        ? (namespaces[index][0], namespaces[index][1])
                        : (database, "");
                    if (op.GetValue("document", null) is BsonDocument inserted)
                    {
                        AddCandidate(state, new Candidate(opDatabase, opCollection, inserted.GetValue("_id", BsonNull.Value), null), inserted.Contains("_id"));
                    }
                    else
                    {
                        state.Filters.Add(new Filter(opDatabase, opCollection, Detach(op.GetValue("filter", null)),
                            op.GetValue("upsert", false).ToBoolean() ? "upsert" : null));
                    }
                }

                break;
        }
    }

    /// <summary>A copy of a document that outlives the event: the driver's event values are views over a buffer released when the handler returns.</summary>
    private static BsonDocument Detach(BsonValue? value) => value is BsonDocument document ? (BsonDocument)document.DeepClone() : [];

    /// <summary>Whether an update document replaces the whole document rather than applying operators.</summary>
    private static bool Replaces(BsonValue? update) => update is BsonDocument { ElementCount: > 0 } document && !document.GetElement(0).Name.StartsWith('$');

    private static void AddCandidate(PreviewState state, Candidate candidate, bool hasId = true)
    {
        if (!hasId)
        {
            return;
        }

        candidate = candidate with { Id = candidate.Id.DeepClone() };
        var key = $"{candidate.Namespace}\0{candidate.Collection}\0{BsonJson.Plain(candidate.Id)?.ToJsonString()}";
        if (!state.Candidates.TryGetValue(key, out var known) || known.Via is null && candidate.Via is not null)
        {
            state.Candidates[key] = candidate;
        }
    }

    private void OnSucceeded(CommandSucceededEvent succeeded)
    {
        if (_aborts.TryRemove(succeeded.RequestId, out var aborted))
        {
            aborted.AbortAcknowledged = true;
        }

        if (!_pending.TryRemove(succeeded.RequestId, out var pending))
        {
            return;
        }

        var reply = succeeded.Reply;
        var state = StateOf(pending.Preview);
        // The first reply in the transaction carries its snapshot time (the read timestamp).
        if (state is not null && state.StartTime is null && reply.TryGetValue("operationTime", out var operationTime) && pending.Lsid == state.Lsid)
        {
            // Copied: the reply's own value is a view over a buffer that is released when this handler returns.
            state.StartTime = operationTime.DeepClone();
        }

        if (state is not null && pending.Target is not null)
        {
            // Upserted ids appear only in the reply.
            if (reply.GetValue("upserted", null) is BsonArray upserted)
            {
                foreach (var item in upserted.OfType<BsonDocument>())
                {
                    AddCandidate(state, new Candidate(pending.Namespace, pending.Target, item.GetValue("_id", BsonNull.Value), "upsert"), item.Contains("_id"));
                }
            }

            if (pending.Name.Equals("findAndModify", StringComparison.OrdinalIgnoreCase) &&
                reply.GetValue("value", null) is BsonDocument value && value.Contains("_id"))
            {
                AddCandidate(state, new Candidate(pending.Namespace, pending.Target, value["_id"], null));
            }

            if (reply.GetValue("lastErrorObject", null) is BsonDocument last && last.TryGetValue("upserted", out var one))
            {
                AddCandidate(state, new Candidate(pending.Namespace, pending.Target, one, "upsert"));
            }
        }

        int? rows = null;
        if (reply.GetValue("cursor", null) is BsonDocument cursor)
        {
            rows = (cursor.GetValue("firstBatch", null) ?? cursor.GetValue("nextBatch", null)) is BsonArray batch ? batch.Count : 0;
        }
        else if (reply.GetValue("n", null) is { IsNumeric: true } n)
        {
            rows = n.ToInt32();
        }

        Log(pending, succeeded.Duration, rows, null);
    }

    private void OnFailed(CommandFailedEvent failed)
    {
        // NoSuchTransaction: the server has no such transaction, so nothing holds its locks. A network error proves
        // nothing reached the server, and any other answer leaves the transaction in doubt.
        if (_aborts.TryRemove(failed.RequestId, out var aborted) && (failed.Failure as MongoCommandException)?.Code == NoSuchTransaction)
        {
            aborted.AbortAcknowledged = true;
        }

        if (!_pending.TryRemove(failed.RequestId, out var pending))
        {
            return;
        }

        var failure = failed.Failure;
        var code = (failure as MongoCommandException)?.Code ?? (failure as MongoWriteException)?.WriteError?.Code;
        // The server refused something a transaction can't do and applied nothing: a block, not a crash.
        if (pending.Preview is not null && StateOf(pending.Preview) is not null && code == 263)
        {
            pending.Preview.Block(new BlockedWrite("mongodb", pending.Name, RefusedReason(pending.Name)));
        }

        var name = (failure as MongoCommandException)?.CodeName is { Length: > 0 } codeName ? codeName : failure.GetType().Name;
        Log(pending, failed.Duration, null, name);
    }

    private static void Log(Pending pending, TimeSpan duration, int? rows, string? error) =>
        pending.Capture?.RecordDb(new DbEntry("mongodb", pending.Name)
        {
            Namespace = pending.Namespace,
            Target = pending.Target,
            Statement = pending.Statement,
            RowsAffected = rows,
            Error = error,
            ElapsedMs = duration.TotalMilliseconds
        });

    // ---- Finish ----

    /// <summary>
    /// After the handler: captures document changes, then aborts the transaction and ends the session. A capture read
    /// that fails for any reason but an already-aborted transaction throws, after the abort, so the Preview answers 500.
    /// Nothing the Preview wrote is ever committed: no <c>commitTransaction</c> is ever sent for the Preview session.
    /// </summary>
    internal async Task FinishAsync(SendproofPreview preview, CancellationToken cancellationToken)
    {
        var state = StateOf(preview);
        if (state is null || state.Finished)
        {
            return;
        }

        Exception? failure = null;
        Exception? ending = null;
        try
        {
            if (state.Used)
            {
                await InternalAsync(async () =>
                {
                    await CaptureAsync(preview, state, cancellationToken).ConfigureAwait(false);
                    return true;
                }).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // A failed command inside a transaction makes the server abort it: nothing to capture.
            if ((error as MongoCommandException)?.CodeName != "NoSuchTransaction")
            {
                failure = error;
            }
        }
        finally
        {
            // Every cleanup step runs: a failed capture never skips the abort, and a failed abort is reported below.
            ending = await EndAsync(state).ConfigureAwait(false);
        }

        if ((failure ?? ending) is { } cleanupFailure)
        {
            throw cleanupFailure;
        }
    }

    /// <summary>
    /// Aborts the Preview transaction and ends its session, once.
    /// <para>
    /// The driver ignores abort errors, as the transactions specification requires: an unacknowledged abort still commits
    /// nothing, because no <c>commitTransaction</c> is ever sent for the Preview session. But the server then keeps the
    /// transaction, and its locks, until its 60-second lifetime limit. So when a command was sent on the session and the
    /// server didn't answer the abort, this returns a failure at once (the Preview answers 500) and kills the session in
    /// the background.
    /// </para>
    /// </summary>
    private async Task<Exception?> EndAsync(PreviewState state)
    {
        lock (state)
        {
            if (state.Finished)
            {
                return null;
            }

            state.Finished = true;
        }

        state.Timer?.Dispose();
        return await InternalAsync(async () =>
        {
            Exception? failure = null;
            try
            {
                if (AbortOverride is { } simulated)
                {
                    await simulated(state.Session).ConfigureAwait(false);
                }
                else if (state.Session.IsInTransaction)
                {
                    await state.Session.AbortTransactionAsync().ConfigureAwait(false);
                    // A handler command that passed the guard just before the end must not autocommit on the ended
                    // session: open a fresh transaction (client-side only) that is never committed and is aborted when
                    // the session is disposed.
                    state.Session.StartTransaction(new TransactionOptions(ReadConcern.Snapshot, writeConcern: WriteConcern.WMajority));
                }
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                // Nothing was committed, but the abort didn't complete: the Preview can't claim a clean rollback.
                failure = error;
            }

            if (state.Sent && !state.AbortAcknowledged)
            {
                // The server may still hold the transaction's locks. The session stays open until the kill is over.
                _ = Task.Run(() => KillAsync(state));
                return failure ?? new InvalidOperationException(
                    "MongoDB didn't acknowledge the abort of the Preview transaction, so the rollback can't be confirmed.");
            }

            return Close(state) ?? failure;
        }).ConfigureAwait(false);
    }

    /// <summary>Ends the session, after which the driver may hand its id to another operation.</summary>
    private Exception? Close(PreviewState state)
    {
        _byLsid.TryRemove(new KeyValuePair<string, PreviewState>(state.Lsid, state));
        try
        {
            state.Session.Dispose();
            return null;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            return error;
        }
    }

    /// <summary>
    /// Ends the Preview transaction with <c>killSessions</c> after an abort the server never answered (the connection
    /// dropped), retrying with backoff while the server can't be reached. A final failure is logged with the session id:
    /// the server ends the transaction at its lifetime limit. The session stays open until then, so the driver can't hand
    /// its id to another operation meanwhile. Each try waits at most the client's server selection timeout.
    /// </summary>
    private async Task KillAsync(PreviewState state)
    {
        string failure;
        try
        {
            // The id may still name a transaction on the server: never let the driver's pool reuse it.
            state.Session.WrappedCoreSession.MarkDirty();
            var command = new BsonDocument("killSessions", new BsonArray { state.Session.WrappedCoreSession.ServerSession.Id.DeepClone() });
            var started = Stopwatch.GetTimestamp();
            var delay = KillFirstDelay;
            while (true)
            {
                try
                {
                    await InternalAsync(() => Client.GetDatabase("admin").RunCommandAsync<BsonDocument>(command)).ConfigureAwait(false);
                    return;
                }
                catch (Exception unreachable) when (unreachable is MongoConnectionException or TimeoutException)
                {
                    // A network error or no server to select: try again shortly.
                    var left = KillRetryLimit - Stopwatch.GetElapsedTime(started);
                    if (left <= TimeSpan.Zero)
                    {
                        failure = $"MongoDB couldn't be reached for {KillRetryLimit.TotalSeconds:0} s";
                        break;
                    }

                    await Task.Delay(delay < left ? delay : left).ConfigureAwait(false);
                    delay = delay * 2 < KillMaxDelay ? delay * 2 : KillMaxDelay;
                }
            }
        }
        catch (Exception refused) when (refused is not OutOfMemoryException)
        {
            failure = refused.Message;
        }
        finally
        {
            _ = Close(state);
        }

        (Logger ?? NullLogger.Instance).LogWarning(
            "Couldn't end the transaction of MongoDB Preview session {Session} ({Failure}); the server ends it, and releases its locks, at transactionLifetimeLimitSeconds.",
            state.Lsid, failure);
    }

    /// <summary>
    /// Finds documents as they were when the Preview transaction started: a snapshot read at its start time, outside the
    /// transaction. Without a start time (no reply carried one) it reads the majority-committed view, which the spec allows:
    /// nothing the Preview wrote is committed, so the only difference is a concurrent commit by another request.
    /// </summary>
    private async Task<List<BsonDocument>> AtStartAsync(PreviewState state, string database, string collection, BsonDocument filter, bool idOnly, CancellationToken cancellationToken)
    {
        var readConcern = state.StartTime is null
            ? new BsonDocument("level", "majority")
            : new BsonDocument { { "level", "snapshot" }, { "atClusterTime", state.StartTime } };
        var command = new BsonDocument
        {
            { "find", collection }, { "filter", filter },
            { "batchSize", CandidateLimit }, { "limit", CandidateLimit }, { "singleBatch", true },
            { "readConcern", readConcern }
        };
        if (idOnly)
        {
            command.Add("projection", new BsonDocument("_id", 1));
        }

        try
        {
            var reply = await Client.GetDatabase(database).RunCommandAsync<BsonDocument>(command, cancellationToken: cancellationToken).ConfigureAwait(false);
            return [.. reply["cursor"]["firstBatch"].AsBsonArray.OfType<BsonDocument>()];
        }
        catch (MongoCommandException error) when (AbsentAtStart.Contains(error.Code))
        {
            // The collection was created after the start time: nothing in it existed then.
            return [];
        }
    }

    /// <summary>Compares each candidate's start-time and in-transaction versions and records the differences.</summary>
    private async Task CaptureAsync(SendproofPreview preview, PreviewState state, CancellationToken cancellationToken)
    {
        var session = state.Session;
        foreach (var filter in state.Filters.ToArray())
        {
            var target = Client.GetDatabase(filter.Namespace).GetCollection<BsonDocument>(filter.Collection);
            var inside = await (await target.FindAsync(session, new BsonDocumentFilterDefinition<BsonDocument>(filter.Match),
                new FindOptions<BsonDocument> { Projection = new BsonDocument("_id", 1) }, cancellationToken).ConfigureAwait(false)).ToListAsync(cancellationToken).ConfigureAwait(false);
            var before = await AtStartAsync(state, filter.Namespace, filter.Collection, filter.Match, true, cancellationToken).ConfigureAwait(false);
            foreach (var document in inside.Concat(before))
            {
                AddCandidate(state, new Candidate(filter.Namespace, filter.Collection, document["_id"], filter.Via));
                if (state.Candidates.Count >= CandidateLimit)
                {
                    break;
                }
            }
        }

        var read = 0;
        foreach (var (_, candidate) in state.Candidates.ToArray())
        {
            if (read++ >= CandidateLimit)
            {
                preview.TruncateChanges();
                break;
            }

            var target = Client.GetDatabase(candidate.Namespace).GetCollection<BsonDocument>(candidate.Collection);
            var was = (await AtStartAsync(state, candidate.Namespace, candidate.Collection, new BsonDocument("_id", candidate.Id), false, cancellationToken).ConfigureAwait(false)).FirstOrDefault();
            var now = await (await target.FindAsync(session, new BsonDocumentFilterDefinition<BsonDocument>(new BsonDocument("_id", candidate.Id)), cancellationToken: cancellationToken)
                .ConfigureAwait(false)).FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
            var (wasJson, nowJson) = (was is null ? null : BsonJson.Plain(was), now is null ? null : BsonJson.Plain(now));
            if (JsonNode.DeepEquals(wasJson, nowJson))
            {
                continue;
            }

            var operation = was is null ? "insert" : now is null ? "delete" : "update";
            preview.RecordChange(new PreviewChange(operation, candidate.Collection,
                new JsonObject { ["_id"] = BsonJson.Plain(candidate.Id) }, wasJson, nowJson)
            {
                Store = "mongodb",
                Namespace = candidate.Namespace,
                Via = candidate.Via is not null && operation != "delete" ? candidate.Via : null
            });
        }
    }

    /// <summary>Hex of a session id document (<c>{ id: BinData(4, …) }</c>), comparable across commands.</summary>
    internal static string? HexOf(BsonDocument? lsid) =>
        lsid is not null && lsid.TryGetValue("id", out var id) && id is BsonBinaryData binary ? Convert.ToHexString(binary.Bytes) : null;

    /// <summary>Disposes the instrumented client and the registered one.</summary>
    internal void DisposeClients()
    {
        Client.Dispose();
        Original?.Dispose();
    }
}

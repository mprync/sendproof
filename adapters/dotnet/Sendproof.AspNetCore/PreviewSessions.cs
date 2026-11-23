using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

/// <summary>
/// A preview provider or data store that can hold its transaction across the requests of a preview session
/// (spec/README.md "Preview sessions"). A store that implements nothing here holds nothing: a guard store keeps blocking
/// writes in every step.
/// </summary>
internal interface IPreviewSessionSource
{
    /// <summary>Why this store can't hold a session on this host, or <see langword="null"/> when it can.</summary>
    string? SessionUnavailableReason => null;

    /// <summary>
    /// Opens the store's held transaction for a new session, or answers <see langword="null"/> when there is nothing to
    /// hold (MongoDB in guard mode). The store owns cleanup of anything it acquired before a failure.
    /// </summary>
    ValueTask<IHeldPreview?> HoldAsync(HttpContext context, CancellationToken cancellationToken);
}

/// <summary>One store's transaction, held for the whole of a preview session, with a savepoint before each step.</summary>
internal interface IHeldPreview
{
    /// <summary>Why the store ended the transaction on its own (MongoDB's transaction lifetime limit), or <see langword="null"/>.</summary>
    string? EndedReason => null;

    /// <summary>Gets the changes of the step that just ran, available after <see cref="KeepStepAsync"/>.</summary>
    IReadOnlyList<PreviewChange> Changes => [];

    /// <summary>Gets whether the provider omitted some of the step's changes at a capture limit.</summary>
    bool ChangesTruncated => false;

    /// <summary>Joins the held transaction in this request's scope and takes the savepoint before step <paramref name="step"/>.</summary>
    ValueTask BeginStepAsync(HttpContext context, SendproofPreview preview, int step, CancellationToken cancellationToken);

    /// <summary>Proves the held transaction is still the one the session opened, and keeps the step's writes in it.</summary>
    /// <exception cref="PreviewStepUndoneException">The step couldn't be kept and was rolled back to its savepoint.</exception>
    ValueTask KeepStepAsync(CancellationToken cancellationToken);

    /// <summary>Rolls back to the savepoint taken before the step that just ran.</summary>
    ValueTask UndoStepAsync(CancellationToken cancellationToken);

    /// <summary>Rolls back to the savepoint taken before step <paramref name="step"/>, discarding it and every later step.</summary>
    ValueTask RewindAsync(int step, CancellationToken cancellationToken);

    /// <summary>Rolls the whole transaction back and releases its connection or session. Runs once.</summary>
    ValueTask EndAsync();
}

/// <summary>
/// A store ended the session's transaction on its own, such as MongoDB at its transaction lifetime limit. The session is
/// closed and rolled back, and the request answers 409 <c>session_failed</c>.
/// </summary>
internal sealed class PreviewSessionFailedException(string message, Exception? innerException = null) : Exception(message, innerException);

/// <summary>
/// A store couldn't be held because another session or transaction already holds it (SQLite's write lock, a database
/// lock timeout). Opening the session answers 409 <c>store_busy</c> within seconds, in place of a 500 after the driver's
/// own timeout.
/// </summary>
internal sealed class PreviewStoreBusyException(string store, Exception? innerException = null)
    : Exception($"Another Preview session is holding {store}.", innerException)
{
    /// <summary>The store as people name it: the database file or name, or the kind of store.</summary>
    internal string Store { get; } = store;
}

/// <summary>A step couldn't be kept, so it was rolled back to its savepoint; the session stays usable at that step.</summary>
internal sealed class PreviewStepUndoneException(string message, Exception? innerException = null) : Exception(message, innerException);

/// <summary>
/// Who may use a session: the caller's stable subject when authenticated (as for traces), or nobody but the holder of its
/// ID when anonymous. A signed-in caller never reaches an anonymous session, nor the reverse.
/// </summary>
internal sealed record SessionOwner(TraceOwner? Subject, string PathBase)
{
    /// <summary>The caller's owner, or <see langword="null"/> when the caller is authenticated without one stable subject.</summary>
    internal static SessionOwner? From(HttpContext context)
    {
        var pathBase = context.Request.PathBase.Value ?? "";
        if (pathBase.Length > 4096)
        {
            return null;
        }

        if (!context.User.Identities.Any(identity => identity.IsAuthenticated))
        {
            return new SessionOwner(null, pathBase);
        }

        return TraceOwner.From(context) is { } subject ? new SessionOwner(subject, pathBase) : null;
    }
}

/// <summary>One preview session: its held transactions, its owner, and the step the next Preview runs as.</summary>
internal sealed class PreviewSession(string id, SessionOwner owner, IReadOnlyList<IHeldPreview> parts, long opened)
{
    // One request at a time: the held connection and session can't serve two.
    private readonly SemaphoreSlim _turn = new(1, 1);
    private long _lastUsed = opened;

    internal string Id { get; } = id;
    internal SessionOwner Owner { get; } = owner;

    /// <summary>The held transactions, SQL first, in the order the stores registered.</summary>
    internal IReadOnlyList<IHeldPreview> Parts { get; } = parts;
    internal long Opened { get; } = opened;
    internal long LastUsed => Interlocked.Read(ref _lastUsed);

    /// <summary>The step the next Preview runs as, counting from 1.</summary>
    internal int NextStep { get; set; } = 1;
    internal bool Closed { get; set; }

    /// <summary>Why a store ended the transaction on its own, if one did.</summary>
    internal string? EndedReason => Parts.Select(part => part.EndedReason).FirstOrDefault(reason => reason is not null);

    internal bool TryEnter() => _turn.Wait(0);

    internal Task<bool> TryEnterWithin(TimeSpan timeout) => _turn.WaitAsync(timeout);

    internal void Exit(long now)
    {
        Interlocked.Exchange(ref _lastUsed, now);
        _turn.Release();
    }
}

/// <summary>How a session request was refused: the problem's status, code and title.</summary>
internal sealed record SessionRefusal(int Status, string Code, string Title)
{
    internal static SessionRefusal NotFound { get; } = new(StatusCodes.Status404NotFound, "session_not_found",
        "The preview session was not found. It may have ended or expired.");

    internal static SessionRefusal Busy { get; } = new(StatusCodes.Status409Conflict, "session_busy",
        "The preview session is busy: it takes one request at a time.");

    internal static SessionRefusal Failed { get; } = new(StatusCodes.Status409Conflict, "session_failed",
        "The preview session failed: a store ended its transaction, so the session was closed and rolled back.");

    /// <summary>Opening was refused because another session or transaction holds <paramref name="store"/>.</summary>
    internal static SessionRefusal StoreBusy(string store) => new(StatusCodes.Status409Conflict, "store_busy",
        $"Another Preview session is holding {store}.");
}

/// <summary>
/// The preview sessions of this host. Each is closed and rolled back when it is deleted, after its idle timeout or maximum
/// lifetime, and when the host shuts down. A session that is busy when it expires is closed as soon as its request ends.
/// </summary>
internal sealed class PreviewSessionStore : IAsyncDisposable
{
    internal const int PerOwnerLimit = 4;
    internal const int TotalLimit = 16;

    private readonly ConcurrentDictionary<string, PreviewSession> _sessions = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();
    private readonly TimeProvider _clock;
    private readonly ILogger<PreviewSessionStore> _logger;
    private readonly ITimer _timer;
    private int _sweeping;

    public PreviewSessionStore(SendproofOptions options, ILogger<PreviewSessionStore> logger, TimeProvider? clock = null)
    {
        _clock = clock ?? TimeProvider.System;
        _logger = logger;
        IdleTimeout = options.SessionIdleTimeout;
        MaxLifetime = options.SessionMaxLifetime;
        var shortest = IdleTimeout < MaxLifetime ? IdleTimeout : MaxLifetime;
        var period = TimeSpan.FromTicks(Math.Clamp(shortest.Ticks / 4, TimeSpan.FromMilliseconds(100).Ticks, TimeSpan.FromSeconds(15).Ticks));
        // The sweep must not run inside the request that first resolved the store, with that request's capture slot.
        using (ExecutionContext.SuppressFlow())
        {
            _timer = _clock.CreateTimer(_ => _ = SweepAsync(), null, period, period);
        }
    }

    internal TimeSpan IdleTimeout { get; }
    internal TimeSpan MaxLifetime { get; }

    /// <summary>Creates a session over held transactions, or answers <see langword="null"/> when the caller or host is at its limit.</summary>
    internal PreviewSession? Add(SessionOwner owner, IReadOnlyList<IHeldPreview> parts)
    {
        lock (_gate)
        {
            if (_sessions.Count >= TotalLimit || _sessions.Values.Count(session => session.Owner == owner) >= PerOwnerLimit)
            {
                return null;
            }

            // 128 bits from a cryptographic generator, as hex.
            var session = new PreviewSession(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)), owner, parts, _clock.GetTimestamp());
            _sessions[session.Id] = session;
            return session;
        }
    }

    /// <summary>
    /// Takes the session's turn for one request. Unknown, expired and foreign IDs are all "not found"; a session already
    /// serving a request is "busy". Hand the turn back with <see cref="ExitAsync"/>.
    /// </summary>
    internal SessionRefusal? TryEnter(string? id, SessionOwner? owner, out PreviewSession session)
    {
        session = null!;
        if (owner is null || id is null || !_sessions.TryGetValue(id, out var found) || found.Owner != owner)
        {
            return SessionRefusal.NotFound;
        }

        if (!found.TryEnter())
        {
            return SessionRefusal.Busy;
        }

        if (found.Closed || Expired(found))
        {
            _ = CloseAndExitAsync(found);
            return SessionRefusal.NotFound;
        }

        session = found;
        return null;
    }

    /// <summary>Hands the turn back, closing the session if it outlived its maximum lifetime meanwhile.</summary>
    internal async Task ExitAsync(PreviewSession session)
    {
        if (!session.Closed && _clock.GetElapsedTime(session.Opened) >= MaxLifetime)
        {
            await CloseAsync(session);
        }

        session.Exit(_clock.GetTimestamp());
    }

    /// <summary>
    /// Removes the session and rolls back every held transaction. The caller holds the session's turn. A failed rollback is
    /// logged and rethrown after every store has been asked.
    /// </summary>
    internal async Task CloseAsync(PreviewSession session)
    {
        if (!_sessions.TryRemove(new KeyValuePair<string, PreviewSession>(session.Id, session)))
        {
            session.Closed = true;
            return;
        }

        session.Closed = true;
        Exception? failure = null;
        // Data stores end before the SQL transaction, as a single Preview's pipeline does.
        foreach (var part in session.Parts.Reverse())
        {
            try
            {
                await part.EndAsync();
            }
            catch (Exception error)
            {
                failure = failure is null ? error : new AggregateException(failure, error);
            }
        }

        if (failure is not null)
        {
            _logger.LogError(failure, "A Sendproof preview session could not be rolled back cleanly.");
            throw failure;
        }
    }

    private bool Expired(PreviewSession session) =>
        _clock.GetElapsedTime(session.Opened) >= MaxLifetime || _clock.GetElapsedTime(session.LastUsed) >= IdleTimeout;

    private async Task CloseAndExitAsync(PreviewSession session)
    {
        try
        {
            await CloseAsync(session);
        }
        catch (Exception)
        {
            // Logged by CloseAsync.
        }
        finally
        {
            session.Exit(_clock.GetTimestamp());
        }
    }

    private async Task SweepAsync()
    {
        if (Interlocked.Exchange(ref _sweeping, 1) == 1)
        {
            return;
        }

        try
        {
            foreach (var session in _sessions.Values)
            {
                // A busy session is closed when its request hands the turn back.
                if (Expired(session) && session.TryEnter())
                {
                    await CloseAndExitAsync(session);
                }
            }
        }
        finally
        {
            Volatile.Write(ref _sweeping, 0);
        }
    }

    /// <summary>Host shutdown: every session is rolled back.</summary>
    public async ValueTask DisposeAsync()
    {
        await _timer.DisposeAsync();
        foreach (var session in _sessions.Values)
        {
            // Requests have drained by now; a turn still held belongs to a request the host abandoned.
            var entered = await session.TryEnterWithin(TimeSpan.FromSeconds(5));
            try
            {
                await CloseAsync(session);
            }
            catch (Exception)
            {
                // Logged by CloseAsync; shutdown carries on with the other sessions.
            }
            finally
            {
                if (entered)
                {
                    session.Exit(_clock.GetTimestamp());
                }
            }
        }
    }
}

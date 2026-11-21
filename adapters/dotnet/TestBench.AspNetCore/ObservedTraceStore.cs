using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;

namespace TestBench.AspNetCore;

internal sealed record ObservedTrace(PreviewChange[] Changes, PreviewEffect[] Effects, PreviewLog[] Logs, CaptureTiming Timing,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool ChangesTruncated,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool EffectsTruncated,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool LogsTruncated);

internal sealed record TraceOwner(string AuthenticationType, string ClaimType, string Issuer, string Subject, string PathBase)
{
    internal static TraceOwner? From(HttpContext context)
    {
        var pathBase = context.Request.PathBase.Value ?? "";
        if (pathBase.Length > 4096)
        {
            return null;
        }

        TraceOwner? owner = null;
        foreach (var identity in context.User.Identities.Where(identity => identity.IsAuthenticated))
        {
            var subject = identity.FindFirst(ClaimTypes.NameIdentifier) ?? identity.FindFirst("sub");
            if (identity.AuthenticationType is not { Length: <= 256 } authenticationType ||
                subject is not { Value.Length: > 0 and <= 256, Issuer.Length: <= 256 })
            {
                return null;
            }

            var candidate = new TraceOwner(authenticationType, subject.Type, subject.Issuer, subject.Value, pathBase);
            if (owner is not null && owner != candidate)
            {
                return null;
            }

            owner = candidate;
        }

        return owner;
    }
}

internal sealed class ObservedTraceStore : IDisposable
{
    private const int PerOwnerLimit = 8;
    private const int TotalLimit = 32;
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private readonly Lock _gate = new();
    private readonly LinkedList<Reservation> _entries = new();
    private readonly TimeProvider _clock;
    private readonly ITimer _timer;

    public ObservedTraceStore(TimeProvider? clock = null)
    {
        _clock = clock ?? TimeProvider.System;
        _timer = _clock.CreateTimer(_ => Expire(), null, Lifetime, TimeSpan.FromMinutes(1));
    }

    internal Reservation Reserve(TraceOwner owner)
    {
        lock (_gate)
        {
            Expire();
            var previous = _entries.Where(entry => entry.Owner == owner).Take(PerOwnerLimit).ToArray();
            if (previous.Length == PerOwnerLimit)
            {
                Remove(previous[0]);
            }

            if (_entries.Count == TotalLimit)
            {
                Remove(_entries.First!.Value);
            }

            var entry = new Reservation(Guid.NewGuid(), owner, _clock.GetTimestamp());
            _entries.AddLast(entry);
            return entry;
        }
    }

    internal async Task<ObservedTrace?> ReadAsync(Guid id, TraceOwner owner, CancellationToken cancellationToken)
    {
        Task<ObservedTrace?>? result;
        lock (_gate)
        {
            Expire();
            result = _entries.FirstOrDefault(entry => entry.Id == id && entry.Owner == owner)?.Result.Task;
        }

        if (result is null)
        {
            return null;
        }

        try
        {
            return await result.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
        }
        catch (TimeoutException)
        {
            return null;
        }
    }

    internal void Discard(Reservation entry)
    {
        lock (_gate)
        {
            Remove(entry);
        }
    }

    public void Dispose()
    {
        _timer.Dispose();
        lock (_gate)
        {
            while (_entries.First is { } first)
            {
                Remove(first.Value);
            }
        }
    }

    private void Expire()
    {
        lock (_gate)
        {
            while (_entries.First is { } first && _clock.GetElapsedTime(first.Value.Start) >= Lifetime)
            {
                Remove(first.Value);
            }
        }
    }

    private void Remove(Reservation entry)
    {
        _entries.Remove(entry);
        entry.Result.TrySetResult(null);
    }

    internal sealed record Reservation(Guid Id, TraceOwner Owner, long Start)
    {
        internal TaskCompletionSource<ObservedTrace?> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}

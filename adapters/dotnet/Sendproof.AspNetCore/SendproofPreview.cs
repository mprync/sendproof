using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Sendproof.AspNetCore;

/// <summary>Lets host-owned adapters record effects and logs within an active Sendproof request.</summary>
public sealed class SendproofPreview
{
    private readonly Lock _gate = new();
    private readonly List<PreviewEffect> _effects = [];
    private readonly List<PreviewLog> _logs = [];
    private bool _active;
    private bool _rollback;
    private bool _logsTruncated;
    private bool _effectsTruncated;
    private int _logSize;
    private int _effectSize;
    private long _requestStart;
    private double _dbMs;
    private int _queries;
    private double _serializeMs;

    /// <summary>Gets whether a rollback-only preview is running in this request scope.</summary>
    public bool IsActive
    {
        get
        {
            lock (_gate)
            {
                return _active && _rollback;
            }
        }
    }

    /// <summary>Records an effect and returns true when the host should suppress its delivery.</summary>
    /// <remarks>For an observed send, this records intended delivery and returns false so the host still delivers it.</remarks>
    public bool TryRecordEffect(string kind, string description, object? data = null)
    {
        lock (_gate)
        {
            if (!_active)
            {
                return false;
            }

            if (_effects.Count == CaptureLimits.Effects || _effectSize >= CaptureLimits.LogBudget)
            {
                _effectsTruncated = true;
                return _rollback;
            }

            var started = Stopwatch.GetTimestamp();
            var capturedData = data is null ? null : CaptureLimits.Snapshot(data);
            _serializeMs += Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            var capturedKind = CaptureLimits.Clip(kind, CaptureLimits.Name);
            var capturedDescription = CaptureLimits.Clip(description);
            _effectSize += capturedKind.Length + capturedDescription.Length + CaptureLimits.Size(capturedData);
            _effectsTruncated |= capturedKind != kind || capturedDescription != description || (capturedData is null && data is not null);
            if (_effectSize <= CaptureLimits.LogBudget)
            {
                _effects.Add(new PreviewEffect(capturedKind, capturedDescription, capturedData, _rollback ? null : true));
            }
            else
            {
                _effectsTruncated = true;
            }

            return _rollback;
        }
    }

    /// <summary>Records an email and returns true when the host should suppress delivery.</summary>
    public bool TryRecordEmail(string description, string from, IEnumerable<string> to, IEnumerable<string> cc,
        string subject, string text, string? html = null) =>
        TryRecordEffect("email", description, new { from, to, cc, subject, text, html });

    /// <summary>Records an HTTP call and returns true when the host should suppress the call.</summary>
    public bool TryRecordHttp(string description, string method, string url, int? status = null, object? body = null) =>
        TryRecordEffect("http", description, new { method, url, status, body });

    /// <summary>Records a background job and returns true when the host should suppress scheduling.</summary>
    public bool TryRecordJob(string description, string name, object? arguments, string? queue = null, DateTimeOffset? runAt = null) =>
        TryRecordEffect("job", description, new { name, arguments, queue, runAt });

    /// <summary>Records a message and returns true when the host should suppress publishing.</summary>
    public bool TryRecordMessage(string description, string topic, object? payload, string? key = null) =>
        TryRecordEffect("message", description, new { topic, payload, key });

    /// <summary>Records a message and reports whether a preview or observed send is capturing logs.</summary>
    public bool TryRecordLog(string level, string message)
    {
        lock (_gate)
        {
            if (!_active)
            {
                return false;
            }

            if (HasLogRoom())
            {
                AddLog(new PreviewLog(Clip(level, CaptureLimits.Name), Clip(message)) { OffsetMs = OffsetMs() });
            }
            return true;
        }
    }

    internal bool CanLog
    {
        get
        {
            lock (_gate)
            {
                return _active;
            }
        }
    }

    internal void Begin(bool rollback, long requestStart)
    {
        lock (_gate)
        {
            _requestStart = requestStart;
            _rollback = rollback;
            _active = true;
        }
    }

    internal void Log<TState>(string category, LogLevel level, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (_gate)
        {
            if (!_active || !HasLogRoom())
            {
                return;
            }

            try
            {
                Dictionary<string, string>? properties = null;
                if (state is IEnumerable<KeyValuePair<string, object?>> fields)
                {
                    properties = new(StringComparer.Ordinal);
                    var examined = 0;
                    foreach (var (propertyName, value) in fields)
                    {
                        if (++examined > CaptureLimits.Properties + 1)
                        {
                            _logsTruncated = true;
                            break;
                        }

                        if (propertyName != "{OriginalFormat}")
                        {
                            if (properties.Count == CaptureLimits.Properties)
                            {
                                _logsTruncated = true;
                                break;
                            }

                            properties[Clip(propertyName, CaptureLimits.Name)] =
                                Clip(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "");
                        }
                    }
                }

                AddLog(new PreviewLog(level.ToString(), Clip(formatter(state, exception)))
                {
                    Category = Clip(category, CaptureLimits.Name),
                    EventId = new CapturedEventId(eventId.Id, eventId.Name is { } eventName ? Clip(eventName, CaptureLimits.Name) : null),
                    OffsetMs = OffsetMs(),
                    Properties = properties is { Count: > 0 } ? properties : null,
                    Exception = exception is null ? null : new CapturedException(
                        Clip(exception.GetType().FullName ?? exception.GetType().Name, CaptureLimits.Name), Clip(exception.Message))
                });
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                _logsTruncated = true;
            }
        }
    }

    internal void RecordSql(TimeSpan duration, string category, EventId eventId,
        Func<(CapturedSql Sql, bool Truncated)> snapshot)
    {
        lock (_gate)
        {
            if (!_active)
            {
                return;
            }

            _dbMs += duration.TotalMilliseconds;
            _queries = _queries < int.MaxValue ? _queries + 1 : _queries;
            if (!HasLogRoom())
            {
                return;
            }

            try
            {
                var (sql, truncated) = snapshot();
                _logsTruncated |= truncated;
                AddLog(new PreviewLog("Sql", sql.Text)
                {
                    Category = category,
                    EventId = new CapturedEventId(eventId.Id, eventId.Name),
                    OffsetMs = Math.Max(0, OffsetMs() - duration.TotalMilliseconds),
                    ElapsedMs = duration.TotalMilliseconds,
                    Sql = sql
                });
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                _logsTruncated = true;
            }
        }
    }

    internal CaptureTiming Timing(CaptureClock clock, double extraSerializationMs = 0)
    {
        lock (_gate)
        {
            return clock.Read(_dbMs, _queries, _serializeMs, extraSerializationMs);
        }
    }

    internal CaptureSnapshot Finish()
    {
        lock (_gate)
        {
            _active = false;
            var snapshot = new CaptureSnapshot([.. _effects], [.. _logs], _logsTruncated, _effectsTruncated);
            _effects.Clear();
            _logs.Clear();
            return snapshot;
        }
    }

    private double OffsetMs() => Stopwatch.GetElapsedTime(_requestStart).TotalMilliseconds;

    private string Clip(string value, int maximum = CaptureLimits.Text)
    {
        var result = CaptureLimits.Clip(value, maximum);
        _logsTruncated |= result.Length != value.Length;
        return result;
    }

    private bool HasLogRoom()
    {
        var hasRoom = _logs.Count < CaptureLimits.Logs && _logSize < CaptureLimits.LogBudget;
        _logsTruncated |= !hasRoom;
        return hasRoom;
    }

    private void AddLog(PreviewLog entry)
    {
        if (HasLogRoom())
        {
            var size = entry.Size;
            if (_logSize + size <= CaptureLimits.LogBudget)
            {
                _logs.Add(entry);
                _logSize += size;
            }
            else
            {
                _logsTruncated = true;
            }
        }
    }
}

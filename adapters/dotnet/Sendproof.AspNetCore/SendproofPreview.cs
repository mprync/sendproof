using System.Collections.Concurrent;
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
    private readonly List<PreviewChange> _storeChanges = [];
    private bool _active;
    private bool _rollback;
    private bool _previewScope;
    private bool _changesTruncated;
    private BlockedWrite? _blocked;
    private Exception? _fault;
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

    /// <summary>
    /// Gets the per-request state data stores keep for this Preview, such as a MongoDB transaction. It is a plain
    /// dictionary on the request scope rather than an <see cref="AsyncLocal{T}"/>, because a value set inside an
    /// awaited call would not flow back to the handler.
    /// </summary>
    internal ConcurrentDictionary<object, object> State { get; } = new();

    /// <summary>
    /// Gets whether this Preview runs inside a preview session. A store that holds no transaction for the session must not
    /// start one of its own for a step: it would be rolled back at the step's end, and later steps wouldn't see its writes.
    /// </summary>
    internal bool InSession { get; set; }

    /// <summary>
    /// Gets whether this request is a Preview, from the moment the Preview transport took it over and even after it
    /// finished, so a write a handler sends late (after its response settled) is still refused, never sent unguarded.
    /// </summary>
    internal bool InPreview
    {
        get
        {
            lock (_gate)
            {
                return _previewScope;
            }
        }
    }

    /// <summary>Gets the first write the guard refused in this Preview, which decides the 409.</summary>
    internal BlockedWrite? Blocked
    {
        get
        {
            lock (_gate)
            {
                return _blocked;
            }
        }
    }

    /// <summary>Gets the first fault (a transaction-control refusal, an escaped write), which withholds confirmation.</summary>
    internal Exception? Fault
    {
        get
        {
            lock (_gate)
            {
                return _fault;
            }
        }
    }

    /// <summary>Marks the request as a Preview as soon as the transport owns it, before the provider begins.</summary>
    internal void MarkPreview()
    {
        lock (_gate)
        {
            _previewScope = true;
        }
    }

    /// <summary>Keeps the first refused write. It decides the Preview's 409, whatever the handler returns.</summary>
    internal void Block(BlockedWrite write)
    {
        lock (_gate)
        {
            if (_previewScope)
            {
                _blocked ??= new BlockedWrite(CaptureLimits.Clip(write.Store, CaptureLimits.Name),
                    CaptureLimits.Clip(write.Operation, CaptureLimits.Name), CaptureLimits.Clip(write.Detail));
            }
        }
    }

    /// <summary>Keeps the first fault. It withholds confirmation, whatever the handler returns.</summary>
    internal void Refuse(Exception fault)
    {
        lock (_gate)
        {
            if (_previewScope)
            {
                _fault ??= fault;
            }
        }
    }

    /// <summary>
    /// Records one data-store command as a <c>Db</c> log entry. The message is the OpenTelemetry span name,
    /// <c>{operation} {target}</c>. Hooks pass sanitized statements only; values never reach this method.
    /// </summary>
    internal void RecordDb(DbEntry entry)
    {
        lock (_gate)
        {
            if (!_active)
            {
                return;
            }

            if (!entry.Blocked)
            {
                _dbMs += entry.ElapsedMs;
                _queries = _queries < int.MaxValue ? _queries + 1 : _queries;
            }

            if (!HasLogRoom())
            {
                return;
            }

            var db = new CapturedDb(Clip(entry.System, CaptureLimits.Name), Clip(entry.Operation, CaptureLimits.Name))
            {
                Target = entry.Target is null ? null : Clip(entry.Target, CaptureLimits.Name),
                Namespace = entry.Namespace is null ? null : Clip(entry.Namespace, CaptureLimits.Name),
                Statement = entry.Statement is null ? null : Clip(entry.Statement),
                RowsAffected = entry.RowsAffected is >= 0 ? entry.RowsAffected : null,
                Blocked = entry.Blocked ? true : null,
                Error = string.IsNullOrEmpty(entry.Error) ? null : Clip(entry.Error, CaptureLimits.Name)
            };
            AddLog(new PreviewLog("Db", db.Target is null ? db.Operation : $"{db.Operation} {db.Target}")
            {
                Db = db,
                OffsetMs = Math.Max(0, OffsetMs() - entry.ElapsedMs),
                ElapsedMs = entry.Blocked ? null : Math.Max(0, entry.ElapsedMs)
            });
        }
    }

    /// <summary>
    /// Records a document, item or key change from a data store. Secret-named fields never leave the process, at any
    /// depth of a nested document.
    /// </summary>
    internal void RecordChange(PreviewChange change)
    {
        lock (_gate)
        {
            if (!_active)
            {
                return;
            }

            if (_storeChanges.Count >= CaptureLimits.Changes)
            {
                _changesTruncated = true;
                return;
            }

            _storeChanges.Add(change with
            {
                Key = Redact(change.Key),
                Before = Redact(change.Before),
                After = Redact(change.After)
            });
        }
    }

    /// <summary>Marks the store changes as cut short, for a capture that stopped at its own limit.</summary>
    internal void TruncateChanges()
    {
        lock (_gate)
        {
            _changesTruncated = true;
        }
    }

    private static object? Redact(object? value) =>
        value is System.Text.Json.Nodes.JsonNode node ? SecretNames.RedactDeep(node.DeepClone()) : value;

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
            var snapshot = new CaptureSnapshot([.. _effects], [.. _logs], _logsTruncated, _effectsTruncated, [.. _storeChanges], _changesTruncated);
            _effects.Clear();
            _logs.Clear();
            _storeChanges.Clear();
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

using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;

namespace Sendproof.AspNetCore;

internal sealed record PreviewEffect(string Kind, string Description, JsonElement? Data,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Delivered);

internal sealed record PreviewLog(string Level, string Message)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Category { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CapturedEventId? EventId { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? OffsetMs { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? ElapsedMs { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? Properties { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CapturedException? Exception { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CapturedSql? Sql { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public CapturedDb? Db { get; init; }

    internal int Size => Level.Length + Message.Length + (Category?.Length ?? 0) + (EventId?.Name?.Length ?? 0) +
        (Db is { } db ? db.Operation.Length + db.System.Length + (db.Target?.Length ?? 0) + (db.Namespace?.Length ?? 0) +
            (db.Statement?.Length ?? 0) + (db.Error?.Length ?? 0) : 0) +
        (Properties?.Sum(pair => pair.Key.Length + pair.Value.Length) ?? 0) +
        (Exception is { } error ? error.Type.Length + error.Message.Length : 0) +
        (Sql is { } sql ? sql.Text.Length + sql.Parameters.Sum(parameter =>
            parameter.Name.Length + (parameter.Value?.Length ?? 0) + parameter.DbType.Length) : 0);
}

internal sealed record CapturedEventId(int Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name);

internal sealed record CapturedException(string Type, string Message);
internal sealed record CapturedSql(string Text, CapturedSqlParameter[] Parameters,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? RowsAffected);
internal sealed record CapturedSqlParameter(string Name, string? Value, string DbType);

/// <summary>A command to a non-SQL data store, as the <c>Db</c> log level carries it (OpenTelemetry database attributes).</summary>
internal sealed record CapturedDb(string System, string Operation)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Namespace { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Target { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Statement { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? RowsAffected { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Blocked { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

internal sealed record CaptureSnapshot(PreviewEffect[] Effects, PreviewLog[] Logs, bool LogsTruncated, bool EffectsTruncated,
    PreviewChange[]? Changes = null, bool ChangesTruncated = false);

internal sealed record CaptureTiming(double Auth, double Handler, double Db, int QueryCount, double Serialize)
{
    internal void AppendHeader(HttpResponse response) => response.Headers.Append("Server-Timing",
        string.Create(CultureInfo.InvariantCulture,
            $"auth;dur={Auth:0.000}, handler;dur={Handler:0.000}, db;dur={Db:0.000};desc=\"{QueryCount} queries\", serialize;dur={Serialize:0.000}"));
}

internal sealed class CaptureClock(long requestStart)
{
    private long? _handlerStart;
    private long? _handlerEnd;

    internal void StartHandler() => _handlerStart = Stopwatch.GetTimestamp();
    internal void EndHandler() => _handlerEnd = Stopwatch.GetTimestamp();

    internal CaptureTiming Read(double db, int queries, double serialize, double extraSerializationMs)
    {
        var handlerStart = _handlerStart ?? requestStart;
        var handlerEnd = _handlerEnd ?? Stopwatch.GetTimestamp();
        return new CaptureTiming(
            Stopwatch.GetElapsedTime(requestStart, handlerStart).TotalMilliseconds,
            Math.Max(0, Stopwatch.GetElapsedTime(handlerStart, handlerEnd).TotalMilliseconds - db - serialize),
            db, queries, serialize + extraSerializationMs);
    }
}

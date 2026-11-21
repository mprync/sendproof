using System.Data.Common;
using System.Globalization;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Hosting;
using TestBench.AspNetCore;

namespace TestBench.EntityFrameworkCore;

internal sealed class TestBenchCommandInterceptor(CaptureContext capture, TestBenchOptions options,
    IHostEnvironment? environment = null) : DbCommandInterceptor
{
    // Matched against whole words, so IdempotencyKey or Monkey stay visible while
    // PasswordHash, api_key and RefreshToken are hidden.
    private static readonly HashSet<string> SecretWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "password", "passwd", "pwd", "secret", "token", "hash", "salt", "credential", "credentials", "apikey"
    };

    // "Key" alone is ordinary (primary key, idempotency key); it is secret only after these words.
    private static readonly HashSet<string> SecretKeyQualifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        "api", "private", "secret", "access", "signing", "encryption", "client"
    };

    private const string Redacted = "[REDACTED]";

    public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData eventData, DbDataReader result)
    {
        Record(command, eventData, rowsAffected: null);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        DbDataReader result, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(ReaderExecuted(command, eventData, result));

    public override object? ScalarExecuted(DbCommand command, CommandExecutedEventData eventData, object? result)
    {
        Record(command, eventData, rowsAffected: null);
        return result;
    }

    public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        object? result, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(ScalarExecuted(command, eventData, result));

    public override int NonQueryExecuted(DbCommand command, CommandExecutedEventData eventData, int result)
    {
        Record(command, eventData, result >= 0 ? result : null);
        return result;
    }

    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData,
        int result, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(NonQueryExecuted(command, eventData, result));

    private void Record(DbCommand command, CommandExecutedEventData eventData, int? rowsAffected) =>
        capture.Current?.RecordSql(eventData.Duration, CaptureLoggerProvider.CommandCategory, eventData.EventId,
            () => Snapshot(command, rowsAffected));

    private (CapturedSql Sql, bool Truncated) Snapshot(DbCommand command, int? rowsAffected)
    {
        var text = command.CommandText;
        var clippedText = CaptureLimits.Clip(text);
        var truncated = clippedText.Length != text.Length || command.Parameters.Count > CaptureLimits.Parameters;
        var showValues = options.IncludeSqlParameterValues ?? environment?.IsDevelopment() == true;

        // Generated placeholders such as @p0 carry no column information. If the
        // statement refers to a secret-looking name, hide every value in that
        // statement. Inferring bindings from fragments of SQL is unsafe.
        var redactStatement = showValues && LooksSecret(text);
        var parameters = new List<CapturedSqlParameter>();
        foreach (DbParameter parameter in command.Parameters.Cast<DbParameter>().Take(CaptureLimits.Parameters))
        {
            var name = CaptureLimits.Clip(parameter.ParameterName, CaptureLimits.Name);
            var redact = !showValues || redactStatement || LooksSecret(parameter.ParameterName);
            var value = redact ? Redacted : ParameterValue(parameter.Value, ref truncated);
            truncated |= name != parameter.ParameterName;
            parameters.Add(new CapturedSqlParameter(name, value, parameter.DbType.ToString()));
        }

        return (new CapturedSql(clippedText, [.. parameters], rowsAffected), truncated);
    }

    /// <summary>Whether an identifier or statement names a secret, judged by whole words.</summary>
    internal static bool LooksSecret(string text)
    {
        string? previous = null;
        foreach (var word in Words(text))
        {
            if (SecretWords.Contains(word) ||
                word.Equals("key", StringComparison.OrdinalIgnoreCase) && previous is not null && SecretKeyQualifiers.Contains(previous))
            {
                return true;
            }

            previous = word;
        }

        return false;
    }

    /// <summary>Splits identifiers and SQL text into words at punctuation, underscores and camel-case boundaries.</summary>
    private static IEnumerable<string> Words(string text)
    {
        var start = -1;
        for (var i = 0; i <= text.Length; i++)
        {
            var letterOrDigit = i < text.Length && char.IsLetterOrDigit(text[i]);
            var boundary = !letterOrDigit || start >= 0 && char.IsUpper(text[i]) && char.IsLower(text[i - 1]);
            if (boundary && start >= 0)
            {
                yield return text[start..i];
                start = -1;
            }

            if (letterOrDigit && start < 0)
            {
                start = i;
            }
        }
    }

    private static string? ParameterValue(object? value, ref bool truncated)
    {
        if (value is null or DBNull)
        {
            return null;
        }

        if (value is byte[] bytes)
        {
            var length = Math.Min(bytes.Length, CaptureLimits.Text / 2);
            truncated |= length < bytes.Length;
            return Convert.ToHexString(bytes.AsSpan(0, length));
        }

        var original = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        var clipped = CaptureLimits.Clip(original);
        truncated |= clipped.Length != original.Length;
        return clipped;
    }
}

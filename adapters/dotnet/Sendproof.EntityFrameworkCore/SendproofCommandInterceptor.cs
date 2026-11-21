using System.Data.Common;
using System.Globalization;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Hosting;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

internal sealed class SendproofCommandInterceptor(CaptureContext capture, SendproofOptions options,
    IHostEnvironment? environment = null, SafeProcedures? safeProcedures = null) : DbCommandInterceptor
{
    private const string Redacted = SecretNames.Redacted;

    // The raw-commit rule (spec/data-stores.md): during a Preview, a statement that would end or escape the Preview
    // transaction is refused before it reaches the database, and the Preview can never be confirmed, even if the
    // handler catches the exception.
    public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData,
        InterceptionResult<DbDataReader> result) => Guard(command, eventData, result);

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default) => ValueTask.FromResult(Guard(command, eventData, result));

    public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData,
        InterceptionResult<object> result) => Guard(command, eventData, result);

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<object> result, CancellationToken cancellationToken = default) => ValueTask.FromResult(Guard(command, eventData, result));

    public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData,
        InterceptionResult<int> result) => Guard(command, eventData, result);

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData,
        InterceptionResult<int> result, CancellationToken cancellationToken = default) => ValueTask.FromResult(Guard(command, eventData, result));

    private InterceptionResult<T> Guard<T>(DbCommand command, CommandEventData eventData, InterceptionResult<T> result)
    {
        SqlGuard.Check(capture, command.CommandType, command.CommandText,
            PreviewTurns.IsMySql(eventData.Context?.Database.ProviderName), safeProcedures?.Names);
        return result;
    }

    // A failed command may mean the database rolled the Preview transaction back (deadlock, lock wait timeout, or a SQL
    // Server error under XACT_ABORT ON): every later statement in the Preview is then refused. See SqlGuard.
    public override void CommandFailed(DbCommand command, CommandErrorEventData eventData) =>
        SqlGuard.Failed(capture, eventData.Exception, SqlServerTransactionGone(command, eventData.Exception));

    public override Task CommandFailedAsync(DbCommand command, CommandErrorEventData eventData, CancellationToken cancellationToken = default)
    {
        CommandFailed(command, eventData);
        return Task.CompletedTask;
    }

    /// <summary>On SQL Server, asks <c>@@TRANCOUNT</c> whether the error ended the transaction; otherwise <see langword="null"/>.</summary>
    private bool? SqlServerTransactionGone(DbCommand command, Exception error)
    {
        if (!SqlGuard.IsSqlServerError(error) || capture.Current is not { InPreview: true } || command.Connection is not { } connection ||
            connection.State != System.Data.ConnectionState.Open)
        {
            return null;
        }

        try
        {
            using var probe = connection.CreateCommand();
            probe.CommandText = "SELECT @@TRANCOUNT";
            probe.Transaction = command.Transaction;
            return Convert.ToInt32(probe.ExecuteScalar(), CultureInfo.InvariantCulture) == 0;
        }
        catch (DbException)
        {
            // A transaction the server ended may refuse even this; the Preview can't be confirmed either way.
            return true;
        }
    }

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
    internal static bool LooksSecret(string text) => SecretNames.LooksSecret(text);

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

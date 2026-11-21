using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// The Preview's SQL guard, shared by every route a statement can take: EF Core's command interceptor, the guarding
/// connection (<see cref="SendproofDbConnection"/>) and MySql.Data's driver interceptors
/// (<see cref="MySqlDataCommandGuard"/>). See spec/data-stores.md "Transaction-control statements from the handler".
/// </summary>
/// <remarks>
/// Two rules: a statement that would end or escape the Preview transaction is refused before it is sent; and once the
/// database has rolled the Preview transaction back on its own (a MySQL deadlock 1213 or lock wait timeout 1205, a SQL
/// Server deadlock victim 1205, or any SQL Server error that leaves <c>@@TRANCOUNT</c> at 0, as under
/// <c>XACT_ABORT ON</c>), every further statement in that Preview is refused, because it would run outside the
/// transaction and, with auto-commit on, an ORM's retry would commit for real. Both fail the Preview with 500, even if
/// the handler catches the error; the handler still gets the database's original error. MySQL's 1205 is treated as a
/// lost transaction whether or not <c>innodb_rollback_on_timeout</c> is on: refusing can only fail a Preview, never
/// confirm one.
/// </remarks>
internal static class SqlGuard
{
    /// <summary>The Previews whose SQL transaction the database already rolled back.</summary>
    private static readonly ConditionalWeakTable<SendproofPreview, object> Lost = new();

    /// <summary>The capture contexts and safe procedures of every host using the EF Core integration, for the driver hooks.</summary>
    private static readonly ConditionalWeakTable<CaptureContext, SafeProcedures> Hosts = new();

    /// <summary>Makes a host's Previews visible to the driver-level hooks, which the driver constructs itself.</summary>
    internal static void Register(CaptureContext capture, SafeProcedures? safeProcedures) =>
        Hosts.AddOrUpdate(capture, safeProcedures ?? new SafeProcedures());

    /// <summary>Whether the database already rolled back this Preview's SQL transaction.</summary>
    internal static bool IsLost(SendproofPreview preview) => Lost.TryGetValue(preview, out _);

    /// <summary>Refuses a command before it is sent, when a Preview runs on this flow and a rule says so.</summary>
    internal static void Check(CaptureContext capture, CommandType type, string text, bool mysql, IReadOnlySet<string>? safeProcedures)
    {
        if (OwnSql.IsActive || capture.Current is not { InPreview: true } preview)
        {
            return;
        }

        if (Lost.TryGetValue(preview, out _))
        {
            throw capture.RefuseInPreview("The database rolled the Preview transaction back after a deadlock, lock wait timeout or " +
                "aborting error, so no further statement can run in it during Preview.")!;
        }

        if (SqlStatements.EndsTransaction(type, text, mysql, safeProcedures))
        {
            throw capture.RefuseInPreview("Preview owns the SQL transaction, so a statement that ends or replaces it cannot run during Preview.")!;
        }
    }

    /// <summary>The Preview each MySQL connection holds a backstop savepoint for, so the driver hook can probe it.</summary>
    private static readonly ConditionalWeakTable<DbConnection, PreviewConnection> PreviewConnections = new();

    private sealed record PreviewConnection(CaptureContext Capture, SendproofPreview Preview, PreviewSavepoint Savepoint);

    /// <summary>Records that <paramref name="connection"/> carries the running Preview's transaction and savepoint.</summary>
    internal static void RegisterPreviewConnection(DbConnection connection, CaptureContext capture, PreviewSavepoint savepoint)
    {
        if (capture.Current is { InPreview: true } preview)
        {
            PreviewConnections.AddOrUpdate(connection, new PreviewConnection(capture, preview, savepoint));
        }
    }

    /// <summary>
    /// <see cref="Check"/> for a MySql.Data connection, which knows nothing of the host: checks every registered host.
    /// The driver passes the command text only, so a bare procedure name (a <c>StoredProcedure</c> command) counts as a
    /// <c>CALL</c>.
    /// </summary>
    /// <remarks>
    /// On the Preview's own connection it first proves a transaction is still open (<see cref="PreviewSavepoint.StillOpen"/>,
    /// one round trip). After a deadlock, lock wait timeout or any other server rollback, with auto-commit on, the probe
    /// fails whichever API saw the error, so the statement and every later one are refused instead of committing on
    /// their own.
    /// </remarks>
    internal static void CheckMySqlData(string sql, DbConnection? connection)
    {
        if (!OwnSql.IsActive && connection is not null && PreviewConnections.TryGetValue(connection, out var held) &&
            ReferenceEquals(held.Capture.Current, held.Preview) && !IsLost(held.Preview) && !held.Savepoint.StillOpen())
        {
            Lost.AddOrUpdate(held.Preview, new object());
            held.Capture.RefuseInPreview("The database rolled the Preview transaction back, so the Preview can't be confirmed.");
        }

        var type = IsBareName(sql) ? CommandType.StoredProcedure : CommandType.Text;
        foreach (var (capture, safe) in Hosts)
        {
            Check(capture, type, sql, mysql: true, safe.Names);
        }
    }

    /// <summary>
    /// Records a failed command. When the error means the database rolled the Preview transaction back, every further
    /// statement in the Preview is refused and the Preview fails. The caller rethrows the original error.
    /// </summary>
    /// <param name="capture">The host's capture context.</param>
    /// <param name="error">The error the command failed with.</param>
    /// <param name="transactionGone">For SQL Server, whether <c>@@TRANCOUNT</c> is now 0; <see langword="null"/> if unknown.</param>
    internal static void Failed(CaptureContext capture, Exception error, bool? transactionGone = null)
    {
        if (OwnSql.IsActive || capture.Current is not { InPreview: true } preview || !(RollsBack(error) || transactionGone == true))
        {
            return;
        }

        Lost.AddOrUpdate(preview, new object());
        capture.RefuseInPreview("The database rolled the Preview transaction back after a deadlock, lock wait timeout or aborting " +
            "error, so the Preview can't be confirmed.");
    }

    /// <summary>Whether an error always means the server rolled the whole transaction back (MySQL 1213 or 1205, SQL Server 1205).</summary>
    internal static bool RollsBack(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is DbException database && ErrorNumber(database) is 1213 or 1205)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Whether an error came from SQL Server, which can end the transaction on any error under <c>XACT_ABORT ON</c>.</summary>
    internal static bool IsSqlServerError(Exception error) =>
        error is DbException && error.GetType().FullName is "Microsoft.Data.SqlClient.SqlException" or "System.Data.SqlClient.SqlException";

    /// <summary>The server error number: <c>Number</c> on MySql.Data, MySqlConnector and SqlClient exceptions.</summary>
    private static int? ErrorNumber(DbException error) =>
        error.GetType().GetProperty("Number")?.GetValue(error) switch
        {
            int number => number,
            Enum code => Convert.ToInt32(code, System.Globalization.CultureInfo.InvariantCulture),
            _ => null
        };

    private static bool IsBareName(string sql)
    {
        var text = sql.Trim();
        return text.Length > 0 && text.All(character => char.IsLetterOrDigit(character) || character is '_' or '.' or '`' or '$');
    }
}

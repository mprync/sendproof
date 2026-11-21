using System.Data;
using System.Data.Common;
using MySql.Data.MySqlClient;
using MySql.Data.MySqlClient.Interceptors;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// MySql.Data's own command hook, which sees every command on the connection whichever API sends it (EF Core, Dapper on
/// <c>Database.GetDbConnection()</c>, a hand-written <c>MySqlCommand</c>, and the driver's own <c>COMMIT</c> for
/// <c>MySqlTransaction.Commit()</c>). It runs <see cref="SqlGuard"/> before anything is sent.
/// </summary>
/// <remarks>
/// MySql.EntityFrameworkCore needs EF Core's connection to be a <c>MySqlConnection</c>, so Sendproof can't wrap it as it
/// wraps other providers' connections. Instead <see cref="SendproofConnectionInterceptor"/> names this type in the
/// connection string's <c>CommandInterceptors</c> when EF Core creates the connection; the driver constructs it itself.
/// MySql.Data's exception hook isn't called for server errors, so a deadlock that went to plain ADO.NET is found by the
/// savepoint probe in <see cref="SqlGuard.CheckMySqlData"/> instead.
/// </remarks>
public sealed class MySqlDataCommandGuard : BaseCommandInterceptor
{
    /// <inheritdoc />
    public override bool ExecuteNonQuery(string sql, ref int returnValue)
    {
        SqlGuard.CheckMySqlData(sql, ActiveConnection);
        return false;
    }

    /// <inheritdoc />
    public override bool ExecuteScalar(string sql, ref object returnValue)
    {
        SqlGuard.CheckMySqlData(sql, ActiveConnection);
        return false;
    }

    /// <inheritdoc />
    public override bool ExecuteReader(string sql, CommandBehavior behavior, ref MySqlDataReader returnValue)
    {
        SqlGuard.CheckMySqlData(sql, ActiveConnection);
        return false;
    }
}

/// <summary>Installs the MySql.Data hooks on a connection EF Core just created.</summary>
internal static class MySqlDataHooks
{
    private const string MySqlDataConnection = "MySql.Data.MySqlClient.MySqlConnection";

    /// <summary>Whether <paramref name="connection"/> is a MySql.Data connection.</summary>
    internal static bool Applies(DbConnection connection) => connection.GetType().FullName == MySqlDataConnection;

    /// <summary>Adds the guard to the connection string's command interceptors, keeping any the application set.</summary>
    internal static void Install(DbConnection connection)
    {
        var builder = new DbConnectionStringBuilder { ConnectionString = connection.ConnectionString };
        Add(builder, "commandinterceptors", typeof(MySqlDataCommandGuard));
        connection.ConnectionString = builder.ConnectionString;
    }

    private static void Add(DbConnectionStringBuilder builder, string key, Type guard)
    {
        var name = guard.FullName + ", " + guard.Assembly.GetName().Name;
        var existing = builder.TryGetValue(key, out var value) ? value?.ToString() : null;
        if (existing?.Contains(guard.FullName!, StringComparison.Ordinal) == true) return;
        builder[key] = string.IsNullOrWhiteSpace(existing) ? name : existing + ";" + name;
    }
}

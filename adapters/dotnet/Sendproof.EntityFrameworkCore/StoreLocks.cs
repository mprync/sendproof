using System.Data.Common;
using System.Globalization;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Telling "another transaction holds the database" apart from a real failure when a preview session opens, and keeping
/// the wait for it short. The provider packages are never referenced: errors are read by shape, as
/// <see cref="SqlGuard"/> reads server error numbers.
/// </summary>
internal static class StoreLocks
{
    private const string Sqlite = "Microsoft.EntityFrameworkCore.Sqlite";
    private const string SqlServer = "Microsoft.EntityFrameworkCore.SqlServer";
    private const string PostgreSql = "Npgsql.EntityFrameworkCore.PostgreSQL";

    /// <summary>SQLite's busy and locked result codes.</summary>
    private const int SqliteBusy = 5;
    private const int SqliteLocked = 6;

    /// <summary>The lock timeout (1222) on SQL Server and the lock wait timeout (1205) on MySQL and MariaDB.</summary>
    private const int SqlServerLockTimeout = 1222;
    private const int MySqlLockWaitTimeout = 1205;

    /// <summary>PostgreSQL's <c>lock_not_available</c> SQLSTATE.</summary>
    private const string PostgreSqlLockNotAvailable = "55P03";

    /// <summary>Whether <paramref name="error"/> says another session or transaction holds what the provider asked for.</summary>
    internal static bool IsHeldByAnother(string? providerName, Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is not DbException database)
            {
                continue;
            }

            var held = providerName switch
            {
                Sqlite => Property<int>(database, "SqliteErrorCode") is SqliteBusy or SqliteLocked,
                SqlServer => Property<int>(database, "Number") == SqlServerLockTimeout,
                PostgreSql => Property<string>(database, "SqlState") == PostgreSqlLockNotAvailable,
                var name when PreviewTurns.IsMySql(name) => Property<int>(database, "Number") == MySqlLockWaitTimeout,
                _ => false
            };
            if (held)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Lowers how long SQLite's <c>BEGIN</c> waits for another writer, from the connection's usual timeout (30 seconds)
    /// to <paramref name="wait"/>, until the returned scope is disposed. Microsoft.Data.Sqlite gives a command the
    /// connection's <c>DefaultTimeout</c> when the command is created, so it covers the <c>BEGIN IMMEDIATE</c> the
    /// provider sends for the session's transaction. Other providers, and drivers without that property, wait as they do.
    /// </summary>
    internal static IDisposable ShortenWait(string? providerName, DbConnection connection, TimeSpan wait)
    {
        if (providerName != Sqlite)
        {
            return Restore.Nothing;
        }

        var driver = connection is SendproofDbConnection wrapped ? wrapped.Inner : connection;
        var property = driver.GetType().GetProperty("DefaultTimeout");
        if (property is not { CanRead: true, CanWrite: true } || property.PropertyType != typeof(int))
        {
            return Restore.Nothing;
        }

        var usual = (int)property.GetValue(driver)!;
        property.SetValue(driver, (int)Math.Ceiling(wait.TotalSeconds));
        return new Restore(() => property.SetValue(driver, usual));
    }

    private static T? Property<T>(DbException error, string name) =>
        error.GetType().GetProperty(name)?.GetValue(error) switch
        {
            T value => value,
            Enum code when typeof(T) == typeof(int) => (T)(object)Convert.ToInt32(code, CultureInfo.InvariantCulture),
            _ => default
        };

    private sealed class Restore(Action restore) : IDisposable
    {
        internal static Restore Nothing { get; } = new(() => { });

        public void Dispose() => restore();
    }
}

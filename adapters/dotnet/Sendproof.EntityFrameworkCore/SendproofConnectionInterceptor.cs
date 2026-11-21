using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Puts the Preview guard on each connection EF Core creates, so plain ADO.NET and Dapper on
/// <c>Database.GetDbConnection()</c> meet the same guard as EF Core's own commands: a MySql.Data connection gets the
/// driver's own interceptors (<see cref="MySqlDataCommandGuard"/>); SQLite's is wrapped in a
/// <see cref="SendproofDbConnection"/>.
/// </summary>
/// <remarks>
/// Other providers are left as they are: their EF Core providers need EF Core's connection to be their own connection
/// type (MySqlConnector with Pomelo, Npgsql), so a wrapper would break them, and their drivers have no command hook. On
/// those, plain ADO.NET on EF Core's connection is not guarded; on MySQL and MariaDB the savepoint backstop still fails
/// the Preview. A connection the application creates and hands to EF Core isn't created by EF Core, so it isn't
/// guarded either.
/// </remarks>
internal sealed class SendproofConnectionInterceptor : DbConnectionInterceptor
{
    private const string Sqlite = "Microsoft.EntityFrameworkCore.Sqlite";

    private readonly CaptureContext _capture;
    private readonly SafeProcedures? _safeProcedures;

    public SendproofConnectionInterceptor(CaptureContext capture, SafeProcedures? safeProcedures = null)
    {
        _capture = capture;
        _safeProcedures = safeProcedures;
        SqlGuard.Register(capture, safeProcedures);
    }

    public override DbConnection ConnectionCreated(ConnectionCreatedEventData eventData, DbConnection result)
    {
        if (MySqlDataHooks.Applies(result))
        {
            MySqlDataHooks.Install(result);
            return result;
        }

        return eventData.Context?.Database.ProviderName == Sqlite && result is not SendproofDbConnection
            ? new SendproofDbConnection(result, _capture, mysql: false, () => _safeProcedures?.Names)
            : result;
    }
}

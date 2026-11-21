using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using System.Data.Common;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

internal sealed class EntityFrameworkPreviewProvider<TContext> : IPreviewProvider where TContext : DbContext
{
    private readonly TContext _context;

    public EntityFrameworkPreviewProvider(TContext context) => _context = context;

    // MongoDB.EntityFrameworkCore is not relational, but it supports Database.BeginTransaction() on a replica set,
    // so the same transaction-and-rollback provider covers it (see the .NET data-stores page).
    private bool IsMongo => _context.Database.ProviderName == "MongoDB.EntityFrameworkCore";

    public bool IsAvailable => _context.Database.IsRelational() || IsMongo;

    public string? DatabaseSystem => _context.Database.ProviderName switch
    {
        "Microsoft.EntityFrameworkCore.Sqlite" => "sqlite",
        "Npgsql.EntityFrameworkCore.PostgreSQL" => "postgresql",
        "Microsoft.EntityFrameworkCore.SqlServer" => "sqlserver",
        var name when PreviewTurns.IsMySql(name) => "mysql",
        _ => null
    };

    public string? Database
    {
        get
        {
            // A MongoDB database is reported through the data store, not as the SQL database.
            if (!IsAvailable || IsMongo) return null;

            var connection = _context.Database.GetDbConnection();
            if (_context.Database.ProviderName == "Microsoft.EntityFrameworkCore.Sqlite")
            {
                var source = connection.DataSource;
                // SQLite reports an empty DataSource for an open in-memory database.
                var options = new DbConnectionStringBuilder { ConnectionString = connection.ConnectionString };
                if (source == ":memory:" ||
                    (options.TryGetValue("Data Source", out var configuredSource) && Equals(configuredSource, ":memory:")) ||
                    (options.TryGetValue("Mode", out var mode) && string.Equals(mode?.ToString(), "Memory", StringComparison.OrdinalIgnoreCase)))
                    return "In-memory SQLite";
                // Split both styles so a Windows path stays private on a Unix host and vice versa.
                var fileName = source.Split('/', '\\').LastOrDefault();
                return SafeLabel(fileName);
            }

            return SafeLabel(connection.Database);
        }
    }

    private static string? SafeLabel(string? value)
    {
        // A connection string, URI, server name or path is never a database label.
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128 ||
            value.Any(character => !char.IsLetterOrDigit(character) && character is not (' ' or '.' or '_' or '-')))
            return null;
        return value;
    }

    public IPreviewObservation BeginObservation(HttpContext context) => new EntityFrameworkChangeCapture(_context);

    public async ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken)
    {
        // Resolve from the actual request scope so the endpoint and the preview share the context.
        var db = context.RequestServices.GetRequiredService<TContext>();
        if (!ReferenceEquals(db, _context))
        {
            throw new InvalidOperationException("The preview provider and endpoint must share a scoped DbContext.");
        }

        if (!IsAvailable)
        {
            throw new InvalidOperationException("EF Core preview requires a relational or MongoDB database provider.");
        }

        // MySQL Previews take their turn before taking a pooled connection, and keep it until the transaction ends.
        var turn = await PreviewTurns.EnterAsync(db.Database.ProviderName, cancellationToken);
        try
        {
            // Sendproof's own work, which the guards let through (a MySQL driver hook sees the BEGIN).
            var transaction = await OwnSql.RunAsync(() => db.Database.BeginTransactionAsync(cancellationToken));
            PreviewSavepoint? savepoint = null;
            // MongoDB's provider has no savepoints; every relational provider gets the backstop.
            if (db.Database.IsRelational())
            {
                try
                {
                    // The backstop: a commit while the handler runs erases this savepoint.
                    var capture = context.RequestServices.GetRequiredService<CaptureContext>();
                    savepoint = await OwnSql.RunAsync(() => PreviewSavepoint.OpenAsync(db, capture, cancellationToken));
                }
                catch
                {
                    await transaction.DisposeAsync();
                    throw;
                }
            }

            return new EntityFrameworkPreviewSession(db, transaction, turn, savepoint);
        }
        catch
        {
            turn?.Dispose();
            throw;
        }
    }
}

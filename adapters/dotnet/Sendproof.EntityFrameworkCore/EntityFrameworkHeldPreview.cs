using System.Data.Common;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// A preview session's SQL transaction: one connection and one transaction for the whole session, which each step's
/// request-scoped context joins through EF Core's external connection and transaction support
/// (<c>SetDbConnection</c> and <c>UseTransaction</c>), so a later step sees an earlier step's uncommitted rows.
/// </summary>
/// <remarks>
/// <para>The connection and transaction belong to a context of the session's own service scope, which lives as long as the
/// session. Before each step EF Core's savepoint API takes <c>sendproof_step_{n}</c>, which rewinding and undoing roll back
/// to, and <c>sendproof_check</c>, which keeping the step releases: a commit while the step ran erases every savepoint, so a
/// release that fails means the transaction can't be vouched for. The handler can't name either savepoint (see
/// <see cref="SqlStatements"/>).</para>
/// <para>SQL Server can't release a savepoint (EF Core's <c>ReleaseSavepoint</c> does nothing there), so on SQL Server a
/// kept step instead proves the transaction is the one the session opened: <c>CURRENT_TRANSACTION_ID()</c> is read when
/// the session opens and again after each step. A commit, or an error that rolled the transaction back, gives a new ID,
/// even with <c>IMPLICIT_TRANSACTIONS</c> on.</para>
/// <para>On MySQL and MariaDB the session takes the process's Preview turn (<see cref="PreviewTurns"/>) when it opens and
/// keeps it until it ends, and each step registers the held connection with the MySql.Data hook, which proves before
/// every statement that the server hasn't rolled the transaction back.</para>
/// <para>Ending the session rolls the transaction back and disposes the session's scope, which returns the connection.</para>
/// </remarks>
internal sealed class EntityFrameworkHeldPreview<TContext> : IHeldPreview where TContext : DbContext
{
    private const string CheckSavepoint = "sendproof_check";
    private const string SqlServer = "Microsoft.EntityFrameworkCore.SqlServer";

    /// <summary>How long opening a MySQL session waits for the process's Preview turn.</summary>
    private static readonly TimeSpan TurnWait = TimeSpan.FromSeconds(5);

    /// <summary>How long opening a session waits for SQLite's write lock before it answers that the store is busy.</summary>
    private static readonly TimeSpan BeginWait = TimeSpan.FromSeconds(3);

    private readonly AsyncServiceScope _scope;
    private readonly TContext _held;
    private readonly IDbContextTransaction _transaction;
    private readonly IDisposable? _turn;
    private readonly long? _transactionId;
    private EntityFrameworkChangeCapture? _capture;
    private IReadOnlyList<PreviewChange> _changes = [];
    private bool _truncated;
    private int _step;
    private bool _ended;

    private EntityFrameworkHeldPreview(AsyncServiceScope scope, TContext held, IDbContextTransaction transaction, IDisposable? turn,
        long? transactionId)
    {
        _scope = scope;
        _held = held;
        _transaction = transaction;
        _turn = turn;
        _transactionId = transactionId;
    }

    /// <summary>
    /// Opens the session's connection and transaction in a service scope of its own.
    /// </summary>
    /// <param name="services">The request's services.</param>
    /// <param name="store">The database as the refusal names it, such as the SQLite file.</param>
    /// <param name="cancellationToken">Cancels opening.</param>
    /// <exception cref="PreviewStoreBusyException">Another session or transaction holds the database, so the session can't begin.</exception>
    internal static async Task<EntityFrameworkHeldPreview<TContext>> OpenAsync(IServiceProvider services, string store, CancellationToken cancellationToken)
    {
        var scope = services.GetRequiredService<IServiceScopeFactory>().CreateAsyncScope();
        IDisposable? turn = null;
        IDbContextTransaction? transaction = null;
        try
        {
            var held = scope.ServiceProvider.GetRequiredService<TContext>();
            var provider = held.Database.ProviderName;
            try
            {
                turn = await PreviewTurns.EnterForSessionAsync(provider, TurnWait, cancellationToken);
            }
            catch (TimeoutException busy)
            {
                throw new PreviewStoreBusyException(store, busy);
            }

            try
            {
                // Not the driver's usual wait (SQLite's is 30 seconds): a held database should refuse within seconds.
                using (StoreLocks.ShortenWait(provider, held.Database.GetDbConnection(), BeginWait))
                {
                    transaction = await OwnSql.RunAsync(() => held.Database.BeginTransactionAsync(cancellationToken));
                }
            }
            catch (Exception error) when (StoreLocks.IsHeldByAnother(provider, error))
            {
                throw new PreviewStoreBusyException(store, error);
            }

            var transactionId = provider == SqlServer ? await TransactionIdAsync(held, cancellationToken) : (long?)null;
            return new EntityFrameworkHeldPreview<TContext>(scope, held, transaction, turn, transactionId);
        }
        catch
        {
            if (transaction is not null)
            {
                await OwnSql.RunAsync(() => transaction.DisposeAsync().AsTask());
            }

            await scope.DisposeAsync();
            turn?.Dispose();
            throw;
        }
    }

    public IReadOnlyList<PreviewChange> Changes => _changes;

    public bool ChangesTruncated => _truncated;

    public async ValueTask BeginStepAsync(HttpContext context, SendproofPreview preview, int step, CancellationToken cancellationToken)
    {
        var db = context.RequestServices.GetRequiredService<TContext>();
        // The request's context works on the session's connection, inside its transaction, and owns neither: disposing it at
        // the end of the request leaves both open for the next step.
        db.Database.SetDbConnection(_held.Database.GetDbConnection(), contextOwnsConnection: false);
        await db.Database.UseTransactionAsync(_transaction.GetDbTransaction(), cancellationToken);
        await OwnSql.RunAsync(async () =>
        {
            await _transaction.CreateSavepointAsync(StepSavepoint(step), cancellationToken);
            await _transaction.CreateSavepointAsync(CheckSavepoint, cancellationToken);
        });
        _step = step;
        _changes = [];
        _truncated = false;
        _capture = new EntityFrameworkChangeCapture(db);
        if (PreviewTurns.IsMySql(_held.Database.ProviderName))
        {
            // This step's Preview now owns the held connection as far as the MySql.Data hook is concerned.
            SqlGuard.RegisterPreviewConnection(_held.Database.GetDbConnection(), context.RequestServices.GetRequiredService<CaptureContext>(),
                PreviewSavepoint.Probe(_held));
        }
    }

    public async ValueTask KeepStepAsync(CancellationToken cancellationToken)
    {
        var capture = Detach();
        try
        {
            await OwnSql.RunAsync(() => _transaction.ReleaseSavepointAsync(CheckSavepoint, cancellationToken));
            if (_transactionId is { } opened && await TransactionIdAsync(_held, cancellationToken) != opened)
            {
                throw new InvalidOperationException("The SQL Server transaction is not the one the session opened.");
            }
        }
        catch (Exception unusable) when (unusable is DbException or InvalidOperationException)
        {
            // The check savepoint is gone, or the transaction is unusable (a PostgreSQL error the handler caught left it
            // aborted). Rolling back to the step's savepoint proves which.
            await RollBackToAsync(_step, cancellationToken);
            throw new PreviewStepUndoneException("The step left the session's SQL transaction unusable, so it was rolled back.", unusable);
        }

        _changes = [.. capture?.Changes ?? []];
        _truncated = capture?.ChangesTruncated == true;
    }

    public async ValueTask UndoStepAsync(CancellationToken cancellationToken)
    {
        Detach();
        await RollBackToAsync(_step, cancellationToken);
    }

    public async ValueTask RewindAsync(int step, CancellationToken cancellationToken) => await RollBackToAsync(step, cancellationToken);

    public async ValueTask EndAsync()
    {
        if (_ended) return;
        _ended = true;
        Detach();
        try
        {
            await OwnSql.RunAsync(() => _transaction.RollbackAsync(CancellationToken.None));
        }
        finally
        {
            try
            {
                await OwnSql.RunAsync(() => _transaction.DisposeAsync().AsTask());
            }
            finally
            {
                await _scope.DisposeAsync();
                // Other MySQL Previews in the process may run again.
                _turn?.Dispose();
            }
        }
    }

    /// <summary>
    /// SQL Server's ID for the transaction open on the held connection. EF Core has no API for it, so this is a plain
    /// query on the provider's connection, past the guards and outside the captured SQL.
    /// </summary>
    private static async Task<long> TransactionIdAsync(TContext held, CancellationToken cancellationToken)
    {
        var connection = held.Database.GetDbConnection();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT CURRENT_TRANSACTION_ID()";
        command.Transaction = held.Database.CurrentTransaction?.GetDbTransaction();
        return Convert.ToInt64(await OwnSql.RunAsync(() => command.ExecuteScalarAsync(cancellationToken)), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string StepSavepoint(int step) => $"sendproof_step_{step}";

    private EntityFrameworkChangeCapture? Detach()
    {
        var capture = _capture;
        _capture = null;
        capture?.Dispose();
        _changes = [];
        _truncated = false;
        return capture;
    }

    /// <summary>Rolls back to the savepoint before a step. If it is gone, something committed or ended the transaction.</summary>
    private async Task RollBackToAsync(int step, CancellationToken cancellationToken)
    {
        try
        {
            await OwnSql.RunAsync(() => _transaction.RollbackToSavepointAsync(StepSavepoint(step), cancellationToken));
        }
        catch (Exception failure) when (failure is DbException or InvalidOperationException)
        {
            throw new PreviewTransactionEndedException(
                "The preview session's SQL transaction was committed or ended (its savepoint is gone), so its writes may have " +
                "persisted and the session can't go on.", failure);
        }
    }
}

using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// The MySQL and MariaDB backstop of spec/data-stores.md "Transaction-control statements from the handler": proof, just
/// before the rollback, that nothing committed the Preview transaction.
/// </summary>
/// <remarks>
/// MySQL has no <c>@@in_transaction</c>, and with auto-commit off it opens a new transaction implicitly after any commit,
/// so "is a transaction open" can't tell the Preview's from a later one. Instead the provider makes savepoint
/// <c>sendproof_preview</c> right after it opens the Preview transaction, and rolls back to it before the final rollback.
/// Every commit, explicit or implicit, erases every savepoint, so a missing savepoint (MySQL error 1305) means the
/// Preview's writes were committed: the Preview answers 500 without confirmation. The commands run through plain
/// ADO.NET, past EF Core's interceptors, so the probe never shows in the captured SQL; the handler can't release, roll
/// back to or recreate the savepoint (see <see cref="SqlStatements"/>).
/// </remarks>
internal sealed class PreviewSavepoint
{
    private readonly DbContext _context;

    private PreviewSavepoint(DbContext context) => _context = context;

    /// <summary>Makes the savepoint in the Preview transaction just opened on the context's connection.</summary>
    internal static async Task<PreviewSavepoint> OpenAsync(DbContext context, CancellationToken cancellationToken)
    {
        var savepoint = new PreviewSavepoint(context);
        await savepoint.RunAsync("SAVEPOINT " + SqlStatements.PreviewSavepointName, cancellationToken);
        return savepoint;
    }

    /// <summary>Rolls back to the savepoint, proving the Preview transaction is still the one it opened.</summary>
    /// <exception cref="PreviewTransactionEndedException">The savepoint is gone, or the check couldn't run.</exception>
    internal async Task VerifyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await RunAsync("ROLLBACK TO SAVEPOINT " + SqlStatements.PreviewSavepointName, cancellationToken);
        }
        catch (DbException failure)
        {
            throw new PreviewTransactionEndedException(
                failure.Message.Contains("does not exist", StringComparison.OrdinalIgnoreCase) || failure.ErrorCode == 1305
                    ? "Something committed the Preview's MySQL transaction while the handler ran (its savepoint is gone), so its writes may have persisted and the Preview can't be confirmed."
                    : "Sendproof couldn't confirm the Preview's MySQL transaction was still open, so the Preview can't be confirmed.",
                failure);
        }
    }

    private async Task RunAsync(string sql, CancellationToken cancellationToken)
    {
        await using var command = _context.Database.GetDbConnection().CreateCommand();
        command.CommandText = sql;
        command.Transaction = _context.Database.CurrentTransaction?.GetDbTransaction();
        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}

/// <summary>
/// The Preview's SQL transaction was committed while the handler ran (or Sendproof couldn't prove it wasn't), so the
/// Preview answers 500 without confirmation.
/// </summary>
public sealed class PreviewTransactionEndedException : InvalidOperationException
{
    /// <summary>Creates the exception.</summary>
    public PreviewTransactionEndedException(string message, Exception? innerException = null) : base(message, innerException)
    {
    }
}

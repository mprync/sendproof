using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// One Preview's EF Core transaction, always rolled back. On MySQL and MariaDB it keeps a <see cref="PreviewSavepoint"/>:
/// if the savepoint is gone when the Preview ends, something committed the transaction and the rollback fails, so the
/// Preview answers 500 without confirmation.
/// </summary>
internal sealed class EntityFrameworkPreviewSession(DbContext context, IDbContextTransaction transaction, IDisposable? turn = null,
    PreviewSavepoint? savepoint = null) : IPreviewSession
{
    private readonly EntityFrameworkChangeCapture _capture = new(context);
    private bool _rolledBack;
    private bool _disposed;

    public IReadOnlyList<PreviewChange> Changes => _capture.Changes;

    public bool ChangesTruncated => _capture.ChangesTruncated;

    public async ValueTask RollbackAsync(CancellationToken cancellationToken)
    {
        if (_rolledBack) return;
        PreviewTransactionEndedException? ended = null;
        if (savepoint is not null)
        {
            try
            {
                await savepoint.VerifyAsync(cancellationToken);
            }
            catch (PreviewTransactionEndedException failure)
            {
                ended = failure;
            }
        }

        await OwnSql.RunAsync(() => transaction.RollbackAsync(cancellationToken));
        _rolledBack = true;
        if (ended is not null) throw ended;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _capture.Dispose();
        try
        {
            if (!_rolledBack) await RollbackAsync(CancellationToken.None);
        }
        finally
        {
            try
            {
                // The Preview's own cleanup, which the guarding connection lets end the transaction.
                await OwnSql.RunAsync(() => transaction.DisposeAsync().AsTask());
            }
            finally
            {
                // MySQL Previews take turns: the next one starts only once this transaction has ended.
                turn?.Dispose();
            }
        }
    }
}

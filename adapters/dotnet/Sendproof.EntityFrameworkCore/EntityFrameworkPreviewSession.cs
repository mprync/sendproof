using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

internal sealed class EntityFrameworkPreviewSession(DbContext context, IDbContextTransaction transaction, IDisposable? turn = null) : IPreviewSession
{
    private readonly EntityFrameworkChangeCapture _capture = new(context);
    private bool _rolledBack;
    private bool _disposed;

    public IReadOnlyList<PreviewChange> Changes => _capture.Changes;

    public bool ChangesTruncated => _capture.ChangesTruncated;

    public async ValueTask RollbackAsync(CancellationToken cancellationToken)
    {
        if (_rolledBack) return;
        await SendproofCommitDiagnostics.RollingBackAsync(() => transaction.RollbackAsync(cancellationToken));
        _rolledBack = true;
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
                await transaction.DisposeAsync();
            }
            finally
            {
                // MySQL Previews take turns: the next one starts only once this transaction has ended.
                turn?.Dispose();
            }
        }
    }
}

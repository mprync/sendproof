using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using TestBench.AspNetCore;

namespace TestBench.EntityFrameworkCore;

internal sealed class EntityFrameworkPreviewSession(DbContext context, IDbContextTransaction transaction) : IPreviewSession
{
    private readonly EntityFrameworkChangeCapture _capture = new(context);
    private bool _rolledBack;
    private bool _disposed;

    public IReadOnlyList<PreviewChange> Changes => _capture.Changes;

    public bool ChangesTruncated => _capture.ChangesTruncated;

    public async ValueTask RollbackAsync(CancellationToken cancellationToken)
    {
        if (_rolledBack) return;
        await transaction.RollbackAsync(cancellationToken);
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
            await transaction.DisposeAsync();
        }
    }
}

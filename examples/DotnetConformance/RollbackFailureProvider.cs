using Microsoft.AspNetCore.Http;
using Sendproof.AspNetCore;

namespace DotnetConformance;

/// <summary>Decorates the real preview provider so that every rollback reports an injected failure.</summary>
internal sealed class RollbackFailureProvider(IPreviewProvider inner) : IPreviewProvider
{
    public bool IsAvailable => inner.IsAvailable;

    public string? Database => inner.Database;

    public IPreviewObservation? BeginObservation(HttpContext context) => inner.BeginObservation(context);

    public async ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken) =>
        new FailingSession(await inner.BeginAsync(context, cancellationToken));

    private sealed class FailingSession(IPreviewSession inner) : IPreviewSession
    {
        public IReadOnlyList<PreviewChange> Changes => inner.Changes;

        public bool ChangesTruncated => inner.ChangesTruncated;

        // The wrapped transaction is never committed. Disposal still rolls it back, so no data is promoted.
        public ValueTask RollbackAsync(CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Injected rollback failure.");

        public ValueTask DisposeAsync() => inner.DisposeAsync();
    }
}

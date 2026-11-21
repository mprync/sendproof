using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Sendproof.AspNetCore;

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Refuses a commit during a Preview for providers that have no transaction interceptors, such as
/// <c>MongoDB.EntityFrameworkCore</c>. EF Core providers report <c>TransactionCommitting</c> on the
/// <c>Microsoft.EntityFrameworkCore</c> diagnostic listener before they commit; throwing from that event stops the commit
/// before it reaches the server, and the Preview can never be confirmed, even if the handler catches the exception.
/// </summary>
/// <remarks>
/// This covers the handler's <c>Database.CommitTransaction()</c>, a commit of <c>CurrentTransaction</c>, and the
/// transaction EF starts and commits for a save after the handler rolled the Preview transaction back. Relational
/// providers report the same event, so their commits are refused here as well as by
/// <see cref="SendproofTransactionInterceptor"/>.
/// </remarks>
internal sealed class SendproofCommitDiagnostics : IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>, IDisposable
{
    private readonly CaptureContext _capture;
    private readonly IDisposable _listeners;
    private readonly List<IDisposable> _subscriptions = [];
    private bool _disposed;

    public SendproofCommitDiagnostics(CaptureContext capture)
    {
        _capture = capture;
        // Replays the listeners that already exist, then reports each new one (one per EF Core internal service provider).
        _listeners = DiagnosticListener.AllListeners.Subscribe(this);
    }

    /// <summary>Set while the Preview session itself rolls back, so only the handler's rollback is refused.</summary>
    private static readonly AsyncLocal<bool> OwnRollback = new();

    /// <summary>Runs the Preview's own rollback, which must not be refused.</summary>
    internal static async Task RollingBackAsync(Func<Task> rollback)
    {
        OwnRollback.Value = true;
        try
        {
            await rollback();
        }
        finally
        {
            OwnRollback.Value = false;
        }
    }

    // A commit would persist the Preview's writes. A full rollback would end the Preview transaction, after which a save
    // writes for real (MongoDB's provider saves a single document with no transaction at all). Savepoint rollbacks
    // report a different event and stay allowed.
    private static bool IsCommitting(string name) =>
        name.EndsWith(".TransactionCommitting", StringComparison.Ordinal) || name.EndsWith(".TransactionRollingBack", StringComparison.Ordinal);

    void IObserver<DiagnosticListener>.OnNext(DiagnosticListener listener)
    {
        if (listener.Name != DbLoggerCategory.Name)
        {
            return;
        }

        lock (_subscriptions)
        {
            if (!_disposed)
            {
                _subscriptions.Add(listener.Subscribe(this, IsCommitting));
            }
        }
    }

    void IObserver<KeyValuePair<string, object?>>.OnNext(KeyValuePair<string, object?> value)
    {
        if (IsCommitting(value.Key) && !OwnRollback.Value && _capture.Current is { InPreview: true })
        {
            var verb = value.Key.EndsWith(".TransactionCommitting", StringComparison.Ordinal) ? "commit" : "rollback";
            throw _capture.RefuseInPreview($"Preview owns the transaction, so the handler's {verb} cannot run during Preview.")!;
        }
    }

    void IObserver<DiagnosticListener>.OnCompleted()
    {
    }

    void IObserver<DiagnosticListener>.OnError(Exception error)
    {
    }

    void IObserver<KeyValuePair<string, object?>>.OnCompleted()
    {
    }

    void IObserver<KeyValuePair<string, object?>>.OnError(Exception error)
    {
    }

    public void Dispose()
    {
        _listeners.Dispose();
        lock (_subscriptions)
        {
            _disposed = true;
            foreach (var subscription in _subscriptions)
            {
                subscription.Dispose();
            }

            _subscriptions.Clear();
        }
    }
}

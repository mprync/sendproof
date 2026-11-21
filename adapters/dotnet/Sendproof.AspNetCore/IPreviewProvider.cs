using Microsoft.AspNetCore.Http;

namespace Sendproof.AspNetCore;

/// <summary>Opens a rollback-only session in the scope of the selected API operation.</summary>
public interface IPreviewProvider
{
    /// <summary>Gets whether the current request scope supports rollback previews.</summary>
    bool IsAvailable => true;

    /// <summary>Gets a public database label for the workbench, without connection details.</summary>
    string? Database { get; }

    /// <summary>
    /// Starts the transaction using the operation's request-scoped services. The provider owns
    /// cleanup of any resources acquired before a failed begin.
    /// </summary>
    ValueTask<IPreviewSession> BeginAsync(HttpContext context, CancellationToken cancellationToken);

    /// <summary>Optionally observes changes in the operation's scope without starting a transaction.</summary>
    IPreviewObservation? BeginObservation(HttpContext context) => null;
}

/// <summary>Represents the transaction and change capture for one preview request.</summary>
public interface IPreviewSession : IAsyncDisposable
{
    /// <summary>Gets serializable snapshots of captured changes, available after rollback until disposal.</summary>
    IReadOnlyList<PreviewChange> Changes { get; }

    /// <summary>Gets whether the provider omitted changes because it reached a capture limit.</summary>
    bool ChangesTruncated => false;

    /// <summary>Rolls back preview writes. A failure prevents Sendproof from reporting success.</summary>
    ValueTask RollbackAsync(CancellationToken cancellationToken);
}

/// <summary>Captures changes in an observed send without managing its transaction.</summary>
public interface IPreviewObservation : IDisposable
{
    /// <summary>Gets serializable snapshots of captured changes, available until disposal.</summary>
    IReadOnlyList<PreviewChange> Changes { get; }

    /// <summary>Gets whether the provider omitted changes because it reached a capture limit.</summary>
    bool ChangesTruncated => false;
}

/// <summary>Describes one captured change using JSON-serializable keys and values.</summary>
/// <param name="Operation">The kind of change, such as insert, update or delete.</param>
/// <param name="Table">The affected table.</param>
/// <param name="Key">The changed row's key or composite key.</param>
/// <param name="Before">The previous row values, if available.</param>
/// <param name="After">The new row values, if available.</param>
public sealed record PreviewChange(string Operation, string Table, object? Key, object? Before, object? After);

namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Lets MySQL and MariaDB Previews take turns, one at a time per process.
/// </summary>
/// <remarks>
/// InnoDB checks a new key for duplicates under a shared lock. When three or more transactions insert the same key
/// and the first one rolls back, as every Preview does, InnoDB aborts all but one of the rest with a deadlock
/// (error 1213), at every isolation level. Sent for real, the first insert would commit and the others would get a
/// duplicate-key error. A Preview therefore waits for its turn before it takes a pooled connection, and hands the turn
/// back once its transaction has ended. A preview session takes the turn when it opens and keeps it until it ends, so
/// other MySQL Previews in the process wait for the session (its idle timeout bounds that). SQLite Previews already
/// queue for the write lock, so they need no turn.
/// Previews sent to different processes or servers of one application still run together. Sends and observed sends
/// never take a turn.
/// </remarks>
internal static class PreviewTurns
{
    private static readonly SemaphoreSlim MySqlTurn = new(1, 1);

    /// <summary>Whether an EF Core provider name is a MySQL or MariaDB provider (Oracle's, Pomelo's).</summary>
    internal static bool IsMySql(string? providerName) =>
        providerName is not null && (providerName.Contains("MySql", StringComparison.OrdinalIgnoreCase) ||
            providerName.Contains("MariaDb", StringComparison.OrdinalIgnoreCase));

    /// <summary>Waits for this process's turn when the provider needs one. Dispose the result to hand the turn back.</summary>
    internal static async ValueTask<IDisposable?> EnterAsync(string? providerName, CancellationToken cancellationToken)
    {
        if (!IsMySql(providerName))
        {
            return null;
        }

        await MySqlTurn.WaitAsync(cancellationToken);
        return new Turn();
    }

    /// <summary>
    /// Takes the turn for a preview session, which keeps it until the session ends, waiting at most
    /// <paramref name="limit"/>. Answers <see langword="null"/> when the provider needs no turn.
    /// </summary>
    /// <exception cref="TimeoutException">Another Preview or session held the turn for longer than the limit.</exception>
    internal static async ValueTask<IDisposable?> EnterForSessionAsync(string? providerName, TimeSpan limit, CancellationToken cancellationToken)
    {
        if (!IsMySql(providerName))
        {
            return null;
        }

        return await MySqlTurn.WaitAsync(limit, cancellationToken)
            ? new Turn()
            : throw new TimeoutException("Another MySQL Preview or preview session in this process holds the turn; end that session first.");
    }

    private sealed class Turn : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                MySqlTurn.Release();
            }
        }
    }
}

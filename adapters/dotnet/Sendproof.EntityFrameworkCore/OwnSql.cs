namespace Sendproof.EntityFrameworkCore;

/// <summary>
/// Marks SQL work Sendproof itself does for a Preview (beginning its transaction, the backstop savepoint, its own
/// rollback and cleanup), so the guards let it through. It flows with the async context only for the duration of
/// <see cref="RunAsync"/>, so handler code running at the same time is still guarded.
/// </summary>
internal static class OwnSql
{
    private static readonly AsyncLocal<bool> Active = new();

    /// <summary>Whether Sendproof's own Preview work is running on this flow.</summary>
    internal static bool IsActive => Active.Value;

    /// <summary>Runs Sendproof's own Preview work.</summary>
    internal static async Task RunAsync(Func<Task> work)
    {
        Active.Value = true;
        try
        {
            await work();
        }
        finally
        {
            Active.Value = false;
        }
    }

    /// <summary>Runs Sendproof's own synchronous Preview work (from inside a driver hook).</summary>
    internal static void Run(Action work)
    {
        var outer = Active.Value;
        Active.Value = true;
        try
        {
            work();
        }
        finally
        {
            Active.Value = outer;
        }
    }

    /// <summary>Runs Sendproof's own Preview work and returns its result.</summary>
    internal static async Task<T> RunAsync<T>(Func<Task<T>> work)
    {
        Active.Value = true;
        try
        {
            return await work();
        }
        finally
        {
            Active.Value = false;
        }
    }
}

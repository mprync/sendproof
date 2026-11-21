namespace Sendproof.AspNetCore;

/// <summary>
/// Marks work as detached from any request: a background worker or hosted service that writes to a hooked data store.
/// </summary>
/// <remarks>
/// While a Preview is open, a write to a hooked store that belongs to no request (no request context flowed to it) could
/// be the Preview's own write sent from a thread Sendproof can't attribute, so it fails every open Preview with 500 rather
/// than risk a false "rolled back". Wrap work that is genuinely independent of requests in <see cref="Begin"/> to exempt it.
/// </remarks>
public static class DetachedWork
{
    internal static readonly AsyncLocal<bool> Marked = new();

    /// <summary>Marks the current async flow as detached until the result is disposed.</summary>
    public static IDisposable Begin() => new Scope();

    private sealed class Scope : IDisposable
    {
        private readonly bool _previous = Marked.Value;

        public Scope() => Marked.Value = true;

        public void Dispose() => Marked.Value = _previous;
    }
}

using System.Collections.Concurrent;

namespace Sendproof.AspNetCore;

// The slot belongs to this host. Closing the recorder also closes it in any
// child execution context that inherited the slot before the request ended.
internal sealed class CaptureContext
{
    private readonly AsyncLocal<SendproofPreview?> _current = new();

    // True inside any request (ordinary, observed or Preview), whether or not it records. A write from code that is in no
    // request at all (a background worker, a hosted service) has nothing to attribute it to.
    private readonly AsyncLocal<bool> _inRequest = new();

    // The Previews that are open right now, for the rule that a write nobody can attribute fails all of them.
    private readonly ConcurrentDictionary<SendproofPreview, byte> _open = new();

    internal SendproofPreview? Current => _current.Value;

    internal Scope Enter(SendproofPreview? recorder = null)
    {
        var scope = new Scope(_current, _current.Value, _inRequest, _inRequest.Value);
        _current.Value = recorder;
        _inRequest.Value = true;
        return scope;
    }

    /// <summary>Registers a Preview as open until <see cref="Close"/>.</summary>
    internal void Open(SendproofPreview preview) => _open[preview] = 0;

    /// <summary>Removes a finished Preview from the open set.</summary>
    internal void Close(SendproofPreview preview) => _open.TryRemove(preview, out _);

    /// <summary>
    /// Call for every write a hook sees. A write that belongs to no request and isn't marked <see cref="DetachedWork"/>
    /// could be a Preview's own write from a thread Sendproof can't attribute, so it fails every open Preview with 500:
    /// the Preview must never claim a rollback it can't vouch for. A runtime that flows the request context (this one does,
    /// through <see cref="AsyncLocal{T}"/>) attributes everything a request does, so this only fires for genuine strays.
    /// </summary>
    internal void ReportWrite(string store, string operation)
    {
        if (_current.Value is not null || _inRequest.Value || DetachedWork.Marked.Value || _open.IsEmpty)
        {
            return;
        }

        foreach (var preview in _open.Keys)
        {
            preview.Refuse(new PreviewTransactionControlException(
                $"A {store} {operation} with no request attribution ran while a Preview was open; the Preview can't be confirmed."));
        }
    }

    internal readonly struct Scope(AsyncLocal<SendproofPreview?> slot, SendproofPreview? previous, AsyncLocal<bool> inRequest, bool wasInRequest) : IDisposable
    {
        public void Dispose()
        {
            slot.Value = previous;
            inRequest.Value = wasInRequest;
        }
    }
}

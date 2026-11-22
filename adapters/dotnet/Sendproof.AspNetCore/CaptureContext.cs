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
    /// For a hook that can only observe a write after it was sent (the MongoDB command monitor). A write that belongs to no request and isn't marked <see cref="DetachedWork"/>
    /// could be a Preview's own write from a thread Sendproof can't attribute, so it fails every open Preview with 500:
    /// the Preview must never claim a rollback it can't vouch for. A runtime that flows the request context (this one does,
    /// through <see cref="AsyncLocal{T}"/>) attributes everything a request does, so this only fires for genuine strays.
    /// </summary>
    internal void ReportWrite(string store, string operation)
    {
        if (Unattributed)
        {
            foreach (var preview in _open.Keys)
            {
                preview.Refuse(new PreviewTransactionControlException(
                    $"A {store} {operation} with no request attribution ran while a Preview was open; the Preview can't be confirmed."));
            }
        }
    }

    /// <summary>Whether the calling code belongs to no request, isn't detached, and a Preview is open right now.</summary>
    private bool Unattributed => _current.Value is null && !_inRequest.Value && !DetachedWork.Marked.Value && !_open.IsEmpty;

    /// <summary>
    /// For a hook that can refuse a command before it is sent (a guarded store): a write that belongs to no request while a
    /// Preview is open is treated as that Preview's write. It marks every open Preview blocked and throws
    /// <see cref="PreviewWriteBlockedException"/>, so the write never reaches the store; failing the Preview after letting it
    /// through would not be enough, because a guarded store can't roll it back. Work in a <see cref="DetachedWork"/> scope is
    /// never refused.
    /// </summary>
    /// <exception cref="PreviewWriteBlockedException">The write is unattributed and a Preview is open.</exception>
    internal void RefuseUnattributedWrite(string store, string operation)
    {
        if (!Unattributed)
        {
            return;
        }

        var reason = DataStoreGuard.WriteReason(store);
        foreach (var preview in _open.Keys)
        {
            preview.Block(new BlockedWrite(store, operation, reason));
        }

        throw new PreviewWriteBlockedException(store, operation, reason);
    }

    /// <summary>
    /// For a write whose context says nothing about which request it belongs to, whatever it holds: the Cosmos DB SDK's bulk
    /// dispatcher sends operations queued by many callers in one batch, from the context of whichever caller created the
    /// dispatcher. While any Preview is open the write is refused before it is sent and blocks every open Preview, as an
    /// unattributed write does; otherwise it runs. <see cref="DetachedWork"/> does not exempt it, because that mark too comes from
    /// the dispatcher's creator rather than from the callers whose operations are in the batch.
    /// </summary>
    /// <exception cref="PreviewWriteBlockedException">A Preview is open.</exception>
    internal void RefuseUnattributableWrite(string store, string operation)
    {
        if (_open.IsEmpty)
        {
            return;
        }

        var reason = DataStoreGuard.WriteReason(store);
        foreach (var preview in _open.Keys)
        {
            preview.Block(new BlockedWrite(store, operation, reason));
            preview.RecordDb(new DbEntry(store, operation) { Blocked = true });
        }

        throw new PreviewWriteBlockedException(store, operation, reason);
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

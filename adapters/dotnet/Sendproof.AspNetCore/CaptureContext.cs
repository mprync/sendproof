namespace Sendproof.AspNetCore;

// The slot belongs to this host. Closing the recorder also closes it in any
// child execution context that inherited the slot before the request ended.
internal sealed class CaptureContext
{
    private readonly AsyncLocal<SendproofPreview?> _current = new();

    internal SendproofPreview? Current => _current.Value;

    internal Scope Enter(SendproofPreview? recorder = null)
    {
        var scope = new Scope(_current, _current.Value);
        _current.Value = recorder;
        return scope;
    }

    internal readonly struct Scope(AsyncLocal<SendproofPreview?> slot, SendproofPreview? previous) : IDisposable
    {
        public void Dispose() => slot.Value = previous;
    }
}

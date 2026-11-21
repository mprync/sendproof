using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace TestBench.AspNetCore;

internal sealed class PreviewResponseCapture() : StreamResponseBodyFeature(new BoundedResponseStream()), IHttpResponseFeature
{
    private readonly Stack<(Func<object, Task> Callback, object State)> _starting = new();
    private readonly Stack<(Func<object, Task> Callback, object State)> _completed = new();
    private bool _startingInvoked;

    public int StatusCode { get; set; } = StatusCodes.Status200OK;
    public string? ReasonPhrase { get; set; }
    public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
    public bool HasStarted => _startingInvoked;
    internal bool ExceededLimit => ((BoundedResponseStream)Stream).ExceededLimit;

    Stream IHttpResponseFeature.Body
    {
        get => Stream;
        set => throw new NotSupportedException("The preview response stream cannot be replaced through the response feature.");
    }

    public void OnStarting(Func<object, Task> callback, object state)
    {
        if (HasStarted)
        {
            throw new InvalidOperationException("The preview response has already started.");
        }

        _starting.Push((callback, state));
    }

    public void OnCompleted(Func<object, Task> callback, object state) => _completed.Push((callback, state));

    // The simulated response stays mutable until the pipeline returns. Nothing starts on the server.
    public override Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public override void DisableBuffering() => throw new NotSupportedException("Test Bench previews require a buffered response.");

    public override Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("Test Bench previews require a buffered response.");

    internal async Task FinishAsync()
    {
        await InvokeCallbacksAsync(_starting);
        _startingInvoked = true;
        await CompleteAsync();
    }

    internal async Task RunCompletionCallbacksAsync()
    {
        List<Exception>? failures = null;
        while (_completed.TryPop(out var entry))
        {
            try
            {
                await entry.Callback(entry.State);
            }
            catch (Exception error)
            {
                (failures ??= []).Add(error);
            }
        }

        if (failures is not null)
        {
            throw new AggregateException(failures);
        }
    }

    internal object? ReadBody()
    {
        var buffer = ((BoundedResponseStream)Stream).ToArray();
        if (buffer.Length == 0)
        {
            return null;
        }

        var contentType = Headers.ContentType.ToString().Split(';', 2)[0].Trim();
        if (contentType.Equals("application/json", StringComparison.OrdinalIgnoreCase) || contentType.EndsWith("+json", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                using var json = JsonDocument.Parse(buffer);
                return json.RootElement.Clone();
            }
            catch (JsonException)
            {
                return Encoding.UTF8.GetString(buffer);
            }
        }

        return contentType.Length == 0 || contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase)
            ? Encoding.UTF8.GetString(buffer)
            : Convert.ToBase64String(buffer);
    }

    private static async Task InvokeCallbacksAsync(Stack<(Func<object, Task> Callback, object State)> callbacks)
    {
        while (callbacks.TryPop(out var entry))
        {
            await entry.Callback(entry.State);
        }
    }

    private sealed class BoundedResponseStream : MemoryStream
    {
        private const int MaximumBytes = 1024 * 1024;
        internal bool ExceededLimit { get; private set; }

        public override void Write(byte[] buffer, int offset, int count)
        {
            CheckLength(Position + count);
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            CheckLength(Position + buffer.Length);
            base.Write(buffer);
        }

        public override void WriteByte(byte value)
        {
            CheckLength(Position + 1);
            base.WriteByte(value);
        }

        public override void SetLength(long value)
        {
            CheckLength(value);
            base.SetLength(value);
        }

        private void CheckLength(long length)
        {
            if (length > MaximumBytes)
            {
                ExceededLimit = true;
                throw new PreviewResponseTooLargeException();
            }
        }
    }
}

internal sealed class PreviewResponseTooLargeException : Exception;

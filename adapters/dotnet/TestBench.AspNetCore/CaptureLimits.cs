using System.Text.Json;

namespace TestBench.AspNetCore;

internal static class CaptureLimits
{
    internal const int Logs = 500;
    internal const int Effects = 100;
    internal const int Changes = 200;
    internal const int Properties = 32;
    internal const int Parameters = 64;
    internal const int Name = 256;
    internal const int Text = 4096;
    internal const int PayloadBytes = 16 * 1024;
    internal const int LogBudget = 128 * 1024;
    private const int PayloadBudget = 128 * 1024;
    private static readonly JsonSerializerOptions PayloadJson = new(PreviewProtocol.JsonOptions) { MaxDepth = 16 };

    internal static string Clip(string value, int maximum = Text)
    {
        if (value.Length <= maximum)
        {
            return value;
        }

        return value[..(char.IsHighSurrogate(value[maximum - 1]) ? maximum - 1 : maximum)];
    }

    internal static JsonElement? Snapshot(object value)
    {
        try
        {
            using var buffer = new PayloadBuffer();
            JsonSerializer.Serialize(buffer, value, PayloadJson);
            using var document = JsonDocument.Parse(buffer.GetBuffer().AsMemory(0, (int)buffer.Length));
            return Fits(document.RootElement) ? document.RootElement.Clone() : null;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // Host-provided payloads may be cyclic, oversized, or fail in a getter/converter.
            // Capture must never interrupt the application or its rollback.
            return null;
        }
    }

    internal static int Size(JsonElement? value) => value?.GetRawText().Length ?? 0;

    internal static (PreviewChange[] Changes, bool Truncated) SnapshotChanges(IReadOnlyList<PreviewChange> changes)
    {
        var result = new List<PreviewChange>();
        var truncated = changes.Count > Changes;
        var remaining = PayloadBudget;
        foreach (var change in changes.Take(Changes))
        {
            var key = change.Key is null ? null : Snapshot(change.Key);
            var before = change.Before is null ? null : Snapshot(change.Before);
            var after = change.After is null ? null : Snapshot(change.After);
            var operation = Clip(change.Operation, Name);
            var table = Clip(change.Table, Name);
            remaining -= Size(key) + Size(before) + Size(after) + operation.Length + table.Length;
            if (remaining < 0)
            {
                truncated = true;
                break;
            }

            truncated |= (key is null && change.Key is not null) || (before is null && change.Before is not null) ||
                (after is null && change.After is not null) || operation != change.Operation || table != change.Table;
            result.Add(new PreviewChange(operation, table, key, before, after));
        }

        return ([.. result], truncated);
    }

    private static bool Fits(JsonElement value, int depth = 0) => depth < PayloadJson.MaxDepth && value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!.Length <= Text,
        JsonValueKind.Array => value.GetArrayLength() <= Parameters &&
            value.EnumerateArray().All(item => Fits(item, depth + 1)),
        JsonValueKind.Object => value.GetPropertyCount() <= Parameters &&
            value.EnumerateObject().All(property => property.Name.Length <= Name && Fits(property.Value, depth + 1)),
        _ => true
    };

    private sealed class PayloadBuffer : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count)
        {
            Check(count);
            base.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            Check(buffer.Length);
            base.Write(buffer);
        }

        private void Check(int count)
        {
            if (Position + count > PayloadBytes)
            {
                throw new InvalidOperationException("The capture payload exceeds its size limit.");
            }
        }
    }
}

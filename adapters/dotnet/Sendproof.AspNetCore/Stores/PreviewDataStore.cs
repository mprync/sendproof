using System.Text.Json.Serialization;

namespace Sendproof.AspNetCore;

/// <summary>
/// A data store the host has hooked: MongoDB, Redis, DynamoDB. Register one through the store's own
/// <c>Add…</c> extension on <see cref="SendproofBuilder"/>; the Preview pipeline then asks it to begin and finish
/// every Preview, and capabilities list it under <c>dataStores</c>.
/// </summary>
/// <remarks>
/// A store only covers the clients it hooked. A client the host created some other way is neither guarded nor
/// rolled back.
/// </remarks>
public interface IPreviewDataStore
{
    /// <summary>Gets the store id used in capabilities, change records and Db log entries: <c>mongodb</c>, <c>redis</c>, <c>dynamodb</c>.</summary>
    string System { get; }

    /// <summary>Describes the store and how Preview treats it, for discovery.</summary>
    ValueTask<DataStoreDescription> DescribeAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Starts whatever the store needs for one Preview, such as a MongoDB transaction. Keep the Preview's state in
    /// <see cref="SendproofPreview"/>'s per-request state, not in an <see cref="AsyncLocal{T}"/>: a value set here
    /// would not flow back to the handler.
    /// </summary>
    ValueTask BeginPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken) => ValueTask.CompletedTask;

    /// <summary>
    /// Runs after the handler and before the SQL rollback, once per Preview, even when the handler failed: capture
    /// the store's changes, then abort its transaction. A failure here fails the Preview with 500, without
    /// confirmation.
    /// </summary>
    ValueTask FinishPreviewAsync(SendproofPreview preview, CancellationToken cancellationToken) => ValueTask.CompletedTask;
}

/// <summary>
/// A store that makes every Preview unavailable while the host uses a client of it the guard can't cover, such as a Cosmos DB
/// client in bulk mode. Handlers never run in a Preview then (it answers 409), discovery lists every operation under
/// <c>previewUnavailable</c> with the reason, and Send and observed Send are unaffected.
/// </summary>
internal interface IPreviewBlocker
{
    /// <summary>Gets why every Preview is unavailable, or <see langword="null"/> while Previews can run.</summary>
    string? PreviewBlockedReason { get; }
}

/// <summary>How discovery describes one hooked data store.</summary>
/// <param name="System">The store id.</param>
/// <param name="Name">An optional host-chosen label such as <c>catalog</c>. Never a connection string or host name.</param>
/// <param name="Mode"><c>preview</c> when writes roll back, <c>guard</c> when the first write blocks the Preview.</param>
/// <param name="Reason">Why the store is in <c>guard</c> mode, when that is not the store's nature.</param>
public sealed record DataStoreDescription(string System,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Name, string Mode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Reason = null);

/// <summary>
/// Thrown to the handler when the write guard refuses a command during a Preview. No byte of the command reached the
/// store. The Preview is marked blocked and answers 409 even if the handler catches this exception.
/// </summary>
public sealed class PreviewWriteBlockedException : Exception
{
    /// <summary>Creates the exception for a refused command.</summary>
    public PreviewWriteBlockedException(string store, string operation, string detail) : base(detail)
    {
        Store = store;
        Operation = operation;
    }

    /// <summary>Gets the store id, such as <c>redis</c>.</summary>
    public string Store { get; }

    /// <summary>Gets the refused command or action name. Never its arguments.</summary>
    public string Operation { get; }
}

/// <summary>
/// Thrown when a handler tries to end or escape the Preview transaction: a raw SQL <c>COMMIT</c>, a MongoDB
/// <c>commitTransaction</c>, or a MongoDB command sent with a session other than the Preview's. The Preview
/// answers 500 without confirmation even if the handler catches this exception.
/// </summary>
public sealed class PreviewTransactionControlException(string message) : Exception(message);

/// <summary>The first write the guard refused in a Preview: what the 409 reports.</summary>
internal sealed record BlockedWrite(string Store, string Operation, string Detail);

/// <summary>One data-store command, as the guard and the hooks record it for a <c>Db</c> log entry.</summary>
internal sealed record DbEntry(string System, string Operation)
{
    /// <summary>Gets the collection, table or first key.</summary>
    internal string? Target { get; init; }

    /// <summary>Gets the MongoDB database or Redis database number.</summary>
    internal string? Namespace { get; init; }

    /// <summary>Gets the sanitized command text. Values never appear in it.</summary>
    internal string? Statement { get; init; }

    /// <summary>Gets the documents or items matched, modified or returned.</summary>
    internal int? RowsAffected { get; init; }

    /// <summary>Gets whether this entry is a command the guard refused.</summary>
    internal bool Blocked { get; init; }

    /// <summary>Gets the store's error code name, such as <c>WriteConflict</c>.</summary>
    internal string? Error { get; init; }

    /// <summary>Gets how long the command took.</summary>
    internal double ElapsedMs { get; init; }
}

/// <summary>The write guard of spec/data-stores.md: the one decision point every store hook calls before it sends a command.</summary>
internal static class DataStoreGuard
{
    /// <summary>Display names used in "Preview unavailable: this operation writes to &lt;Store&gt;".</summary>
    internal static string StoreName(string store) => store switch
    {
        "mongodb" => "MongoDB",
        "redis" => "Redis",
        "dynamodb" => "DynamoDB",
        "cassandra" => "Cassandra",
        "elasticsearch" => "Elasticsearch",
        "opensearch" => "OpenSearch",
        "cosmosdb" => "Cosmos DB",
        "firestore" => "Firestore",
        _ => store
    };

    /// <summary>The reason shown for a write to a guarded store.</summary>
    internal static string WriteReason(string store) => $"Preview unavailable: this operation writes to {StoreName(store)}";

    /// <summary>
    /// Call before sending a store command. Does nothing outside a Preview or for anything but a write. In a Preview
    /// it marks the Preview blocked (the first block wins), records a blocked <c>Db</c> entry and throws.
    /// <paramref name="detail"/> replaces the default "writes to &lt;Store&gt;" reason, for example for a MongoDB
    /// command that can't run inside a transaction.
    /// </summary>
    /// <exception cref="PreviewWriteBlockedException">The command is a write and a Preview is running.</exception>
    internal static void Check(this CaptureContext capture, string store, string operation, CommandKind kind, string? detail = null)
    {
        if (kind == CommandKind.Write)
        {
            // A write with no request attribution while a Preview is open is refused before it is sent.
            capture.RefuseUnattributedWrite(store, operation);
        }

        if (kind != CommandKind.Write || capture.Current is not { InPreview: true } preview)
        {
            return;
        }

        var reason = detail ?? WriteReason(store);
        preview.Block(new BlockedWrite(store, operation, reason));
        preview.RecordDb(new DbEntry(store, operation) { Blocked = true });
        throw new PreviewWriteBlockedException(store, operation, reason);
    }

    /// <summary>
    /// Refuses something that would end or escape the Preview transaction. Records the fault on the current Preview,
    /// so the Preview fails with 500 even if the handler catches the exception, and returns the exception for the
    /// caller to throw. Outside a Preview it returns <see langword="null"/>.
    /// </summary>
    internal static PreviewTransactionControlException? RefuseInPreview(this CaptureContext capture, string message)
    {
        if (capture.Current is not { InPreview: true } preview)
        {
            return null;
        }

        var error = new PreviewTransactionControlException(message);
        preview.Refuse(error);
        return error;
    }

    /// <summary>
    /// Validates the optional label a host gives a store for capabilities <c>dataStores</c>. Discovery is shown to
    /// anyone who can open the workbench, so the label must be a display name such as <c>catalog</c>: never a
    /// connection string, URL, host:port, user or password.
    /// </summary>
    internal static string? Label(string? name)
    {
        if (name is null)
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 64 ||
            name.Any(character => char.IsControl(character) || "/\\@=;:?#%".Contains(character)))
        {
            throw new ArgumentException("A data store name must be a display label such as \"catalog\", not a connection string, URL or host.", nameof(name));
        }

        return name;
    }

    /// <summary>Validates host-declared reads ("TreatAsRead"): exact names only, no wildcards or spaces.</summary>
    internal static HashSet<string> ReadSet(IEnumerable<string> names, Func<string, string> transform)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var name in names)
        {
            if (string.IsNullOrEmpty(name) || name.Any(character => character is '*' or '?' || char.IsWhiteSpace(character)))
            {
                throw new ArgumentException("TreatAsRead takes exact command names, without wildcards.", nameof(names));
            }

            set.Add(transform(name));
        }

        return set;
    }

    /// <summary>
    /// Replaces every literal in a PartiQL statement with <c>?</c>: single-quoted strings (with <c>''</c> escapes) and
    /// numbers. Double-quoted identifiers (table and attribute names) are kept as written. A statement may inline
    /// values instead of using <c>?</c> parameters, and a value never appears in a <c>Db</c> entry.
    /// </summary>
    internal static string SanitizePartiql(string text)
    {
        var output = new System.Text.StringBuilder(text.Length);
        for (var index = 0; index < text.Length;)
        {
            var character = text[index];
            if (character == '"')
            {
                var end = text.IndexOf('"', index + 1);
                var stop = end < 0 ? text.Length : end + 1;
                output.Append(text, index, stop - index);
                index = stop;
            }
            else if (character == '\'')
            {
                var end = index + 1;
                while (end < text.Length && !(text[end] == '\'' && (end + 1 >= text.Length || text[end + 1] != '\'')))
                {
                    end += text[end] == '\'' ? 2 : 1;
                }

                output.Append('?');
                index = end + 1;
            }
            else if (char.IsAsciiDigit(character) && (index == 0 || !(char.IsAsciiLetterOrDigit(text[index - 1]) || text[index - 1] is '_' or '.')))
            {
                var end = index;
                while (end < text.Length && char.IsAsciiDigit(text[end])) end++;
                if (end + 1 < text.Length && text[end] == '.' && char.IsAsciiDigit(text[end + 1]))
                {
                    end++;
                    while (end < text.Length && char.IsAsciiDigit(text[end])) end++;
                }

                if (end < text.Length && text[end] is 'e' or 'E')
                {
                    var exponent = end + 1;
                    if (exponent < text.Length && text[exponent] is '+' or '-') exponent++;
                    if (exponent < text.Length && char.IsAsciiDigit(text[exponent]))
                    {
                        while (exponent < text.Length && char.IsAsciiDigit(text[exponent])) exponent++;
                        end = exponent;
                    }
                }

                output.Append('?');
                index = end;
            }
            else
            {
                output.Append(character);
                index++;
            }
        }

        return output.ToString();
    }
}

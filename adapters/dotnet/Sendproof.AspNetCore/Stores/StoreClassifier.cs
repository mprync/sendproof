namespace Sendproof.AspNetCore;

/// <summary>How the guard treats one store command. Only <see cref="Write"/> can block a Preview.</summary>
internal enum CommandKind
{
    /// <summary>The command only reads.</summary>
    Read,

    /// <summary>The command can change data, or the guard does not know it: fail closed.</summary>
    Write,

    /// <summary>A connection-level command such as <c>AUTH</c> or <c>PING</c>: allowed and never logged.</summary>
    Session,

    /// <summary>A Redis <c>MULTI</c>, <c>EXEC</c>, <c>DISCARD</c>, <c>WATCH</c> or <c>UNWATCH</c>.</summary>
    Transaction
}

/// <summary>
/// Write classification for Redis and DynamoDB, driven by the shared tables in spec/data-stores/ (embedded in
/// <see cref="EmbeddedStoreTables"/>). Every method is pure. The shared vectors in
/// spec/data-stores/classification-cases.json run through them in the unit tests. MongoDB is classified in
/// Sendproof.MongoDB, over BSON documents, from the same table.
/// </summary>
internal static class StoreClassifier
{
    /// <summary>
    /// Classifies a Redis command. <paramref name="name"/> is the command name in any case and
    /// <paramref name="firstArgument"/> its first argument, read only to form <c>CONTAINER|SUBCOMMAND</c> keys such
    /// as <c>OBJECT|ENCODING</c>. <paramref name="treatAsRead"/> holds host-declared reads, compared exactly
    /// against the upper-case key.
    /// </summary>
    internal static CommandKind ClassifyRedis(string name, object? firstArgument = null, IReadOnlySet<string>? treatAsRead = null)
    {
        var command = name.ToUpperInvariant();
        var table = StoreTables.Redis;
        var keys = firstArgument is null
            ? new[] { command }
            : new[] { $"{command}|{Convert.ToString(firstArgument, System.Globalization.CultureInfo.InvariantCulture)!.ToUpperInvariant()}", command };
        foreach (var key in keys)
        {
            if (table.Session.Contains(key)) return CommandKind.Session;
            if (table.Transaction.Contains(key)) return CommandKind.Transaction;
            if (table.Read.Contains(key) || treatAsRead?.Contains(key) == true) return CommandKind.Read;
        }

        return CommandKind.Write;
    }

    /// <summary>
    /// Skips whitespace, <c>--</c> line comments and <c>/* */</c> block comments, then returns the first word of a
    /// PartiQL statement in upper case. An unterminated block comment or no word at all gives an empty string.
    /// </summary>
    internal static string PartiqlVerb(string? statement)
    {
        var text = statement ?? "";
        var index = 0;
        while (true)
        {
            while (index < text.Length && char.IsWhiteSpace(text[index])) index++;
            if (string.CompareOrdinal(text, index, "--", 0, 2) == 0)
            {
                var end = text.IndexOf('\n', index);
                if (end < 0) return "";
                index = end + 1;
            }
            else if (string.CompareOrdinal(text, index, "/*", 0, 2) == 0)
            {
                var end = text.IndexOf("*/", index + 2, StringComparison.Ordinal);
                if (end < 0) return "";
                index = end + 2;
            }
            else
            {
                var start = index;
                while (index < text.Length && char.IsAsciiLetter(text[index])) index++;
                return text[start..index].ToUpperInvariant();
            }
        }
    }

    /// <summary>
    /// Classifies a DynamoDB action as <see cref="CommandKind.Read"/> or <see cref="CommandKind.Write"/>.
    /// <paramref name="statements"/> holds the PartiQL text of a PartiQL request (one statement for
    /// <c>ExecuteStatement</c>, one per entry for the batch and transaction forms); a PartiQL request is a read only
    /// when it has statements and every one is a <c>SELECT</c>. <paramref name="treatAsRead"/> holds host-declared
    /// action names.
    /// </summary>
    internal static CommandKind ClassifyDynamo(string operation, IReadOnlyList<string?>? statements = null, IReadOnlySet<string>? treatAsRead = null)
    {
        var table = StoreTables.Dynamo;
        if (table.Read.Contains(operation) || treatAsRead?.Contains(operation) == true) return CommandKind.Read;
        if (table.PartiQl.Contains(operation))
        {
            return statements is { Count: > 0 } && statements.All(statement => PartiqlVerb(statement) == "SELECT")
                ? CommandKind.Read
                : CommandKind.Write;
        }

        return CommandKind.Write;
    }
}

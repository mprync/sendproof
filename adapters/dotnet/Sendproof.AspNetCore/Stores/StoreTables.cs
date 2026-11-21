using System.Text.Json;

namespace Sendproof.AspNetCore;

/// <summary>
/// The shared classification tables of spec/data-stores/, parsed once from the copy embedded in
/// <see cref="EmbeddedStoreTables"/>. Each table lists reads and connection-level commands; everything else is a
/// write, so the guard fails closed when a store adds a command.
/// </summary>
internal static class StoreTables
{
    /// <summary>The Redis table: upper-case command names, with <c>CONTAINER|SUBCOMMAND</c> keys for container commands.</summary>
    internal static RedisTable Redis { get; } = new(Parse(EmbeddedStoreTables.Redis));

    /// <summary>The MongoDB table: command names are compared case-insensitively.</summary>
    internal static MongoTable Mongo { get; } = new(Parse(EmbeddedStoreTables.Mongodb));

    /// <summary>The DynamoDB table: API action names.</summary>
    internal static DynamoTable Dynamo { get; } = new(Parse(EmbeddedStoreTables.Dynamodb));

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static string[] Strings(JsonElement element) => [.. element.EnumerateArray().Select(item => item.GetString()!)];

    /// <summary>The parsed Redis table.</summary>
    internal sealed class RedisTable
    {
        internal RedisTable(JsonElement root)
        {
            Read = new HashSet<string>(Strings(root.GetProperty("read")).Concat(Strings(root.GetProperty("moduleRead"))), StringComparer.Ordinal);
            Session = new HashSet<string>(Strings(root.GetProperty("session")), StringComparer.Ordinal);
            Transaction = new HashSet<string>(Strings(root.GetProperty("transaction")), StringComparer.Ordinal);
        }

        /// <summary>Commands that only read, module reads included.</summary>
        internal HashSet<string> Read { get; }

        /// <summary>Connection-level commands, such as <c>AUTH</c> and <c>PING</c>: allowed and never logged.</summary>
        internal HashSet<string> Session { get; }

        /// <summary><c>MULTI</c>, <c>EXEC</c>, <c>DISCARD</c>, <c>WATCH</c> and <c>UNWATCH</c>.</summary>
        internal HashSet<string> Transaction { get; }
    }

    /// <summary>The parsed MongoDB table.</summary>
    internal sealed class MongoTable
    {
        internal MongoTable(JsonElement root)
        {
            Read = Lower(root.GetProperty("read"));
            Session = Lower(root.GetProperty("session"));
            var refused = root.GetProperty("notInTransaction");
            NotInTransaction = Lower(refused.GetProperty("commands"));
            Stages = Strings(refused.GetProperty("stages"));
            ReasonTemplate = refused.GetProperty("reason").GetString()!;
        }

        /// <summary>Commands that only read.</summary>
        internal HashSet<string> Read { get; }

        /// <summary>Connection-level commands: allowed and never logged.</summary>
        internal HashSet<string> Session { get; }

        /// <summary>Commands the server refuses inside a multi-document transaction.</summary>
        internal HashSet<string> NotInTransaction { get; }

        /// <summary>Aggregation stages the server refuses inside a transaction.</summary>
        internal string[] Stages { get; }

        /// <summary>The block reason, with <c>{operation}</c> for the refused command or stage.</summary>
        internal string ReasonTemplate { get; }

        private static HashSet<string> Lower(JsonElement element) =>
            new(Strings(element).Select(name => name.ToLowerInvariant()), StringComparer.Ordinal);
    }

    /// <summary>The parsed DynamoDB table.</summary>
    internal sealed class DynamoTable
    {
        internal DynamoTable(JsonElement root)
        {
            Read = new HashSet<string>(Strings(root.GetProperty("read")), StringComparer.Ordinal);
            PartiQl = new HashSet<string>(Strings(root.GetProperty("partiql").GetProperty("operations")), StringComparer.Ordinal);
        }

        /// <summary>Actions that only read.</summary>
        internal HashSet<string> Read { get; }

        /// <summary>Actions that carry PartiQL and are a read only when every statement is a <c>SELECT</c>.</summary>
        internal HashSet<string> PartiQl { get; }
    }
}

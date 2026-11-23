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

    /// <summary>The Cassandra table: the statement's first keyword (<c>LIST</c> with its next word), and the protocol messages.</summary>
    internal static CassandraTable Cassandra { get; } = new(Parse(EmbeddedStoreTables.Cassandra));

    /// <summary>The Elasticsearch and OpenSearch table: ordered endpoints, matched by HTTP method and path.</summary>
    internal static ElasticsearchTable Elasticsearch { get; } = new(Parse(EmbeddedStoreTables.Elasticsearch));

    /// <summary>The Cosmos DB table: operation types, compared case-insensitively.</summary>
    internal static CosmosTable Cosmos { get; } = new(Parse(EmbeddedStoreTables.Cosmosdb));

    /// <summary>The Firestore table: RPC methods per gRPC service.</summary>
    internal static FirestoreTable Firestore { get; } = new(Parse(EmbeddedStoreTables.Firestore));

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static string[] Strings(JsonElement element) => [.. element.EnumerateArray().Select(item => item.GetString()!)];

    /// <summary>The parsed Cassandra table.</summary>
    internal sealed class CassandraTable
    {
        internal CassandraTable(JsonElement root)
        {
            Read = new HashSet<string>(Strings(root.GetProperty("read")), StringComparer.Ordinal);
            var protocol = root.GetProperty("protocol");
            Session = new HashSet<string>(Strings(protocol.GetProperty("session")), StringComparer.Ordinal);
        }

        /// <summary>Statement keys that only read: <c>SELECT</c>, <c>USE</c>, <c>DESCRIBE</c> and the <c>LIST …</c> forms.</summary>
        internal HashSet<string> Read { get; }

        /// <summary>Native-protocol messages that carry no statement, such as <c>STARTUP</c> and <c>PREPARE</c>.</summary>
        internal HashSet<string> Session { get; }
    }

    /// <summary>One entry of the Elasticsearch table: the first entry whose method and path match decides.</summary>
    /// <param name="Kind"><c>read</c>, <c>write</c>, <c>session</c> or <c>sql</c> (a read only for one read statement).</param>
    /// <param name="Name">The endpoint id, which is <c>db.operation.name</c>.</param>
    /// <param name="Methods">Upper-case HTTP methods.</param>
    /// <param name="Paths">Path patterns, already split into segments (<c>{index}</c>, <c>{id}</c> or a literal).</param>
    internal sealed record ElasticsearchEndpoint(string Kind, string Name, HashSet<string> Methods, string[][] Paths);

    /// <summary>The parsed Elasticsearch and OpenSearch table.</summary>
    internal sealed class ElasticsearchTable
    {
        internal ElasticsearchTable(JsonElement root)
        {
            Endpoints =
            [
                .. root.GetProperty("endpoints").EnumerateArray().Select(entry => new ElasticsearchEndpoint(
                    entry.GetProperty("kind").GetString()!,
                    entry.GetProperty("name").GetString()!,
                    new HashSet<string>(Strings(entry.GetProperty("methods")), StringComparer.Ordinal),
                    [.. Strings(entry.GetProperty("paths")).Select(path => path.Split('/', StringSplitOptions.RemoveEmptyEntries))]))
            ];
            MethodDefault = root.GetProperty("methodDefault").EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString()!, StringComparer.Ordinal);
            SqlReadWords = new HashSet<string>(Strings(root.GetProperty("sql").GetProperty("readWords")), StringComparer.Ordinal);
        }

        /// <summary>The endpoints in table order.</summary>
        internal ElasticsearchEndpoint[] Endpoints { get; }

        /// <summary>The kind of a method no endpoint matched: <c>GET</c> and <c>HEAD</c> read.</summary>
        internal Dictionary<string, string> MethodDefault { get; }

        /// <summary>The first words that make an SQL endpoint request a read.</summary>
        internal HashSet<string> SqlReadWords { get; }
    }

    /// <summary>The parsed Cosmos DB table.</summary>
    internal sealed class CosmosTable
    {
        internal CosmosTable(JsonElement root)
        {
            var read = Strings(root.GetProperty("read"));
            Read = new HashSet<string>(read, StringComparer.Ordinal);
            // Operation types compare case-insensitively (Node spells them in lower case) and are reported canonically.
            Canonical = read.Concat(Strings(root.GetProperty("write"))).ToDictionary(name => name.ToLowerInvariant(), name => name, StringComparer.Ordinal);
        }

        /// <summary>Operation types that only read.</summary>
        internal HashSet<string> Read { get; }

        /// <summary>Lower-case operation type to its canonical spelling.</summary>
        internal Dictionary<string, string> Canonical { get; }
    }

    /// <summary>One gRPC service of the Firestore table.</summary>
    /// <param name="Read">Methods that only read.</param>
    /// <param name="Session">Methods that change no data (<c>BeginTransaction</c>, <c>Rollback</c>).</param>
    /// <param name="ReadPrefixes">For the admin service: a method starting with one of these reads.</param>
    internal sealed record FirestoreService(HashSet<string> Read, HashSet<string> Session, string[] ReadPrefixes);

    /// <summary>The parsed Firestore table.</summary>
    internal sealed class FirestoreTable
    {
        internal FirestoreTable(JsonElement root)
        {
            Services = root.GetProperty("services").EnumerateObject().ToDictionary(service => service.Name, service => new FirestoreService(
                service.Value.TryGetProperty("read", out var read) ? new HashSet<string>(Strings(read), StringComparer.Ordinal) : [],
                service.Value.TryGetProperty("session", out var session) ? new HashSet<string>(Strings(session), StringComparer.Ordinal) : [],
                service.Value.TryGetProperty("readPrefixes", out var prefixes) ? Strings(prefixes) : []), StringComparer.Ordinal);
            var verbs = root.GetProperty("fromRest").GetProperty("verbs");
            RestVerbs = verbs.EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetString()!, StringComparer.Ordinal);
        }

        /// <summary>The services by full name, such as <c>google.firestore.v1.Firestore</c>.</summary>
        internal Dictionary<string, FirestoreService> Services { get; }

        /// <summary>REST verb (<c>:commit</c>) to RPC method name.</summary>
        internal Dictionary<string, string> RestVerbs { get; }
    }

    /// <summary>The parsed Redis table.</summary>
    internal sealed class RedisTable
    {
        internal RedisTable(JsonElement root)
        {
            Read = new HashSet<string>(Strings(root.GetProperty("read")).Concat(Strings(root.GetProperty("moduleRead"))), StringComparer.Ordinal);
            Session = new HashSet<string>(Strings(root.GetProperty("session")), StringComparer.Ordinal);
            Transaction = new HashSet<string>(Strings(root.GetProperty("transaction")), StringComparer.Ordinal);
            FirstKey = root.GetProperty("firstKey").EnumerateObject().ToDictionary(item => item.Name, item => item.Value.GetInt32(), StringComparer.Ordinal);
        }

        /// <summary>
        /// The position of a command's first key argument, counted from 1 over the arguments after the command name (a
        /// container command's subcommand is one of them). Unlisted commands have it at 1; 0 means no positional key.
        /// </summary>
        internal int FirstKeyPosition(string name, string? sub) =>
            sub is not null && FirstKey.TryGetValue($"{name}|{sub.ToUpperInvariant()}", out var position) ? position : FirstKey.GetValueOrDefault(name, 1);

        private Dictionary<string, int> FirstKey { get; }

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

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Sendproof.AspNetCore;

/// <summary>
/// Write classification for Cassandra, driven by the shared table spec/data-stores/cassandra.json. A statement is a
/// read only when its text holds exactly one statement whose key the table lists; everything else, including text the
/// scanner can't read, is a write.
/// </summary>
internal static class CassandraClassifier
{
    /// <summary>
    /// Classifies one CQL statement. <paramref name="treatAsRead"/> holds host-declared read keys such as
    /// <c>"LIST CUSTOM"</c>, compared exactly against the upper-case key.
    /// </summary>
    internal static Classification Classify(string? statement, IReadOnlySet<string>? treatAsRead = null)
    {
        var shape = StatementShape.Of(statement, StatementShape.Cql);
        var key = shape.First == "LIST" ? $"LIST {shape.Second}" : shape.First;
        var operation = shape.First switch
        {
            "BEGIN" => "BATCH",
            "LIST" => key,
            "" => "UNKNOWN",
            _ => shape.First
        };
        var read = !shape.Broken && !shape.Multiple && (StoreTables.Cassandra.Read.Contains(key) || treatAsRead?.Contains(key) == true);
        return new Classification(read ? CommandKind.Read : CommandKind.Write, operation);
    }

    /// <summary>
    /// Classifies a native-protocol message by name: <c>PREPARE</c> and the connection messages are session,
    /// <c>QUERY</c> takes the classification of its statement, <c>EXECUTE</c> that of the text the hook saw prepared (an id it
    /// never saw prepared is a write), and every <c>BATCH</c> is a write.
    /// </summary>
    internal static Classification ClassifyMessage(string message, string? statement = null, string? prepared = null)
    {
        if (StoreTables.Cassandra.Session.Contains(message))
        {
            return new Classification(CommandKind.Session, message);
        }

        return message switch
        {
            "QUERY" => Classify(statement),
            "EXECUTE" => prepared is null ? new Classification(CommandKind.Write, "EXECUTE") : Classify(prepared),
            _ => new Classification(CommandKind.Write, message)
        };
    }

    private static readonly Regex TableName = new(
        @"\b(?:FROM|INTO|UPDATE|TRUNCATE|TABLE)\s+(?:""?\w+""?\.)?""?(\w+)""?", RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>The table a statement names, without its keyspace, for <c>db.collection.name</c>.</summary>
    internal static string? Target(string? statement) => statement is null ? null : TableName.Match(statement) is { Success: true } match ? match.Groups[1].Value : null;
}

/// <summary>
/// Write classification for Elasticsearch and OpenSearch, driven by spec/data-stores/elasticsearch.json: the HTTP method
/// and path, plus the body for the SQL endpoints. <c>GET</c> and <c>HEAD</c> read on every path; everything the table
/// doesn't list is a write.
/// </summary>
internal static class ElasticsearchClassifier
{
    /// <summary>Splits a request path into percent-decoded segments, without the query string or repeated and trailing slashes.</summary>
    internal static string[] Segments(string path)
    {
        var end = path.IndexOfAny(['?', '#']);
        var bare = end < 0 ? path : path[..end];
        return [.. bare.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(segment =>
        {
            try { return Uri.UnescapeDataString(segment); } catch (UriFormatException) { return segment; }
        })];
    }

    private static bool SegmentMatches(string pattern, string segment) => pattern switch
    {
        "{index}" => segment.Length > 0 && segment[0] != '_',
        "{id}" => segment.Length > 0,
        _ => pattern == segment
    };

    /// <summary>
    /// Classifies a request. <paramref name="body"/> is the request body as text, read only for the SQL endpoints. A
    /// <c>session</c> endpoint (point-in-time, scroll, async-search and SQL-cursor handles) is allowed and never logged.
    /// </summary>
    internal static Classification Classify(string method, string path, string? body, IReadOnlySet<string>? treatAsRead = null) =>
        Classify(method, path, () => body, treatAsRead);

    /// <summary>
    /// Classifies a request, reading the body (through <paramref name="body"/>) only when the endpoint is an SQL one, so a
    /// hook never buffers a large bulk body just to classify it.
    /// </summary>
    internal static Classification Classify(string method, string path, Func<string?> body, IReadOnlySet<string>? treatAsRead = null)
    {
        var verb = method.ToUpperInvariant();
        var segments = Segments(path);
        foreach (var entry in StoreTables.Elasticsearch.Endpoints)
        {
            if (!entry.Methods.Contains(verb) || !entry.Paths.Any(pattern => pattern.Length == segments.Length && pattern.Zip(segments).All(pair => SegmentMatches(pair.First, pair.Second))))
            {
                continue;
            }

            var kind = entry.Kind switch
            {
                "sql" => SqlReads(body()) ? CommandKind.Read : CommandKind.Write,
                "read" => CommandKind.Read,
                "session" => CommandKind.Session,
                _ => treatAsRead?.Contains(entry.Name) == true ? CommandKind.Read : CommandKind.Write
            };
            return new Classification(kind, entry.Name);
        }

        var operation = $"{verb} /{string.Join('/', segments.Select(segment => segment.StartsWith('_') ? segment : "{}"))}";
        var fallback = StoreTables.Elasticsearch.MethodDefault.ContainsKey(verb) || treatAsRead?.Contains(operation) == true ? CommandKind.Read : CommandKind.Write;
        return new Classification(fallback, operation);
    }

    /// <summary>
    /// Whether an SQL endpoint request is one read statement or only the next page of a cursor. A query passed only in the
    /// URL, text that is not a JSON object, or a statement the scanner can't read is not a read.
    /// </summary>
    private static bool SqlReads(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            if (document.RootElement.TryGetProperty("query", out var query))
            {
                if (query.ValueKind != JsonValueKind.String)
                {
                    return false;
                }

                var shape = StatementShape.Of(query.GetString(), StatementShape.Sql);
                return !shape.Broken && !shape.Multiple && StoreTables.Elasticsearch.SqlReadWords.Contains(shape.First);
            }

            return document.RootElement.TryGetProperty("cursor", out var cursor) && cursor.ValueKind == JsonValueKind.String;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>The index a request names (its first segment, unless that is an endpoint), for <c>db.collection.name</c>.</summary>
    internal static string? Target(string path) => Segments(path) is [{ } first, ..] && !first.StartsWith('_') ? first : null;

    /// <summary>
    /// The request body as a <c>Db</c> entry's statement: every literal replaced by <c>"?"</c>, field names and structure
    /// kept, one line per NDJSON line. Text that is not JSON becomes a bare <c>?</c>.
    /// </summary>
    internal static string? Statement(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        var lines = new List<string>();
        foreach (var line in body.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                lines.Add(Redact(JsonNode.Parse(line)) is { } node ? node.ToJsonString() : "\"?\"");
            }
            catch (JsonException)
            {
                lines.Add("\"?\"");
            }
        }

        return string.Join('\n', lines);
    }

    private static JsonNode? Redact(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj.Select(property => KeyValuePair.Create(property.Key, Redact(property.Value)))),
        JsonArray array => new JsonArray([.. array.Select(Redact)]),
        _ => JsonValue.Create("?")
    };
}

/// <summary>
/// Write classification for Azure Cosmos DB for NoSQL, driven by spec/data-stores/cosmosdb.json: the operation type, or
/// the HTTP request it is derived from. A request that names a trigger is a write whatever its operation.
/// </summary>
internal static class CosmosClassifier
{
    /// <summary>The headers that name a pre-trigger or post-trigger.</summary>
    internal static readonly string[] TriggerHeaders = ["x-ms-documentdb-pre-trigger-include", "x-ms-documentdb-post-trigger-include"];

    private static bool True(string? value) => string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Derives the operation type from the HTTP method, the resource path and the request headers, as
    /// <c>fromRequest</c> in the table lists. <paramref name="header"/> returns a header value or <see langword="null"/>.
    /// </summary>
    internal static string OperationFromRequest(string method, string path, Func<string, string?> header)
    {
        var segments = ElasticsearchClassifier.Segments(path);
        var one = segments.Length > 0 && segments.Length % 2 == 0;
        switch (method.ToUpperInvariant())
        {
            case "GET":
                return one ? "Read" : "ReadFeed";
            case "HEAD":
                return one ? "Head" : "HeadFeed";
            case "POST":
                if (True(header("x-ms-cosmos-is-query-plan-request"))) return "QueryPlan";
                if (True(header("x-ms-documentdb-isquery")) || (header("content-type") ?? "").StartsWith("application/query+json", StringComparison.OrdinalIgnoreCase)) return "Query";
                if (True(header("x-ms-cosmos-is-batch-request"))) return "Batch";
                if (one && segments[^2] == "sprocs") return "ExecuteJavaScript";
                if (True(header("x-ms-documentdb-is-upsert"))) return "Upsert";
                return "Create";
            case "PUT":
                return "Replace";
            case "PATCH":
                return "Patch";
            case "DELETE":
                return "Delete";
            default:
                return method.ToUpperInvariant();
        }
    }

    /// <summary>
    /// Classifies an operation type (any case) or, when <paramref name="operationType"/> is <see langword="null"/>, the
    /// operation derived from the request. <paramref name="triggered"/> says the request names a trigger.
    /// </summary>
    internal static Classification Classify(string operationType, bool triggered)
    {
        var operation = StoreTables.Cosmos.Canonical.GetValueOrDefault(operationType.ToLowerInvariant(), operationType);
        return new Classification(!triggered && StoreTables.Cosmos.Read.Contains(operation) ? CommandKind.Read : CommandKind.Write, operation);
    }

    /// <summary>Classifies an HTTP request: derives its operation type, then applies the trigger rule.</summary>
    internal static Classification Classify(string method, string path, Func<string, string?> header)
    {
        var triggered = TriggerHeaders.Any(name => header(name) is not null);
        return Classify(OperationFromRequest(method, path, header), triggered);
    }

    /// <summary>The container id (the segment after <c>colls</c>), for <c>db.collection.name</c>.</summary>
    internal static string? Container(string path) => After(path, "colls");

    /// <summary>The database id (the segment after <c>dbs</c>), for <c>db.namespace</c>.</summary>
    internal static string? Database(string path) => After(path, "dbs");

    private static string? After(string path, string name)
    {
        var segments = ElasticsearchClassifier.Segments(path);
        var index = Array.IndexOf(segments, name);
        return index >= 0 && index + 1 < segments.Length ? segments[index + 1] : null;
    }
}

/// <summary>
/// Write classification for Google Cloud Firestore, driven by spec/data-stores/firestore.json: the gRPC method, or the REST
/// request it is derived from. A method of any other service or API version is a write.
/// </summary>
internal static class FirestoreClassifier
{
    private const string V1 = "google.firestore.v1.Firestore";

    /// <summary>
    /// Classifies a gRPC method: the full path (<c>/google.firestore.v1.Firestore/Commit</c>) or a bare v1 name.
    /// <paramref name="writeCount"/> is the number of writes in a <c>Commit</c> request, or <see langword="null"/> when the
    /// hook can't read the message, which makes every <c>Commit</c> a write.
    /// </summary>
    internal static Classification Classify(string rpc, int? writeCount)
    {
        var parts = rpc.Contains('/') ? rpc.Split('/', StringSplitOptions.RemoveEmptyEntries) : [V1, rpc];
        var service = parts.Length > 0 ? parts[0] : "";
        var operation = parts.Length > 1 ? parts[1] : "";
        if (!StoreTables.Firestore.Services.TryGetValue(service, out var known))
        {
            return new Classification(CommandKind.Write, operation);
        }

        if (known.ReadPrefixes.Length > 0)
        {
            return new Classification(known.ReadPrefixes.Any(prefix => operation.StartsWith(prefix, StringComparison.Ordinal)) ? CommandKind.Read : CommandKind.Write, operation);
        }

        if (operation == "Commit")
        {
            return new Classification(writeCount == 0 ? CommandKind.Session : CommandKind.Write, operation);
        }

        if (known.Read.Contains(operation)) return new Classification(CommandKind.Read, operation);
        if (known.Session.Contains(operation)) return new Classification(CommandKind.Session, operation);
        return new Classification(CommandKind.Write, operation);
    }

    /// <summary>Derives the RPC method name from a REST request, as <c>fromRest</c> in the table lists.</summary>
    internal static string RpcFromRest(string method, string path)
    {
        var segments = ElasticsearchClassifier.Segments(path);
        var last = segments.Length > 0 ? segments[^1] : "";
        var colon = last.LastIndexOf(':');
        if (colon >= 0)
        {
            var verb = last[(colon + 1)..];
            return StoreTables.Firestore.RestVerbs.GetValueOrDefault(verb, verb);
        }

        var documents = Array.IndexOf(segments, "documents");
        var after = documents < 0 ? 0 : segments.Length - (documents + 1);
        var document = after > 0 && after % 2 == 0;
        return method.ToUpperInvariant() switch
        {
            "GET" => document ? "GetDocument" : "ListDocuments",
            "PATCH" => "UpdateDocument",
            "DELETE" => "DeleteDocument",
            "POST" => document ? "POST" : "CreateDocument",
            var other => other
        };
    }
}

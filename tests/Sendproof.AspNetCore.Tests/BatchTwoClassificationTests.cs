using System.Text.Json.Nodes;
using Xunit;

namespace Sendproof.AspNetCore.Tests;

/// <summary>
/// The batch-two classification of docs/plans/data-stores.md: the four embedded tables equal the spec, and every shared
/// vector in spec/data-stores/classification-cases.json classifies as the spec says, for Cassandra, Elasticsearch and
/// OpenSearch, Cosmos DB and Firestore.
/// </summary>
public sealed class BatchTwoClassificationTests
{
    private static readonly string SpecDirectory = FindSpec();

    private static string FindSpec()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "spec", "data-stores");
            if (Directory.Exists(candidate)) return candidate;
        }

        throw new DirectoryNotFoundException("spec/data-stores was not found above the test output.");
    }

    [Theory]
    [InlineData("cassandra", nameof(EmbeddedStoreTables.Cassandra))]
    [InlineData("elasticsearch", nameof(EmbeddedStoreTables.Elasticsearch))]
    [InlineData("cosmosdb", nameof(EmbeddedStoreTables.Cosmosdb))]
    [InlineData("firestore", nameof(EmbeddedStoreTables.Firestore))]
    public void EmbeddedTablesMatchTheSpec(string store, string field)
    {
        var embedded = (string)typeof(EmbeddedStoreTables).GetField(field,
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)!.GetRawConstantValue()!;
        var spec = File.ReadAllText(Path.Combine(SpecDirectory, store + ".json"));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(embedded), JsonNode.Parse(spec)),
            $"The embedded {store} table differs from spec/data-stores/{store}.json. Run node adapters/dotnet/scripts/embed-store-tables.mjs.");
    }

    private static JsonArray Cases(string store)
    {
        var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(SpecDirectory, "classification-cases.json")))![store]!.AsArray();
        Assert.NotEmpty(cases);
        return cases;
    }

    private static void Expect(JsonNode vector, Classification actual, string label)
    {
        Assert.True(string.Equals(vector["expect"]!.GetValue<string>(), actual.Kind.ToString(), StringComparison.OrdinalIgnoreCase),
            $"{label}: expected {vector["expect"]}, got {actual.Kind}");
        Assert.True(vector["operation"]!.GetValue<string>() == actual.Operation, $"{label}: expected operation {vector["operation"]}, got {actual.Operation}");
    }

    [Fact]
    public void CassandraPassesEverySharedVector()
    {
        foreach (var vector in Cases("cassandra"))
        {
            var statement = vector!["statement"]?.GetValue<string>();
            var actual = vector["message"] is { } message
                ? CassandraClassifier.ClassifyMessage(message.GetValue<string>(), statement, vector["prepared"]?.GetValue<string>())
                : CassandraClassifier.Classify(statement);
            Expect(vector, actual, vector.ToJsonString());
        }
    }

    [Fact]
    public void ElasticsearchPassesEverySharedVector()
    {
        foreach (var vector in Cases("elasticsearch"))
        {
            // An object or array body is what the client would serialize; a string body is sent as written.
            var body = vector!["body"] switch
            {
                null => null,
                JsonValue text when text.TryGetValue<string>(out var raw) => raw,
                JsonArray lines => string.Join('\n', lines.Select(line => line!.ToJsonString())),
                var node => node.ToJsonString()
            };
            var actual = ElasticsearchClassifier.Classify(vector["method"]!.GetValue<string>(), vector["path"]!.GetValue<string>(), body);
            Expect(vector, actual, vector.ToJsonString());
        }
    }

    [Fact]
    public void CosmosPassesEverySharedVector()
    {
        foreach (var vector in Cases("cosmosdb"))
        {
            Classification actual;
            if (vector!["request"] is JsonObject request)
            {
                var headers = request["headers"]!.AsObject().ToDictionary(item => item.Key.ToLowerInvariant(), item => item.Value!.GetValue<string>());
                actual = CosmosClassifier.Classify(request["method"]!.GetValue<string>(), request["path"]!.GetValue<string>(), name => headers.GetValueOrDefault(name));
            }
            else
            {
                actual = CosmosClassifier.Classify(vector["operationType"]!.GetValue<string>(), vector["triggers"]?.GetValue<bool>() == true);
            }

            Expect(vector, actual, vector.ToJsonString());
        }
    }

    [Fact]
    public void FirestorePassesEverySharedVector()
    {
        foreach (var vector in Cases("firestore"))
        {
            Classification actual;
            if (vector!["rest"] is JsonObject rest)
            {
                var rpc = FirestoreClassifier.RpcFromRest(rest["method"]!.GetValue<string>(), rest["path"]!.GetValue<string>());
                actual = FirestoreClassifier.Classify(rpc, WriteCount(rest["body"] as JsonObject));
            }
            else
            {
                actual = FirestoreClassifier.Classify(vector["rpc"]!.GetValue<string>(), vector["message"] is JsonObject message ? WriteCount(message) : null);
            }

            Expect(vector, actual, vector.ToJsonString());
        }
    }

    /// <summary>A hook that can read the message passes its write count; one that can't passes null.</summary>
    private static int? WriteCount(JsonObject? message) => message is null ? null : message["writes"] is JsonArray writes ? writes.Count : 0;

    [Fact]
    public void CqlLiteralsBecomeQuestionMarksButIdentifiersStay()
    {
        Assert.Equal("INSERT INTO tickets (id, status, hits) VALUES (?, ?, ?)", StatementShape.Redact("INSERT INTO tickets (id, status, hits) VALUES (?, 'new', 1)"));
        Assert.Equal("SELECT * FROM \"t1\" WHERE a = ? AND b = ? AND c = ? AND d = ?",
            StatementShape.Redact("SELECT * FROM \"t1\" WHERE a = 'x''y' AND b = $$z;1$$ AND c = -4.5e2 AND d = 0xCAFE"));
        Assert.Equal("SELECT * FROM t WHERE id = ?", StatementShape.Redact("SELECT * FROM t WHERE id = 123e4567-e89b-12d3-a456-426614174000"));
        Assert.Equal("SELECT col1 FROM t2 WHERE x = ?", StatementShape.Redact("SELECT col1 FROM t2 WHERE x = 7"));
    }

    [Fact]
    public void ASearchBodyKeepsItsShapeButNeverAValue()
    {
        Assert.Equal("""{"query":{"ids":{"values":["?"]}},"size":"?"}""", ElasticsearchClassifier.Statement("""{"query":{"ids":{"values":["seeded"]}},"size":1}"""));
        Assert.Equal("{\"index\":{\"_index\":\"?\"}}\n{\"title\":\"?\"}", ElasticsearchClassifier.Statement("{\"index\":{\"_index\":\"a\"}}\n{\"title\":\"secret\"}\n"));
        Assert.Null(ElasticsearchClassifier.Statement(null));
    }

    [Fact]
    public void ElasticsearchTargetsAndTheCosmosNamesComeFromThePath()
    {
        Assert.Equal("articles", ElasticsearchClassifier.Target("/articles/_search?x=1"));
        Assert.Null(ElasticsearchClassifier.Target("/_cat/indices"));
        Assert.Equal("orders", CosmosClassifier.Container("dbs/shop/colls/orders/docs/o-1"));
        Assert.Equal("shop", CosmosClassifier.Database("/dbs/shop/colls/orders"));
        Assert.Equal("tickets", CassandraClassifier.Target("SELECT * FROM ks.tickets WHERE id = ?"));
        Assert.Equal("tickets", CassandraClassifier.Target("INSERT INTO \"ks\".\"tickets\" (id) VALUES (?)"));
    }

    [Fact]
    public void HostDeclaredCassandraReadsMatchTheExactKeyOnly()
    {
        var reads = DataStoreGuard.ReadSet(["FUTUREREAD"], name => name.ToUpperInvariant());
        Assert.Equal(CommandKind.Write, CassandraClassifier.Classify("FUTUREREAD x").Kind);
        Assert.Equal(CommandKind.Read, CassandraClassifier.Classify("futureread x", reads).Kind);
        Assert.Equal(CommandKind.Write, CassandraClassifier.Classify("FUTUREWRITE x", reads).Kind);
        Assert.Equal(CommandKind.Write, CassandraClassifier.Classify("FUTUREREAD x; DELETE FROM t", reads).Kind);
        Assert.Equal(CommandKind.Write, CassandraClassifier.Classify("DELETE FROM t", reads).Kind);
    }
}

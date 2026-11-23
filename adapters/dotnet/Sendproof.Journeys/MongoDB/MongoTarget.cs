using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;

namespace Sendproof.Journeys.MongoDB;

/// <summary>
/// A document class's collection, named by its registration, with fields named by its BSON class map and values
/// written as the MongoDB change capture writes them (relaxed Extended JSON).
/// </summary>
internal sealed class MongoTarget(Type documentType) : IWriteTarget
{
    private static readonly JsonWriterSettings Relaxed = new() { OutputMode = JsonOutputMode.RelaxedExtendedJson };

    public ResolvedTarget? Resolve(JourneyGeneration generation, ICollection<string> problems)
    {
        if (!generation.Options.Collections.TryGetValue(documentType, out var collection))
        {
            problems.Add($"No collection is registered for {documentType.Name}: add journeys.MapCollection<{documentType.Name}>(\"…\").");
            return null;
        }

        var classMap = BsonClassMap.LookupClassMap(documentType);
        return new ResolvedTarget("mongodb", "collection", collection, path =>
            classMap.AllMemberMaps.FirstOrDefault(map => map.MemberName == path.Root.Name) is { } member
                ? new ResolvedField(member.ElementName, (value, _) => Serialize(member.GetSerializer(), value))
                : null);
    }

    private static JsonNode? Serialize(IBsonSerializer serializer, object? value)
    {
        var document = new BsonDocument();
        using (var writer = new BsonDocumentWriter(document))
        {
            writer.WriteStartDocument();
            writer.WriteName("v");
            serializer.Serialize(BsonSerializationContext.CreateRoot(writer), value);
            writer.WriteEndDocument();
        }

        return JsonNode.Parse(document.ToJson(Relaxed))!["v"]?.DeepClone();
    }
}

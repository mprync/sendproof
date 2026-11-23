using MongoDB.Bson.Serialization.Attributes;

namespace Sendproof.Journeys.Tests;

/// <summary>A MongoDB document class whose field names differ from its properties, for the name resolution tests.</summary>
public sealed class ParcelEventDocument
{
    [BsonId] public string Id { get; set; } = "";
    [BsonElement("parcel_id")] public Guid ParcelId { get; set; }
    [BsonElement("kind")] public string Kind { get; set; } = "";
}

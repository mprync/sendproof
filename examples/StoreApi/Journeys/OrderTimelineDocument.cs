using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace StoreApi;

/// <summary>
/// An order's history in the MongoDB <c>order_timelines</c> collection: one document per order, keyed by the order's
/// ID, with every event appended. The first event creates it.
/// </summary>
public sealed class OrderTimelineDocument
{
    /// <summary>The order, stored as its ID's text.</summary>
    [BsonId, BsonRepresentation(BsonType.String)] public Guid Id { get; set; }

    /// <summary>The order number.</summary>
    [BsonElement("number")] public string Number { get; set; } = "";

    /// <summary>When the last event happened.</summary>
    [BsonElement("updatedAt")] public DateTime UpdatedAt { get; set; }
}

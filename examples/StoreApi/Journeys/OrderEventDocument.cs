using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace StoreApi;

/// <summary>
/// One event in the MongoDB <c>order_events</c> collection, as <see cref="DemoStores"/> writes it. The journeys use this
/// class so their expected documents name the fields as the BSON class map does.
/// </summary>
public sealed class OrderEventDocument
{
    /// <summary>The document's ID.</summary>
    [BsonId] public ObjectId Id { get; set; }

    /// <summary>The order, stored as its ID's text.</summary>
    [BsonElement("orderId"), BsonRepresentation(BsonType.String)] public Guid OrderId { get; set; }

    /// <summary>The order number, such as <c>AS-2026-004512</c>.</summary>
    [BsonElement("number")] public string Number { get; set; } = "";

    /// <summary>The event, such as <c>Shipment.Created</c>.</summary>
    [BsonElement("type")] public string Type { get; set; } = "";

    /// <summary>When it happened.</summary>
    [BsonElement("at")] public DateTime At { get; set; }

    /// <summary>The order's status after the event.</summary>
    [BsonElement("status")] public string Status { get; set; } = "";

    /// <summary>One sentence about it.</summary>
    [BsonElement("summary")] public string Summary { get; set; } = "";
}

using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

namespace StoreApi;

/// <summary>What shipping an order writes: the order moves to Shipped, a shipment with a DHL tracking number, the audit, the history and the email.</summary>
public static class ShipOrderWrites
{
    /// <summary>Describes the writes of the ship step.</summary>
    public static void Describe(StepWrites writes, JourneyBuilder<OrderToShipmentInputs> journey, Ref<Guid> orderId)
    {
        var sql = writes.Sql<StoreDbContext>();
        sql.Update(db => db.Orders)
            .Where(o => o.Id, orderId)
            .Set(o => o.Status, Match.Changed(OrderStatus.Paid, OrderStatus.Shipped))
            .Set(o => o.UpdatedAt, Match.Any<DateTimeOffset>());
        sql.Insert(db => db.Shipments)
            .Set(s => s.OrderId, orderId)
            .Set(s => s.Carrier, Carrier.Dhl)
            .Set(s => s.Status, ShipmentStatus.LabelCreated)
            .Set(s => s.TrackingNumber, Match.Pattern(@"^JD\d{13}$"))
            .Set(s => s.ShippedAt, Match.Any<DateTimeOffset>());
        sql.Insert(db => db.AuditEvents)
            .Set(a => a.EntityType, "Order")
            .Set(a => a.Action, "Order.Shipped: DHL", StoreApprovedDifferences.CarrierRenamed)
            .Set(a => a.Actor, "ada.admin@acme.dev");

        var mongo = writes.Mongo();
        mongo.Insert<OrderEventDocument>()
            .Set(e => e.OrderId, orderId)
            .Set(e => e.Type, "Shipment.Created")
            .Set(e => e.Status, "Shipped");
        mongo.Update<OrderTimelineDocument>()
            .Where(t => t.Id, orderId)
            .Set(t => t.UpdatedAt, Match.Any<DateTime>());

        writes.Email()
            .To(journey.Input(i => i.CustomerEmail))
            .Subject(Match.Pattern("on its way"));
    }
}

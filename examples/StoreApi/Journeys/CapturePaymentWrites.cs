using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

namespace StoreApi;

/// <summary>What capturing a bank transfer writes: the payment and its order move on, and both stores record it.</summary>
public static class CapturePaymentWrites
{
    /// <summary>Describes the writes of the capture step.</summary>
    public static void Describe(StepWrites writes, Ref<Guid> orderId, Ref<Guid> paymentId)
    {
        var sql = writes.Sql<StoreDbContext>();
        sql.Update(db => db.Payments)
            .Where(p => p.Id, paymentId)
            .Set(p => p.Status, Match.Changed(PaymentStatus.Authorized, PaymentStatus.Captured));
        sql.Update(db => db.Orders)
            .Where(o => o.Id, orderId)
            .Set(o => o.Status, Match.Changed(OrderStatus.Pending, OrderStatus.Paid))
            .Set(o => o.UpdatedAt, Match.Any<DateTimeOffset>());
        sql.Insert(db => db.AuditEvents)
            .Set(a => a.EntityType, "Payment")
            .Set(a => a.Action, "Payment.Captured");

        var mongo = writes.Mongo();
        mongo.Insert<OrderEventDocument>()
            .Set(e => e.OrderId, orderId)
            .Set(e => e.Type, "Payment.Captured")
            .Set(e => e.Status, "Paid");
        mongo.Update<OrderTimelineDocument>()
            .Where(t => t.Id, orderId)
            .Set(t => t.UpdatedAt, Match.Any<DateTime>());
    }
}

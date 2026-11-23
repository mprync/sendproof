using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

namespace StoreApi;

/// <summary>
/// What placing an order writes: the order and its line, the stock it takes, its reservation and payment, the audit,
/// the order's history in MongoDB and the confirmation email.
/// </summary>
public static class PlaceOrderWrites
{
    /// <summary>Describes the writes of a place-order step for one line, paid by <paramref name="method"/>.</summary>
    public static void Describe(StepWrites writes, Ref<Guid> customerId, Ref<string> sku, Ref<int> quantity, Ref<string> customerEmail,
        Ref<Guid> orderId, PaymentMethodKind method)
    {
        // A bank transfer waits to be captured; a card is captured at once.
        var paid = method != PaymentMethodKind.BankTransfer;
        var sql = writes.Sql<StoreDbContext>();
        sql.Insert(db => db.Orders)
            .Set(o => o.Id, orderId)
            .Set(o => o.CustomerId, customerId)
            .Set(o => o.Status, paid ? OrderStatus.Paid : OrderStatus.Pending)
            .Set(o => o.Currency, Currency.EUR)
            .Set(o => o.PlacedBy, "ada.admin@acme.dev");
        sql.Insert(db => db.OrderLines)
            .Set(l => l.OrderId, orderId)
            .Set(l => l.Sku, sku)
            .Set(l => l.Quantity, quantity);
        sql.Update(db => db.Stock)
            .Set(s => s.UpdatedAt, Match.Any<DateTimeOffset>());
        sql.Insert(db => db.StockMovements)
            .Set(m => m.Reason, StockReason.Sold)
            .Set(m => m.Actor, "ada.admin@acme.dev");
        sql.Insert(db => db.Reservations)
            .Set(r => r.OrderId, orderId)
            .Set(r => r.CustomerId, customerId)
            .Set(r => r.Quantity, quantity)
            .Set(r => r.Status, ReservationStatus.Committed);
        sql.Insert(db => db.Payments)
            .Set(p => p.OrderId, orderId)
            .Set(p => p.Method, method)
            .Set(p => p.Status, paid ? PaymentStatus.Captured : PaymentStatus.Authorized)
            .Set(p => p.Currency, Currency.EUR);
        sql.Insert(db => db.AuditEvents)
            .Set(a => a.EntityType, "Order")
            .Set(a => a.Action, "Order.Placed");

        var mongo = writes.Mongo();
        mongo.Insert<OrderEventDocument>()
            .Set(e => e.OrderId, orderId)
            .Set(e => e.Type, "Order.Placed");
        mongo.Insert<OrderEventDocument>()
            .Set(e => e.OrderId, orderId)
            .Set(e => e.Type, paid ? "Payment.Captured" : "Payment.Authorized");
        mongo.Insert<OrderTimelineDocument>()
            .Set(t => t.Id, orderId);

        writes.Email()
            .To(customerEmail)
            .Subject(Match.Pattern("^Your Acme Store order"));
    }
}

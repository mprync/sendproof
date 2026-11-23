using Sendproof.Journeys;
using Sendproof.Journeys.EntityFrameworkCore;
using Sendproof.Journeys.MongoDB;

namespace StoreApi;

/// <summary>
/// An order paid by card and cancelled before it ships: the stock goes back on the shelf, the payment is refunded in
/// full, and the order reads back as cancelled.
/// </summary>
public sealed class CancelBeforeShippingJourney : Journey<OrderToShipmentInputs>
{
    /// <inheritdoc />
    protected override void Define(JourneyBuilder<OrderToShipmentInputs> journey)
    {
        journey.Name("Cancel before shipping");
        journey.Group("Checkout and fulfilment");
        journey.RunAs("ada.admin@acme.dev");

        Ref<Guid> customerId = journey.Input(i => i.CustomerId);
        Ref<string> sku = journey.Input(i => i.Sku);
        Ref<int> quantity = journey.Input(i => i.Quantity);
        Ref<string> customerEmail = journey.Input(i => i.CustomerEmail);

        // 1. Place an order paid by card, so it is Paid straight away.
        var placeOrder = journey.Step("placeOrder", StoreOperations.Orders.Place);
        OrderRequests.Place(placeOrder, customerId, sku, quantity, journey.Input(i => i.ShippingSpeed), OrderRequests.Card);
        Ref<Guid> orderId = placeOrder.Output(order => order.Id, "orderId");
        placeOrder.ExpectWrites(writes => PlaceOrderWrites.Describe(writes, customerId, sku, quantity, customerEmail, orderId, PaymentMethodKind.Card));

        // 2. Cancel it with a reason.
        var cancelOrder = journey.Step("cancelOrder", StoreOperations.Orders.Cancel);
        cancelOrder.Set(r => r.Id, orderId);
        cancelOrder.Set(r => r.Body!.Reason, "Ordered the wrong size");
        cancelOrder.SucceedsWith(200);
        cancelOrder.ExpectResponse(order => order.Status, OrderStatus.Cancelled);
        cancelOrder.ExpectWrites(writes =>
        {
            var sql = writes.Sql<StoreDbContext>();
            sql.Update(db => db.Orders)
                .Where(o => o.Id, orderId)
                .Set(o => o.Status, Match.Changed(OrderStatus.Paid, OrderStatus.Cancelled))
                .Set(o => o.CancelReason, "Ordered the wrong size");
            sql.Update(db => db.Stock)
                .Set(s => s.UpdatedAt, Match.Any<DateTimeOffset>());
            sql.Insert(db => db.StockMovements)
                .Set(m => m.Reason, StockReason.Returned)
                .Set(m => m.Delta, quantity);
            sql.Update(db => db.Reservations)
                .Set(r => r.Status, Match.Changed(ReservationStatus.Committed, ReservationStatus.Released));
            sql.Update(db => db.Payments)
                .Set(p => p.Status, Match.Changed(PaymentStatus.Captured, PaymentStatus.Refunded));
            sql.Insert(db => db.Refunds)
                .Set(r => r.Reason, RefundReason.CustomerRequest)
                .Set(r => r.Note, "Order cancelled");
            sql.Insert(db => db.AuditEvents)
                .Set(a => a.EntityType, "Order")
                .Set(a => a.Action, "Order.Cancelled: Ordered the wrong size");

            var mongo = writes.Mongo();
            mongo.Insert<OrderEventDocument>()
                .Set(e => e.OrderId, orderId)
                .Set(e => e.Type, "Order.Cancelled");
            mongo.Update<OrderTimelineDocument>()
                .Where(t => t.Id, orderId);

            writes.Email()
                .To(customerEmail)
                .Subject(Match.Pattern("was cancelled$"));
        });

        // 3. Find the payment: it was refunded.
        var findPayment = journey.Step("findPayment", StoreOperations.Payments.List);
        findPayment.Set(r => r.OrderId, orderId);
        findPayment.SucceedsWith(200);
        findPayment.ExpectResponse(page => page.Items[0].Status, PaymentStatus.Refunded);
        findPayment.ExpectWrites(writes => writes.Nothing());

        // 4. Read the order back.
        var checkOrder = journey.Step("checkOrder", StoreOperations.Orders.Get);
        checkOrder.Set(r => r.Id, orderId);
        checkOrder.SucceedsWith(200);
        checkOrder.ExpectResponse(order => order.Status, OrderStatus.Cancelled);
        checkOrder.ExpectWrites(writes => writes.Nothing());
    }
}
